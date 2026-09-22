/**
 * One lifecycle predicate for the whole app.
 *
 * Before this module the same question was answered three different ways:
 * `MarketCard` tested `resolved`, `/admin` computed a local `past` boolean, and
 * the home page filtered on `allResolved`. The consequence was that an expired
 * but unresolved market sorted as "Open" and still rendered live quick-buy
 * buttons, because no surface had a name for that state.
 *
 * WHAT THIS DOES NOT DECIDE: redemption. Redeeming is gated on the chain's
 * `resolved` alone, deliberately, so a DELETED market's shares stay redeemable.
 * The factory has no delete, shares may be outstanding, and a holder must always
 * be able to get their money out. Never route a Redeem button, or a redeemable
 * TOTAL, through `isTradingOpen` -- money a wallet can withdraw must not be
 * hidden by a curation filter.
 *
 * RELATIONSHIP TO `resolveEligibility.ts`. That module answers "may this wallet
 * resolve this market?" (authorization); this one answers "what state is this
 * market in?" (display and trading). They overlap on exactly one thing, the
 * expiry comparison, and `contracts/test/MarketStatus.test.ts` cross-checks that
 * they agree rather than leaving it to coincidence. If they drifted apart the
 * admin panel and the trade panel would disagree about whether a market expired.
 *
 * HONEST LIMIT: `isTradingOpen` is application policy, not enforcement. The
 * deployed `FixedProductMarketMaker` has no expiry gate -- `resolutionTime`
 * exists only on `MarketFactory`, and the pool's `pause()` is `onlyFactory` with
 * no factory function that calls it, so it is unreachable. A direct `buy()` still
 * succeeds regardless of what this returns. The UI says so; do not add copy that
 * implies otherwise.
 *
 * Zero imports: `contracts/test/` compiles this under a CommonJS tsconfig.
 */

export type MarketStatus = 'open' | 'expired' | 'resolved' | 'deleted';

export interface MarketStatusInput {
  /** `markets(questionId).resolutionTime`, unix seconds. */
  resolutionTime: bigint;
  /**
   * `markets(questionId).resolved` -- read from the CHAIN, never from the
   * indexer. Postgres `markets.resolved` can lag a day behind the daily cron;
   * this must not.
   */
  resolved: boolean;
  /** The admin-authored flag, shared across every visitor. */
  deleted: boolean;
  nowSec: bigint;
}

export function marketStatus(input: MarketStatusInput): MarketStatus {
  // Precedence is deliberate: deleted > resolved > expired > open.
  // Deleted first because it is the only state a human chose explicitly.
  // Resolved above expired because the chain settling a market is a stronger
  // fact than a clock passing a timestamp -- a market resolved early still
  // reads as resolved, not open.
  if (input.deleted) return 'deleted';
  if (input.resolved) return 'resolved';
  // `>=`, so the boundary second is already closed. This matches
  // `resolveEligibility.ts`, which matches the contract's
  // `block.timestamp < resolutionTime` revert (MarketFactory.sol:111).
  //
  // `useMarket` falls back to BigInt(0) on a failed read, which lands here as
  // 'expired' -- failing CLOSED, so a broken read disables trading instead of
  // quietly enabling it. Callers still guard on `isLoading`/`exists` first, so
  // this is a backstop rather than a routine path.
  if (input.nowSec >= input.resolutionTime) return 'expired';
  return 'open';
}

export function isTradingOpen(status: MarketStatus): boolean {
  return status === 'open';
}

/**
 * Collapse a multi-outcome event's members into one status for cards and filters.
 *
 * Deleted members are IGNORED rather than counted, because removing one outcome
 * of a live event must not restyle the whole event. An event whose every member
 * is deleted is itself deleted, and so is an empty one -- there is nothing left
 * to trade either way.
 */
export function groupStatus(members: readonly MarketStatus[]): MarketStatus {
  const live = members.filter((s) => s !== 'deleted');
  if (live.length === 0) return 'deleted';
  if (live.some((s) => s === 'open')) return 'open';
  if (live.every((s) => s === 'resolved')) return 'resolved';
  return 'expired';
}
