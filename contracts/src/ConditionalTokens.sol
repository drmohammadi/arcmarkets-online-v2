// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ConditionalTokens
/// @notice ERC-1155 outcome shares for binary (YES/NO) prediction markets.
/// Modeled on the Gnosis Conditional Tokens Framework, slimmed to binary + admin resolution.
/// @dev conditionId = keccak256(abi.encode(oracle, questionId, OUTCOME_COUNT)).
/// positionId(outcome) = uint256(keccak256(abi.encode(collateralToken, conditionId, outcome))).
contract ConditionalTokens is ERC1155, ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    uint8 public constant OUTCOME_COUNT = 2; // Binary: YES=0, NO=1

    struct Condition {
        address oracle;
        uint256 questionId;
        uint256 outcomeSlotCount;
        uint256[2] payoutNumerators; // [0,0] until resolved
        uint256 payoutDenominator; // 0 until resolved
    }

    mapping(bytes32 => Condition) public conditions;

    error ConditionAlreadyPrepared();
    error ConditionNotPrepared();
    error ConditionNotResolved();
    error ConditionAlreadyResolved();
    error Unauthorized();
    error InvalidPayouts();
    error ZeroAmount();
    error NoWinningShares();

    event ConditionPrepared(bytes32 indexed conditionId, address indexed oracle, uint256 indexed questionId);
    event ConditionResolved(bytes32 indexed conditionId, uint256[2] payoutNumerators, uint256 payoutDenominator);
    event PositionSplit(address indexed user, IERC20 indexed collateral, bytes32 indexed conditionId, uint256 amount);
    event PositionMerged(address indexed user, IERC20 indexed collateral, bytes32 indexed conditionId, uint256 amount);
    event PositionRedeemed(
        address indexed user,
        IERC20 indexed collateral,
        bytes32 indexed conditionId,
        uint256[2] shares,
        uint256 payout
    );

    constructor() ERC1155("") Ownable(msg.sender) {}

    // ───────────────────────────── Condition lifecycle ─────────────────────────────

    /// @notice Prepare a new condition (owner/factory only, pre-resolution).
    function prepareCondition(address oracle, uint256 questionId) external onlyOwner {
        bytes32 conditionId = getConditionId(oracle, questionId);
        if (conditions[conditionId].oracle != address(0)) revert ConditionAlreadyPrepared();
        conditions[conditionId] = Condition({
            oracle: oracle,
            questionId: questionId,
            outcomeSlotCount: OUTCOME_COUNT,
            payoutNumerators: [uint256(0), uint256(0)],
            payoutDenominator: 0
        });
        emit ConditionPrepared(conditionId, oracle, questionId);
    }

    /// @notice Report the winning outcome (oracle-gated, one-shot).
    /// @param payouts [yesNumerator, noNumerator]. YES wins → [1,0]; NO wins → [0,1]; refund → [1,1].
    function reportPayouts(uint256 questionId, uint256[2] calldata payouts) external whenNotPaused {
        bytes32 conditionId = getConditionId(msg.sender, questionId);
        Condition storage cond = conditions[conditionId];
        if (cond.oracle == address(0)) revert ConditionNotPrepared();
        if (cond.oracle != msg.sender) revert Unauthorized();
        if (cond.payoutDenominator != 0) revert ConditionAlreadyResolved();

        uint256 sum = payouts[0] + payouts[1];
        if (sum == 0) revert InvalidPayouts();

        cond.payoutNumerators = payouts;
        cond.payoutDenominator = sum;

        emit ConditionResolved(conditionId, payouts, sum);
    }

    // ─────────────────────────── Split / Merge / Redeem ───────────────────────────

    /// @notice Lock `amount` of collateral → mint one full set (YES + NO shares).
    function splitPosition(IERC20 collateral, bytes32 conditionId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (conditions[conditionId].oracle == address(0)) revert ConditionNotPrepared();

        collateral.safeTransferFrom(msg.sender, address(this), amount);

        _mint(msg.sender, getPositionId(collateral, conditionId, 0), amount, "");
        _mint(msg.sender, getPositionId(collateral, conditionId, 1), amount, "");

        emit PositionSplit(msg.sender, collateral, conditionId, amount);
    }

    /// @notice Burn one full set → unlock `amount` of collateral.
    function mergePositions(IERC20 collateral, bytes32 conditionId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();

        _burn(msg.sender, getPositionId(collateral, conditionId, 0), amount);
        _burn(msg.sender, getPositionId(collateral, conditionId, 1), amount);

        collateral.safeTransfer(msg.sender, amount);

        emit PositionMerged(msg.sender, collateral, conditionId, amount);
    }

    /// @notice Redeem winning shares after resolution.
    function redeemPositions(IERC20 collateral, bytes32 conditionId) external nonReentrant whenNotPaused {
        Condition storage cond = conditions[conditionId];
        if (cond.oracle == address(0)) revert ConditionNotPrepared();
        if (cond.payoutDenominator == 0) revert ConditionNotResolved();

        uint256 yesId = getPositionId(collateral, conditionId, 0);
        uint256 noId = getPositionId(collateral, conditionId, 1);
        uint256 yesShares = balanceOf(msg.sender, yesId);
        uint256 noShares = balanceOf(msg.sender, noId);

        uint256 payout = (yesShares * cond.payoutNumerators[0] + noShares * cond.payoutNumerators[1]) /
            cond.payoutDenominator;

        if (payout == 0) revert NoWinningShares();

        if (yesShares > 0) _burn(msg.sender, yesId, yesShares);
        if (noShares > 0) _burn(msg.sender, noId, noShares);

        collateral.safeTransfer(msg.sender, payout);

        emit PositionRedeemed(msg.sender, collateral, conditionId, [yesShares, noShares], payout);
    }

    // ────────────────────────────── View helpers ──────────────────────────────

    function getConditionId(address oracle, uint256 questionId) public pure returns (bytes32) {
        return keccak256(abi.encode(oracle, questionId, OUTCOME_COUNT));
    }

    function getPositionId(IERC20 collateral, bytes32 conditionId, uint256 outcome) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(collateral, conditionId, outcome)));
    }

    /// @notice Convenience accessor for the frontend: resolution status + numerators.
    function getPayouts(bytes32 conditionId) external view returns (bool resolved, uint256[2] memory numerators, uint256 denominator) {
        Condition storage cond = conditions[conditionId];
        return (cond.payoutDenominator != 0, cond.payoutNumerators, cond.payoutDenominator);
    }

    // ──────────────────────────── Pause (emergency) ────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
