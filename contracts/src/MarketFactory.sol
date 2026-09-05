// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ConditionalTokens.sol";
import "./FixedProductMarketMaker.sol";

/// @title MarketFactory
/// @notice Deploys FPMM markets, prepares conditions, stores metadata, handles resolution.
/// @dev Deploys each FPMM with `new` (not clones) so the FPMM's constructor + immutables
/// initialize correctly. The factory owns ConditionalTokens and is each condition's oracle.
contract MarketFactory is Ownable, Pausable {
    IERC20 public immutable collateralToken;
    ConditionalTokens public immutable conditionalTokens;

    uint256 public nextQuestionId;

    struct Market {
        address fpmm;
        bytes32 conditionId;
        string question;
        string category;
        uint256 resolutionTime;
        address resolver;
        bool resolved;
    }

    mapping(uint256 => Market) public markets;

    event MarketCreated(
        uint256 indexed questionId,
        address indexed fpmm,
        bytes32 indexed conditionId,
        string question,
        string category,
        uint256 resolutionTime,
        address resolver,
        uint256 fee
    );

    event MarketResolved(uint256 indexed questionId, uint256[2] payouts);

    error MarketNotFound();
    error MarketAlreadyResolved();
    error ResolutionTimeLocked(uint256 unlockTime);
    error Unauthorized();
    error InvalidInput();

    constructor(IERC20 _collateralToken, ConditionalTokens _conditionalTokens) Ownable(msg.sender) {
        if (address(_collateralToken) == address(0) || address(_conditionalTokens) == address(0)) {
            revert InvalidInput();
        }
        collateralToken = _collateralToken;
        conditionalTokens = _conditionalTokens;
    }

    /// @notice Create a new binary market.
    /// @param question Human-readable question (max 256 bytes; UI also sanitizes on render).
    /// @param category Category tag (max 64 bytes).
    /// @param resolutionTime Unix timestamp; market cannot resolve before this.
    /// @param resolver Address allowed to resolve (typically owner/multisig).
    /// @param fee FPMM fee in bps (0-1000; FPMM enforces the 10% cap).
    function createMarket(
        string calldata question,
        string calldata category,
        uint256 resolutionTime,
        address resolver,
        uint256 fee
    ) external onlyOwner whenNotPaused returns (uint256 questionId, address fpmm) {
        if (bytes(question).length == 0 || bytes(question).length > 256) revert InvalidInput();
        if (bytes(category).length > 64) revert InvalidInput();
        if (resolver == address(0)) revert InvalidInput();
        if (resolutionTime <= block.timestamp) revert InvalidInput();

        questionId = nextQuestionId++;

        // Prepare the condition; the factory is the oracle for this questionId.
        conditionalTokens.prepareCondition(address(this), questionId);
        bytes32 conditionId = conditionalTokens.getConditionId(address(this), questionId);

        // Deploy the market maker directly (constructor sets immutables; msg.sender = this factory).
        FixedProductMarketMaker market = new FixedProductMarketMaker(
            collateralToken,
            conditionalTokens,
            conditionId,
            fee
        );
        fpmm = address(market);

        markets[questionId] = Market({
            fpmm: fpmm,
            conditionId: conditionId,
            question: question,
            category: category,
            resolutionTime: resolutionTime,
            resolver: resolver,
            resolved: false
        });

        emit MarketCreated(questionId, fpmm, conditionId, question, category, resolutionTime, resolver, fee);
    }

    /// @notice Resolve a market (resolver-gated, time-gated, one-shot).
    /// @param payouts [yesNumerator, noNumerator]. YES wins → [1,0]; NO wins → [0,1]; refund → [1,1].
    function resolveMarket(uint256 questionId, uint256[2] calldata payouts) external whenNotPaused {
        Market storage market = markets[questionId];
        if (market.fpmm == address(0)) revert MarketNotFound();
        if (market.resolver != msg.sender) revert Unauthorized();
        if (block.timestamp < market.resolutionTime) revert ResolutionTimeLocked(market.resolutionTime);
        if (market.resolved) revert MarketAlreadyResolved();

        market.resolved = true; // effects before external call (CEI)

        // ConditionalTokens derives conditionId from (msg.sender = this factory, questionId).
        conditionalTokens.reportPayouts(questionId, payouts);

        emit MarketResolved(questionId, payouts);
    }

    /// @notice Read a market struct (convenience for the frontend).
    function getMarket(uint256 questionId) external view returns (Market memory) {
        if (markets[questionId].fpmm == address(0)) revert MarketNotFound();
        return markets[questionId];
    }

    // ──────────────────────────── Pause (emergency) ────────────────────────────

    function pause() external onlyOwner {
        _pause();
        conditionalTokens.pause();
    }

    function unpause() external onlyOwner {
        _unpause();
        conditionalTokens.unpause();
    }
}
