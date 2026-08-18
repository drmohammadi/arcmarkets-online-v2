/**
 * Trade ledger: turns raw Buy/Sell events into positions, PnL and per-user
 * totals. Pure functions only — no React, no RPC — so the arithmetic can be
 * reasoned about (and tested) on its own.
 *
 * ── WHY AVERAGE COST, NOT FIFO ───────────────────────────────────────────────
 * The events carry no lot identity, and the scan that feeds this covers a
 * BOUNDED recent window. FIFO consumes the OLDEST lot first — precisely the lot
 * most likely to have fallen outside that window — so it would be systematically
 * and unboundedly wrong exactly when history is truncated. Weighted average cost
 * degrades uniformly instead: a missing opening buy understates basis by a
 * knowable amount, which we can detect (see `basisIncomplete`) and label.
 *
 * It is also O(1) state per position rather than an unbounded lot queue, which
 * matters when aggregating every user on the chain, and it matches the
 * mark-to-market model the portfolio page already uses.
 *
 * ── ARITHMETIC RULES (all amounts are raw 6-decimal USDC as bigint) ──────────
 *  1. ALWAYS multiply before dividing. `(cost * n) / shares`, never
 *     `(cost / shares) * n`. Every position here has cost < shares (a share
 *     costs under $1), so the second form truncates to ZERO and would report an
 *     entire sale as pure profit. This is the most dangerous error in the file.
 *  2. Never route through `Number`. `cost * shares` reaches ~1e24, far past
 *     Number.MAX_SAFE_INTEGER (~9e15). Convert only at the final format call.
 *  3. Integer division truncates toward zero, so `realized` rounds up by at most
 *     one micro-USDC per sell. Do not "fix" this with a ceiling divide — that
 *     just moves the bias and breaks the exact-drain identity in rule 4.
 *  4. A sale that consumes the whole position removes the WHOLE basis, not the
 *     computed share of it. Without that, truncation leaves a few micro-units of
 *     cost against zero shares — a phantom permanent loss on a closed position.
 */

import { outcomeProbBps, BPS } from './pricing';

const ZERO = BigInt(0);

/** One decoded AMM trade, joined to the market it belongs to. */
export interface LedgerTrade {
  blockNumber: bigint;
  logIndex: number;
  /** Lowercased FPMM address the event came from. */
  fpmm: string;
  /** Resolved from the fpmm via the factory's market list; null if unknown. */
  questionId: bigint | null;
  trader: string;
  side: 'buy' | 'sell';
  /** 0 = YES, 1 = NO. */
  outcome: 0 | 1;
  /** investmentAmount for a buy, returnAmount for a sell. */
  collateral: bigint;
  /** sharesOut for a buy, sharesIn for a sell. */
  shares: bigint;
}

/** Resolution payouts, as reported by ConditionalTokens.getPayouts. */
export interface PayoutInfo {
  numerators: readonly [bigint, bigint];
  denominator: bigint;
}

export type TradeStatus = 'open' | 'closed' | 'won' | 'lost' | 'refunded' | 'unknown';

/** A running position in one outcome of one market, for one trader. */
export interface Lot {
  trader: string;
  questionId: bigint;
  outcome: 0 | 1;
  /** Shares still held, as derived from AMM activity alone. */
  shares: bigint;
  /** Total paid for those outstanding shares. */
  cost: bigint;
  /** Signed PnL already locked in by sells. */
  realized: bigint;
  /** Collateral moved in each direction, for volume. */
  bought: bigint;
  sold: bigint;
  tradeCount: number;
  /**
   * True when a sell exceeded the shares this ledger knew about — arithmetic
   * PROOF that shares were acquired outside the scanned window or arrived by a
   * direct ERC-1155 transfer. Cost basis is understated, so PnL is overstated
   * and must be labelled rather than printed as fact.
   */
  basisIncomplete: boolean;
}

export interface LotPnl {
  realized: bigint;
  /** Unrealized (open) or settlement (resolved) PnL. */
  open: bigint;
  total: bigint;
  /**
   * False when the position could not be marked — an empty pool has no price,
   * and marking at the neutral 50/50 placeholder would be a fabricated number.
   */
  marked: boolean;
}

export interface UserStats {
  trader: string;
  realized: bigint;
  open: bigint;
  total: bigint;
  /** Collateral moved in both directions. Double-counts a round trip, as
   *  exchange volume conventionally does. */
  volume: bigint;
  tradeCount: number;
  basisIncomplete: boolean;
}

/** Stable key for a position. */
export function lotKey(trader: string, questionId: bigint, outcome: 0 | 1): string {
  return `${trader.toLowerCase()}:${questionId.toString()}:${outcome}`;
}

/**
 * Fold trades into positions.
 *
 * Trades MUST be supplied in chain order (block, then logIndex): average cost is
 * path-dependent, so replaying a sell before its buy would produce a different
 * basis and trip `basisIncomplete` spuriously.
 */
