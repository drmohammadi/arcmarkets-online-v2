/**
 * Contract ABIs as human-readable signatures, parsed by viem's parseAbi into
 * the structured ABI objects wagmi/viem hooks require for full type inference.
 * These match the deployed Solidity contracts exactly.
 */

import { parseAbi } from 'viem';

export const marketFactoryAbi = parseAbi([
  'function createMarket(string question, string category, uint256 resolutionTime, address resolver, uint256 fee) returns (uint256 questionId, address fpmm)',
  'function resolveMarket(uint256 questionId, uint256[2] payouts)',
  'function markets(uint256) view returns (address fpmm, bytes32 conditionId, string question, string category, uint256 resolutionTime, address resolver, bool resolved)',
  'function nextQuestionId() view returns (uint256)',
  'function owner() view returns (address)',
  'function collateralToken() view returns (address)',
  'function conditionalTokens() view returns (address)',
  'function paused() view returns (bool)',
  'event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)',
  'event MarketResolved(uint256 indexed questionId, uint256[2] payouts)',
]);

export const fpmmAbi = parseAbi([
  'function calcBuyAmount(uint256 outcome, uint256 investmentAmount) view returns (uint256)',
  'function calcSellAmount(uint256 outcome, uint256 returnAmount) view returns (uint256)',
  'function buy(uint256 outcome, uint256 investmentAmount, uint256 minSharesOut) returns (uint256 sharesOut)',
  'function sell(uint256 outcome, uint256 returnAmount, uint256 maxSharesIn) returns (uint256 sharesIn)',
  'function addLiquidity(uint256 amount, uint256 minShares) returns (uint256 shares)',
  'function removeLiquidity(uint256 shares, uint256 minCollateral) returns (uint256 collateral)',
  'function reserves() view returns (uint256 yes, uint256 no)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function yesPositionId() view returns (uint256)',
  'function noPositionId() view returns (uint256)',
  'function fee() view returns (uint256)',
  'function conditionId() view returns (bytes32)',
  // Trade/liquidity events.
  //
  // A trade event carries its own execution price in its arguments:
  //   Buy  -> investmentAmount / sharesOut
  //   Sell -> returnAmount / sharesIn
  // Since a winning share redeems for exactly 1 USDC, that ratio IS the implied
  // probability. This is why the price chart needs no reserve reconstruction —
  // see the header of hooks/useTradeHistory.ts. Do NOT reintroduce a replay from
  // the pool's creation block: it was correct but so RPC-hungry that it caused
  // the rate limiting it then reported.
  'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)',
  'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)',
  'event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)',
  'event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)',
]);

export const conditionalTokensAbi = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function redeemPositions(address collateral, bytes32 conditionId)',
  'function getPositionId(address collateral, bytes32 conditionId, uint256 outcome) view returns (uint256)',
  'function getPayouts(bytes32 conditionId) view returns (bool resolved, uint256[2] numerators, uint256 denominator)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function faucet()',
  // MockUSDC (testnet) faucet state. Absent on real USDC, so any read of these
  // must tolerate failure — see FaucetButton.
  'function lastFaucetClaim(address) view returns (uint256)',
  'function FAUCET_AMOUNT() view returns (uint256)',
  'function FAUCET_COOLDOWN() view returns (uint256)',
  'error FaucetCooldownActive(uint256 nextClaimTime)',
]);

/**
 * MarketMetadata: descriptions, image URLs and resolution sources, keyed by the
 * factory's questionId.
 *
 * A separate, additive contract — the live MarketFactory has no such fields and
 * is not upgradeable, so extending it would have meant abandoning every market
 * already deployed. Reads must tolerate the registry being absent on a chain.
 */
export const marketMetadataAbi = parseAbi([
  'struct Metadata { string description; string imageUrl; string resolutionSource; bool set; }',
  'function setMetadata(uint256 questionId, string description, string imageUrl, string resolutionSource)',
  'function setMetadataBatch(uint256[] questionIds, string[] descriptions, string[] imageUrls, string[] resolutionSources)',
  'function clearMetadata(uint256 questionId)',
  'function getMetadata(uint256 questionId) view returns (Metadata)',
  'function getMetadataBatch(uint256[] questionIds) view returns (Metadata[])',
  'function owner() view returns (address)',
  'function MAX_DESCRIPTION_BYTES() view returns (uint256)',
  'function MAX_URL_BYTES() view returns (uint256)',
  'function MAX_SOURCE_BYTES() view returns (uint256)',
  'function MAX_BATCH() view returns (uint256)',
  'event MetadataSet(uint256 indexed questionId, string description, string imageUrl, string resolutionSource)',
  'event MetadataCleared(uint256 indexed questionId)',
]);

/**
 * Social: display names keyed by address, and a comment thread per questionId.
 *
 * Additive and decoupled in the same way as MarketMetadata, but with one
 * important difference — writes are PERMISSIONLESS, not owner-gated. Every
 * string returned by this contract is attacker-controlled and must go through
 * lib/sanitize.ts before it reaches the DOM.
 *
 * Reads must tolerate the contract being absent on a chain: it was deployed
 * after the factory, so an older chain entry has no `social` address.
 */
export const socialAbi = parseAbi([
  'struct Comment { address author; uint64 timestamp; bool deleted; string text; }',
  'function setUsername(string name)',
  'function clearUsername()',
  'function usernameOf(address user) view returns (string)',
  'function usernamesOf(address[] users) view returns (string[])',
  'function isNameAvailable(string name, address who) view returns (bool)',
  'function holderOf(string name) view returns (address)',
  'function postComment(uint256 questionId, string text)',
  'function deleteComment(uint256 questionId, uint256 index)',
  'function commentCount(uint256 questionId) view returns (uint256)',
  'function commentsPaged(uint256 questionId, uint256 offset, uint256 limit) view returns (Comment[])',
  'function lastCommentAt(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function MIN_NAME_BYTES() view returns (uint256)',
  'function MAX_NAME_BYTES() view returns (uint256)',
  'function MAX_COMMENT_BYTES() view returns (uint256)',
  'function COMMENT_COOLDOWN() view returns (uint256)',
  'function MAX_PAGE() view returns (uint256)',
  'event UsernameSet(address indexed user, string name)',
  'event UsernameCleared(address indexed user)',
  'event CommentPosted(uint256 indexed questionId, uint256 indexed index, address indexed author, string text)',
  'event CommentDeleted(uint256 indexed questionId, uint256 indexed index)',
  'error InvalidInput()',
  'error NameTaken()',
  'error NoUsername()',
  'error CooldownActive(uint256 nextPostTime)',
  'error NotAuthorized()',
  'error NoSuchComment()',
  'error PageTooLarge()',
]);
