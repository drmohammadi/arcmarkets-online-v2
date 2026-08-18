/**
 * Market pricing math, shared by the list, detail page, and chart so the
 * displayed probability is computed one way everywhere.
 *
 * In a constant-product AMM over YES/NO outcome tokens the marginal price of
 * an outcome is the OPPOSITE reserve over the total:
 *   P(YES) = reserveNO / (reserveYES + reserveNO)
 * Buying YES removes YES tokens from the pool, so YES gets scarcer and dearer.
 *
 * All math stays in bigint until the final display step; probabilities are
 * carried as integer basis points (0..10000) to avoid float drift.
 */

import { USDC_DECIMALS, formatUsdc } from './format';

export const BPS = 10000;

/** Neutral 50/50 in bps, used when a pool has no liquidity to price against. */
export const NEUTRAL_BPS = 5000;

/**
 * Implied probability of YES in basis points, from raw pool reserves.
 * Returns NEUTRAL_BPS when the pool is empty (no information to price on).
 */
export function yesProbBps(reserveYes: bigint, reserveNo: bigint): number {
  const total = reserveYes + reserveNo;
  if (total <= BigInt(0)) return NEUTRAL_BPS;
  return Number((reserveNo * BigInt(BPS)) / total);
}

/** Implied probability of a given outcome (0 = YES, 1 = NO) in bps. */
export function outcomeProbBps(reserveYes: bigint, reserveNo: bigint, outcome: 0 | 1): number {
  const yes = yesProbBps(reserveYes, reserveNo);
  return outcome === 0 ? yes : BPS - yes;
}

/** Format bps as a percent string, e.g. 4823 -> "48.2%". */
export function formatProbPct(bps: number, digits = 1): string {
  const clamped = Math.max(0, Math.min(BPS, bps));
  return `${(clamped / 100).toFixed(digits)}%`;
}

/** Format bps as a whole-number percent, e.g. 4823 -> "48%". Used on compact cards. */
export function formatProbPctCompact(bps: number): string {
  const clamped = Math.max(0, Math.min(BPS, bps));
  return `${Math.round(clamped / 100)}%`;
}

/**
 * Price of one share in USDC, as a display string like "0.48".
 * A share pays out exactly 1 USDC if it wins, so price == probability.
 */
export function sharePriceUsdc(bps: number): string {
  const clamped = Math.max(0, Math.min(BPS, bps));
  return (clamped / BPS).toFixed(2);
}

/**
 * Total collateral locked in the pool. Every full YES+NO set is backed 1:1 by
 * collateral, so the mergeable amount (the smaller reserve) is the floor on
 * what the pool holds. This is a conservative, honest liquidity figure.
 */
export function poolLiquidity(reserveYes: bigint, reserveNo: bigint): bigint {
  return reserveYes < reserveNo ? reserveYes : reserveNo;
}

/**
 * Average realized price per share for a buy, as a display string.
 * investmentAmount and sharesOut are both raw 6-decimal units, so the ratio is
 * already a plain price. Guards divide-by-zero.
 */
export function avgBuyPrice(investmentAmount: bigint, sharesOut: bigint): string {
  if (sharesOut <= BigInt(0)) return '—';
  const scaled = (investmentAmount * BigInt(10 ** USDC_DECIMALS)) / sharesOut;
  return formatUsdc(scaled);
}

/**
 * Slippage bound helpers. Buy protects a MINIMUM shares out; sell protects a
 * MAXIMUM shares in. toleranceBps is user-controlled (e.g. 100 = 1%).
 */
export function minSharesOut(quote: bigint, toleranceBps: number): bigint {
  const t = BigInt(Math.max(0, Math.min(BPS, Math.round(toleranceBps))));
  return (quote * (BigInt(BPS) - t)) / BigInt(BPS);
}

export function maxSharesIn(quote: bigint, toleranceBps: number): bigint {
  const t = BigInt(Math.max(0, Math.min(BPS, Math.round(toleranceBps))));
  return (quote * (BigInt(BPS) + t)) / BigInt(BPS);
}
