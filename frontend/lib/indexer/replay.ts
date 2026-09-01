/**
 * Exact reserve reconstruction for a FixedProductMarketMaker, from its events alone.
 *
 * ZERO IMPORTS, deliberately. This module is imported both by the Next.js app
 * (ESM, `@/` aliases, bundler resolution) and by the Hardhat/mocha test suite in
 * `contracts/` (CommonJS, no aliases) via a relative path. Any import at all —
 * viem, a node builtin, an `@/`-aliased sibling — breaks one of those two
 * consumers. Keep it self-contained.
 *
 * Why event-only replay works: every state transition of the pool is fully
 * determined by the arguments of the event it emits, so no `eth_call`, no `fee`
 * value and no archive node are needed. See contracts/src/FixedProductMarketMaker.sol:
 *
 *  - LiquidityAdded (:103)  splits the WHOLE collateral amount into full sets, so
 *    it adds an EQUAL amount to BOTH reserves. On an unbalanced pool that pulls
 *    the ratio toward 50/50, so adding liquidity DOES move the marginal price
 *    even though no Buy/Sell is emitted. This is not a bug to fix.
 *  - LiquidityRemoved (:134-135) withdraws shares*reserve/totalSupply from EACH
 *    reserve, so both scale by the same factor and the ratio survives: removing
 *    liquidity does NOT move the price, up to one unit of integer truncation.
 *  - Buy (:212-215) splits ALL of investmentAmount into full sets, then transfers
 *    sharesOut of the bought outcome away. The fee's worth of tokens simply stays
 *    in the pool, which is why the fee never appears in this arithmetic — it is
 *    already baked into sharesOut by calcBuyAmount.
 *  - Sell (:237-239) takes sharesIn into the pool, then merges returnAmount full
 *    sets back to collateral, removing returnAmount from BOTH reserves.
 *
 * Each rule reads pre-event state and writes post-event state, so events MUST be
 * applied in (blockNumber, logIndex) order. `replay` sorts before folding rather
 * than trusting its caller.
 *
 * All division is BigInt floor division, matching Solidity's uint truncation.
 */

export type EventKind = 'buy' | 'sell' | 'liquidity_added' | 'liquidity_removed';

/** One decoded FPMM log, normalized across the four event shapes. */
export interface IndexedEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  fpmm: string;
  kind: EventKind;
  actor: string;
  /** 0 = YES, 1 = NO for trades; null for liquidity events, which touch both sides. */
  outcome: 0 | 1 | null;
  /** Collateral in/out: amount, investmentAmount, returnAmount, or collateral. */
  collateral: bigint;
  /** Shares: LP shares minted/burned, or sharesOut/sharesIn of the outcome token. */
  shares: bigint;
}

export interface PoolState {
  reserveYes: bigint;
  reserveNo: bigint;
  totalSupply: bigint;
}

export interface ReplayedEvent extends IndexedEvent {
  /** Post-event pool state. */
  reserveYes: bigint;
  reserveNo: bigint;
  totalSupply: bigint;
  /** Marginal YES probability after the event, in bps. */
  yesBps: number;
  /** Realized (execution) YES price for this trade in bps; null for non-trades. */
  execYesBps: number | null;
  /** False when the event's own numbers contradict the replayed state. */
  checksumOk: boolean;
}

const BPS = BigInt(10000);
const NEUTRAL_BPS = 5000;

/** A pool that has never had liquidity. */
export function zeroState(): PoolState {
  return { reserveYes: BigInt(0), reserveNo: BigInt(0), totalSupply: BigInt(0) };
}

/**
 * Implied probability of YES in bps. Mirrors frontend/lib/pricing.ts:25-29
 * EXACTLY, including NEUTRAL_BPS for an empty pool — if these two diverge, the
 * indexed history and the chart's live point disagree, which is the bug this
 * whole indexer exists to fix.
 */
export function yesProbBps(reserveYes: bigint, reserveNo: bigint): number {
  const total = reserveYes + reserveNo;
  if (total <= BigInt(0)) return NEUTRAL_BPS;
  return Number((reserveNo * BPS) / total);
}

/**
 * Average price actually paid/received on this trade, expressed on the YES side
 * in bps. collateral/shares is already a price because a share redeems for
 * exactly 1 collateral unit, so the ratio must land in 1..10000; anything
 * outside that is a decode error or a degenerate log, and null is the honest
 * answer rather than a clamped lie. A NO-side price p is 10000-p on YES.
 */
export function execYesBps(
  kind: EventKind,
  outcome: 0 | 1 | null,
  collateral: bigint,
  shares: bigint
): number | null {
  if (kind !== 'buy' && kind !== 'sell') return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (shares <= BigInt(0) || collateral <= BigInt(0)) return null;
  const bps = Number((collateral * BPS) / shares);
  if (bps < 1 || bps > 10000) return null;
  return outcome === 0 ? bps : 10000 - bps;
}