export function buildLots(trades: LedgerTrade[]): Map<string, Lot> {
  const lots = new Map<string, Lot>();

  for (const t of trades) {
    if (t.questionId === null) continue;
    if (t.shares <= ZERO || t.collateral <= ZERO) continue;

    const key = lotKey(t.trader, t.questionId, t.outcome);
    let lot = lots.get(key);
    if (!lot) {
      lot = {
        trader: t.trader.toLowerCase(),
        questionId: t.questionId,
        outcome: t.outcome,
        shares: ZERO,
        cost: ZERO,
        realized: ZERO,
        bought: ZERO,
        sold: ZERO,
        tradeCount: 0,
        basisIncomplete: false,
      };
      lots.set(key, lot);
    }

    lot.tradeCount += 1;

    if (t.side === 'buy') {
      lot.shares += t.shares;
      lot.cost += t.collateral;
      lot.bought += t.collateral;
      continue;
    }

    // SELL. Clamp to what we know is held. bigint has no floor at zero, so an
    // unclamped subtraction goes negative when the opening buy predates the
    // window — and every later `(cost * n) / shares` would then divide by a
    // negative and silently invert the sign of this position's PnL.
    lot.sold += t.collateral;
    const consumed = t.shares > lot.shares ? lot.shares : t.shares;
    if (t.shares > lot.shares) lot.basisIncomplete = true;

    let basisRemoved = ZERO;
    if (lot.shares > ZERO) {
      basisRemoved =
        consumed === lot.shares
          ? lot.cost // exact drain: remove ALL basis, leaving no truncation dust
          : (lot.cost * consumed) / lot.shares;
    }

    lot.realized += t.collateral - basisRemoved;
    lot.cost -= basisRemoved;
    lot.shares -= consumed;
  }

  return lots;
}

/**
 * Status of a position. Checked in this order — the first match wins.
 *
 * `payout` must be null when the read failed, NOT a zeroed struct: defaulting a
 * failed read to "lost" would tell a winning trader they lost.
 */
export function lotStatus(lot: Lot, resolved: boolean, payout: PayoutInfo | null): TradeStatus {
  // Fully exited before resolution: the market's outcome is irrelevant to a
  // position that no longer existed when it settled.
  if (lot.shares <= ZERO) return 'closed';
  if (!resolved) return 'open';
  if (!payout || payout.denominator <= ZERO) return 'unknown';

  const [a, b] = payout.numerators;
  // Both sides pay: the contract's refund case ([1,1], denominator 2).
  if (a > ZERO && b > ZERO) return 'refunded';
  return payout.numerators[lot.outcome] > ZERO ? 'won' : 'lost';
}

/**
 * PnL for one position.
 *
 * Unresolved: marked at the pool's implied probability, which is the same
 * mark-to-market the portfolio page uses. Resolved: valued with the contract's
 * OWN redeem arithmetic (ConditionalTokens.redeemPositions):
 *
 *     payout = shares * numerators[outcome] / denominator
 *
 * computed in exactly that order, so the figure shown equals the on-chain payout
 * to the micro-unit. Going via an intermediate per-share price would truncate
 * twice and disagree with the contract on some inputs.
 */
export function lotPnl(
  lot: Lot,
  opts: {
    resolved: boolean;
    payout: PayoutInfo | null;
    /** Pool reserves for the mark. Omit or pass hasLiquidity:false when empty. */
    reserveYes?: bigint;
    reserveNo?: bigint;
    hasLiquidity?: boolean;
  }
): LotPnl {
  const base = { realized: lot.realized, open: ZERO, total: lot.realized, marked: true };

  if (lot.shares <= ZERO) return base;

  if (opts.resolved) {
    const p = opts.payout;
    if (!p || p.denominator <= ZERO) {
      // Cannot value the position honestly; report only what is locked in.
      return { ...base, marked: false };
    }
    const value = (lot.shares * p.numerators[lot.outcome]) / p.denominator;
    const open = value - lot.cost;
    return { realized: lot.realized, open, total: lot.realized + open, marked: true };
  }

  if (!opts.hasLiquidity || opts.reserveYes === undefined || opts.reserveNo === undefined) {
    // An empty pool prices at a neutral 50/50 placeholder. Marking against a
    // fabricated price is worse than declining to mark.
    return { ...base, marked: false };
  }

  const bps = outcomeProbBps(opts.reserveYes, opts.reserveNo, lot.outcome);
  const value = (lot.shares * BigInt(bps)) / BigInt(BPS);
  const open = value - lot.cost;
  return { realized: lot.realized, open, total: lot.realized + open, marked: true };
}

/**
 * Roll positions up per trader, for the leaderboard.
 *
 * `valuer` supplies the per-position PnL so this function stays free of market
 * state; the caller already holds pools and payouts.
 *
 * Volume counts collateral moved in BOTH directions. Counting buys alone would
 * let a trader who round-trips look half as active as they were. Note this
 * double-counts a round trip, which is what exchange volume conventionally
 * means — the UI says so.
 */
export function aggregateByUser(
  lots: Iterable<Lot>,
  valuer: (lot: Lot) => LotPnl
): UserStats[] {
  const byUser = new Map<string, UserStats>();

  for (const lot of lots) {
    let u = byUser.get(lot.trader);
    if (!u) {
      u = {
        trader: lot.trader,
        realized: ZERO,
        open: ZERO,
        total: ZERO,
        volume: ZERO,
        tradeCount: 0,
        basisIncomplete: false,
      };
      byUser.set(lot.trader, u);
    }

    const pnl = valuer(lot);
    u.realized += pnl.realized;
    u.open += pnl.open;
    u.total += pnl.realized + pnl.open;
    u.volume += lot.bought + lot.sold;
    u.tradeCount += lot.tradeCount;
    if (lot.basisIncomplete) u.basisIncomplete = true;
  }

  return Array.from(byUser.values());
}

/**
 * Execution price of a trade in bps, from its own event arguments.
 *
 * Same derivation the price chart uses: a share redeems for exactly 1 USDC, so
 * collateral/shares IS the implied probability of the outcome traded. Returns
 * null for anything nonsensical rather than reporting a misleading price.
 */
export function tradePriceBps(trade: LedgerTrade): number | null {
  if (trade.shares <= ZERO || trade.collateral <= ZERO) return null;
  const bps = Number((trade.collateral * BigInt(BPS)) / trade.shares);
  if (!Number.isFinite(bps) || bps <= 0 || bps > BPS) return null;
  return bps;
}
