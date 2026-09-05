// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "./ConditionalTokens.sol";

/// @title FixedProductMarketMaker
/// @notice Constant-product (x*y=k) market maker over YES/NO outcome tokens for one condition.
/// @dev Math follows the Gnosis FixedProductMarketMaker reference:
///  - buy is parameterized by collateral spent (investmentAmount).
///  - sell is parameterized by collateral received (returnAmount).
///  - all rounding uses ceilDiv on the pool-side term so rounding always favors the pool
///    (the invariant k never decreases; fees accrue to LPs as extra outcome tokens).
/// Implied YES probability = reserveNO / (reserveYES + reserveNO).
/// Must hold ERC1155 outcome tokens, hence ERC1155Holder.
contract FixedProductMarketMaker is ReentrancyGuard, Pausable, ERC1155Holder {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_DENOMINATOR = 10000; // bps
    uint256 public constant MAX_FEE = 1000; // 10%

    IERC20 public immutable collateralToken;
    ConditionalTokens public immutable conditionalTokens;
    bytes32 public immutable conditionId;
    address public immutable factory;

    uint256 public immutable yesPositionId;
    uint256 public immutable noPositionId;

    uint256 public immutable fee; // bps, fixed at construction

    uint256 public totalSupply; // LP shares
    mapping(address => uint256) public balanceOf;

    error Unauthorized();
    error InvalidFee();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error ZeroAmount();
    error ZeroShares();
    error InvalidOutcome();
    error ReturnExceedsReserves();

    event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral);
    event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut);
    event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn);

    constructor(
        IERC20 _collateralToken,
        ConditionalTokens _conditionalTokens,
        bytes32 _conditionId,
        uint256 _fee
    ) {
        if (_fee > MAX_FEE) revert InvalidFee();
        collateralToken = _collateralToken;
        conditionalTokens = _conditionalTokens;
        conditionId = _conditionId;
        factory = msg.sender;
        fee = _fee;
        yesPositionId = _conditionalTokens.getPositionId(_collateralToken, _conditionId, 0);
        noPositionId = _conditionalTokens.getPositionId(_collateralToken, _conditionId, 1);
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert Unauthorized();
        _;
    }

    // ─────────────────────────────── Reserves ───────────────────────────────

    function reserves() public view returns (uint256 yes, uint256 no) {
        yes = conditionalTokens.balanceOf(address(this), yesPositionId);
        no = conditionalTokens.balanceOf(address(this), noPositionId);
    }

    function _reservesFor(uint256 outcome) internal view returns (uint256 buyReserve, uint256 otherReserve) {
        (uint256 yes, uint256 no) = reserves();
        if (outcome == 0) return (yes, no);
        return (no, yes);
    }

    // ─────────────────────────────── Liquidity ───────────────────────────────

    /// @notice Add liquidity: lock collateral → split into full sets held by the pool → mint LP shares.
    function addLiquidity(uint256 amount, uint256 minShares)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (amount == 0) revert ZeroAmount();

        (uint256 yesBefore, uint256 noBefore) = reserves();

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        collateralToken.forceApprove(address(conditionalTokens), amount);
        conditionalTokens.splitPosition(collateralToken, conditionId, amount);

        if (totalSupply == 0) {
            shares = amount; // first LP: 1:1
        } else {
            // Mint proportional to the smaller existing reserve (conservative).
            uint256 minReserve = yesBefore < noBefore ? yesBefore : noBefore;
            shares = (amount * totalSupply) / minReserve;
        }

        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert SlippageExceeded();

        totalSupply += shares;
        balanceOf[msg.sender] += shares;

        emit LiquidityAdded(msg.sender, amount, shares);
    }

    /// @notice Remove liquidity: burn LP shares → withdraw proportional full sets → merge → return collateral.
    /// @dev Only the mergeable amount (min of the two withdrawn reserves) becomes collateral; any residual
    /// single-outcome tokens (from an unbalanced pool) are sent to the LP to redeem/trade.
    function removeLiquidity(uint256 shares, uint256 minCollateral)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 collateral)
    {
        if (shares == 0 || shares > balanceOf[msg.sender]) revert InsufficientLiquidity();

        (uint256 yesBal, uint256 noBal) = reserves();
        uint256 yesOut = (shares * yesBal) / totalSupply;
        uint256 noOut = (shares * noBal) / totalSupply;

        totalSupply -= shares;
        balanceOf[msg.sender] -= shares;

        collateral = yesOut < noOut ? yesOut : noOut; // full sets we can merge back to collateral
        if (collateral < minCollateral) revert SlippageExceeded();

        if (collateral > 0) {
            conditionalTokens.mergePositions(collateralToken, conditionId, collateral);
            collateralToken.safeTransfer(msg.sender, collateral);
        }

        // Hand any leftover single-outcome tokens to the LP (they keep upside on the heavier side).
        uint256 yesResidual = yesOut - collateral;
        uint256 noResidual = noOut - collateral;
        if (yesResidual > 0) {
            conditionalTokens.safeTransferFrom(address(this), msg.sender, yesPositionId, yesResidual, "");
        }
        if (noResidual > 0) {
            conditionalTokens.safeTransferFrom(address(this), msg.sender, noPositionId, noResidual, "");
        }

        emit LiquidityRemoved(msg.sender, shares, collateral);
    }

    // ────────────────────────────── Quotes (pure CPMM) ──────────────────────────

    /// @notice Shares received for spending `investmentAmount` collateral on `outcome`.
    function calcBuyAmount(uint256 outcome, uint256 investmentAmount) public view returns (uint256) {
        if (outcome > 1) revert InvalidOutcome();
        if (investmentAmount == 0) return 0;
        (uint256 buyReserve, uint256 otherReserve) = _reservesFor(outcome);
        if (buyReserve == 0 || otherReserve == 0) return 0;

        uint256 investAfterFee = investmentAmount - (investmentAmount * fee) / FEE_DENOMINATOR;
        // ceilDiv on the pool-side term → rounds sharesOut DOWN (favors pool).
        uint256 endingBuyReserve = Math.ceilDiv(buyReserve * otherReserve, otherReserve + investAfterFee);
        return buyReserve + investAfterFee - endingBuyReserve;
    }

    /// @notice Shares that must be sold on `outcome` to receive `returnAmount` collateral.
    function calcSellAmount(uint256 outcome, uint256 returnAmount) public view returns (uint256) {
        if (outcome > 1) revert InvalidOutcome();
        if (returnAmount == 0) return 0;
        (uint256 sellReserve, uint256 otherReserve) = _reservesFor(outcome);
        if (sellReserve == 0 || otherReserve == 0) return 0;

        // Gross up the collateral by the fee; the user gives extra shares that stay in the pool.
        uint256 returnPlusFees = Math.ceilDiv(returnAmount * FEE_DENOMINATOR, FEE_DENOMINATOR - fee);
        if (returnPlusFees >= otherReserve) revert ReturnExceedsReserves();

        // ceilDiv → rounds sharesIn UP (favors pool).
        uint256 endingSellReserve = Math.ceilDiv(sellReserve * otherReserve, otherReserve - returnPlusFees);
        return returnPlusFees + endingSellReserve - sellReserve;
    }

    // ────────────────────────────── Trade (buy/sell) ──────────────────────────

    /// @notice Buy `outcome` shares by spending exactly `investmentAmount` collateral.
    function buy(uint256 outcome, uint256 investmentAmount, uint256 minSharesOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesOut)
    {
        if (outcome > 1) revert InvalidOutcome();
        if (investmentAmount == 0) revert ZeroAmount();

        sharesOut = calcBuyAmount(outcome, investmentAmount);
        if (sharesOut == 0) revert InsufficientLiquidity();
        if (sharesOut < minSharesOut) revert SlippageExceeded();

        uint256 buyPosId = outcome == 0 ? yesPositionId : noPositionId;

        // Pull full investment, split ALL of it into sets (pool gains investmentAmount of each outcome),
        // then hand out sharesOut of the bought outcome. The fee's worth of tokens stays in the pool.
        collateralToken.safeTransferFrom(msg.sender, address(this), investmentAmount);
        collateralToken.forceApprove(address(conditionalTokens), investmentAmount);
        conditionalTokens.splitPosition(collateralToken, conditionId, investmentAmount);
        conditionalTokens.safeTransferFrom(address(this), msg.sender, buyPosId, sharesOut, "");

        emit Buy(msg.sender, outcome, investmentAmount, sharesOut);
    }

    /// @notice Sell `outcome` shares to receive exactly `returnAmount` collateral.
    function sell(uint256 outcome, uint256 returnAmount, uint256 maxSharesIn)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesIn)
    {
        if (outcome > 1) revert InvalidOutcome();
        if (returnAmount == 0) revert ZeroAmount();

        sharesIn = calcSellAmount(outcome, returnAmount);
        if (sharesIn == 0) revert InsufficientLiquidity();
        if (sharesIn > maxSharesIn) revert SlippageExceeded();

        uint256 sellPosId = outcome == 0 ? yesPositionId : noPositionId;

        // Pull the shares into the pool, merge `returnAmount` full sets back to collateral, pay the user.
        conditionalTokens.safeTransferFrom(msg.sender, address(this), sellPosId, sharesIn, "");
        conditionalTokens.mergePositions(collateralToken, conditionId, returnAmount);
        collateralToken.safeTransfer(msg.sender, returnAmount);

        emit Sell(msg.sender, outcome, returnAmount, sharesIn);
    }

    // ──────────────────────────── Pause (factory-gated) ────────────────────────

    function pause() external onlyFactory {
        _pause();
    }

    function unpause() external onlyFactory {
        _unpause();
    }
}