/**
 * Fold one event into the pool state. Returns a NEW state; never mutates.
 *
 * checksumOk is the one place the event stream can be caught lying: for
 * LiquidityRemoved the contract emits `collateral = min(yesOut, noOut)` (:140),
 * which we can recompute from the pre-event reserves, so a mismatch means our
 * reserves have drifted (a missed event, a reorg, a wrong start state). It is
 * also false for the two malformed inputs we refuse to guess at: removing
 * liquidity from a zero LP supply, and a trade with no outcome side.
 */
export function applyEvent(
  state: PoolState,
  ev: IndexedEvent
): { state: PoolState; checksumOk: boolean } {
  const { reserveYes, reserveNo, totalSupply } = state;

  if (ev.kind === 'liquidity_added') {
    return {
      state: {
        reserveYes: reserveYes + ev.collateral,
        reserveNo: reserveNo + ev.collateral,
        totalSupply: totalSupply + ev.shares,
      },
      checksumOk: true,
    };
  }

  if (ev.kind === 'liquidity_removed') {
    // Dividing by a zero LP supply is not recoverable, and guessing a
    // proportion would corrupt every later event. Report and stand still.
    if (totalSupply <= BigInt(0)) return { state, checksumOk: false };
    const yesOut = (ev.shares * reserveYes) / totalSupply;
    const noOut = (ev.shares * reserveNo) / totalSupply;
    const mergeable = yesOut < noOut ? yesOut : noOut;
    const next = clamp({
      reserveYes: reserveYes - yesOut,
      reserveNo: reserveNo - noOut,
      totalSupply: totalSupply - ev.shares,
    });
    return { state: next.state, checksumOk: next.checksumOk && mergeable === ev.collateral };
  }

  // buy / sell both need a side; without one we cannot attribute the shares.
  if (ev.outcome !== 0 && ev.outcome !== 1) return { state, checksumOk: false };

  if (ev.kind === 'buy') {
    const yes = reserveYes + ev.collateral;
    const no = reserveNo + ev.collateral;
    return clamp({
      reserveYes: ev.outcome === 0 ? yes - ev.shares : yes,
      reserveNo: ev.outcome === 1 ? no - ev.shares : no,
      totalSupply,
    });
  }

  // sell: shares come in on one side, then returnAmount full sets are merged out.
  const yesIn = ev.outcome === 0 ? reserveYes + ev.shares : reserveYes;
  const noIn = ev.outcome === 1 ? reserveNo + ev.shares : reserveNo;
  return clamp({
    reserveYes: yesIn - ev.collateral,
    reserveNo: noIn - ev.collateral,
    totalSupply,
  });
}

/**
 * Reserves can only go negative if our view of history is incomplete (a gap, or
 * a wrong initial state). Floor them at zero so downstream storage and pricing
 * stay in range, and flag it — a negative reserve is a fact about the indexer,
 * not about the pool, and silently propagating it would hide the gap.
 */
function clamp(next: PoolState): { state: PoolState; checksumOk: boolean } {
  const bad =
    next.reserveYes < BigInt(0) || next.reserveNo < BigInt(0) || next.totalSupply < BigInt(0);
  if (!bad) return { state: next, checksumOk: true };
  return {
    state: {
      reserveYes: next.reserveYes < BigInt(0) ? BigInt(0) : next.reserveYes,
      reserveNo: next.reserveNo < BigInt(0) ? BigInt(0) : next.reserveNo,
      totalSupply: next.totalSupply < BigInt(0) ? BigInt(0) : next.totalSupply,
    },
    checksumOk: false,
  };
}

/**
 * Fold a series of events onto `initial`, returning one row per event carrying
 * the post-event reserves and both prices. Sorts by (blockNumber, logIndex)
 * first: the arithmetic is order-dependent, and a caller that assembled logs
 * from several chunked eth_getLogs calls can easily hand them over unordered.
 */
export function replay(initial: PoolState, events: IndexedEvent[]): ReplayedEvent[] {
  const ordered = events.slice().sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  let state = initial;
  const rows: ReplayedEvent[] = [];
  for (const ev of ordered) {
    const applied = applyEvent(state, ev);
    state = applied.state;
    rows.push({
      ...ev,
      reserveYes: state.reserveYes,
      reserveNo: state.reserveNo,
      totalSupply: state.totalSupply,
      yesBps: yesProbBps(state.reserveYes, state.reserveNo),
      execYesBps: execYesBps(ev.kind, ev.outcome, ev.collateral, ev.shares),
      checksumOk: applied.checksumOk,
    });
  }
  return rows;
}
