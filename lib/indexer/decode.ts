/**
 * The ONLY viem-aware indexer module: event definitions, plus the mapping from a
 * decoded log to the neutral row shapes the rest of the indexer stores.
 *
 * WHY THE MAPPING READS ARGUMENTS BY NAME, NEVER BY POSITION. The FPMM's two
 * liquidity events take the same two values in OPPOSITE ORDER
 * (`FixedProductMarketMaker.sol:49-50`):
 *
 *   event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares);
 *   event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral);
 *
 * A positional mapping compiles, typechecks, runs, and silently swaps collateral
 * with shares on every `removeLiquidity`. Nothing downstream raises: `replay()`
 * would scale the reserves by an LP-share count and check the result against a
 * collateral figure, so every later price in that pool is wrong and the only
 * symptom is a chart that looks plausible. Hence: index `args` by argument name,
 * and REFUSE a log whose args arrived positionally (an array) rather than
 * guessing which order it is in.
 *
 * The parameters here are typed STRUCTURALLY (`RawEventLog`), not as viem's
 * `Log`: every field is `unknown` and validated at runtime, so the same mapping
 * accepts a viem log, a JSON round-trip of one, and a plain object in a test
 * that imports no viem at all. Nothing about the mapping is viem-specific except
 * the ABI constants below.
 *
 * Sanitizing is NOT this module's job. `question` and `category` are stored
 * verbatim (they are what the chain said) and go through `lib/sanitize.ts` at
 * render, per the standing rule in CLAUDE.md. Addresses and hashes ARE
 * normalized here — lowercased and shape-checked — because they are join keys
 * and primary keys, not display strings.
 */

import { parseAbiItem, type AbiEvent } from 'viem';
import type { EventKind, IndexedEvent } from './replay';
// Relative, not `@/lib/sanitize`: this module is also compiled by the
// Hardhat/mocha suite in `contracts/`, which has no `@/` alias. sanitize.ts
// itself imports nothing, so it resolves under both consumers.
import { safeAddress } from '../sanitize';

/**
 * Signatures copied VERBATIM from `lib/abis.ts:18-19` and `:46-49`, which match
 * `MarketFactory.sol:32-43` and `FixedProductMarketMaker.sol:49-52`. They are
 * duplicated rather than imported because `abis.ts` exports whole parsed ABIs
 * (functions included) and viem's `getLogs` wants event items; if a contract
 * event ever changes, both places must change together.
 */
export const FACTORY_EVENTS: AbiEvent[] = [
  parseAbiItem(
    'event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)'
  ),
  parseAbiItem('event MarketResolved(uint256 indexed questionId, uint256[2] payouts)'),
];

export const FPMM_EVENTS: AbiEvent[] = [
  parseAbiItem(
    'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)'
  ),
  parseAbiItem(
    'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)'
  ),
  parseAbiItem('event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)'),
  parseAbiItem('event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)'),
];

/** A market as `MarketCreated` describes it. `feeBps` is bps (FPMM caps at 1000). */
export interface MarketCreatedRow {
  questionId: bigint;
  fpmm: string;
  conditionId: string;
  question: string;
  category: string;
  resolutionTime: bigint;
  resolver: string;
  feeBps: number;
  blockNumber: bigint;
}

/** A resolution as `MarketResolved` describes it. `[1,0]` YES, `[0,1]` NO, `[1,1]` refund. */
export interface MarketResolvedRow {
  questionId: bigint;
  payoutYes: bigint;
  payoutNo: bigint;
  blockNumber: bigint;
}

/**
 * The only fields of a log this module reads, each `unknown` so that validation
 * happens at runtime rather than being assumed by a cast. viem's `Log` is
 * assignable to this; so is a hand-built object.
 */
export interface RawEventLog {
  readonly eventName?: unknown;
  readonly args?: unknown;
  readonly address?: unknown;
  readonly blockNumber?: unknown;
  readonly logIndex?: unknown;
  readonly transactionHash?: unknown;
}

/** Identity of the log itself, shared by every event shape. */
interface LogIdentity {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  fpmm: string;
}

const ZERO = BigInt(0);
/** `markets.fee_bps` is a Postgres `integer`; anything wider cannot be stored. */
const MAX_INT32 = BigInt(2147483647);

/**
 * A uint256 as a bigint, or null.
 *
 * A JS `number` is REFUSED rather than converted: `Number` cannot hold a
 * 6-decimal uint256 exactly, and quietly accepting one would reintroduce the
 * precision loss this indexer exists to avoid. Decimal/hex strings are accepted
 * because a log that has been through JSON has bigints as strings.
 */
function toBig(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= ZERO ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  try {
    const v = BigInt(value);
    return v >= ZERO ? v : null;
  } catch {
    return null;
  }
}

/** A non-negative integer index (viem gives `logIndex` as a number), or null. */
function toIndex(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** A 32-byte hex string, lowercased — tx hashes and conditionIds are keys. */
function toHash32(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

/** 0 or 1, from the uint256 `outcome` arg. Anything else is not a side we can attribute. */
function toOutcome(value: unknown): 0 | 1 | null {
  const v = toBig(value);
  if (v === ZERO) return 0;
  if (v !== null && v === BigInt(1)) return 1;
  return null;
}

/**
 * Args as a NAMED record, or null when they are positional.
 *
 * viem returns an object keyed by argument name whenever the ABI names its
 * inputs (ours all do) and an array when it cannot. An array is refused: see the
 * header — the liquidity events' positional orders are mirror images, so a guess
 * has a 50% chance of corrupting every reserve in the pool with no error raised.
 */
function namedArgs(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Where this log sits in the chain, and which pool emitted it. */
function identify(log: RawEventLog): LogIdentity | null {
  // A pending log has blockNumber, logIndex and transactionHash all null. It
  // cannot be ordered, cannot be deduped, and will be re-delivered when mined.
  const blockNumber = toBig(log.blockNumber);
  const logIndex = toIndex(log.logIndex);
  const txHash = toHash32(log.transactionHash);
  const fpmm = safeAddress(log.address);
  if (blockNumber === null || logIndex === null || txHash === null || fpmm === null) return null;
  return { blockNumber, logIndex, txHash, fpmm };
}

/** Trade-shaped arg names, per event. Buy and Sell name the same values differently. */
const TRADE_FIELDS: Record<string, { kind: EventKind; actor: string; collateral: string; shares: string }> = {
  Buy: { kind: 'buy', actor: 'buyer', collateral: 'investmentAmount', shares: 'sharesOut' },
  Sell: { kind: 'sell', actor: 'seller', collateral: 'returnAmount', shares: 'sharesIn' },
};

/**
 * One FPMM log as an `IndexedEvent`, or null when it is unusable.
 *
 * Skips, mirroring `hooks/useTradeLedger.ts:231-261`: a null/absent
 * blockNumber, logIndex, tx hash or address; an unrecognised `eventName`;
 * positional args; a trade whose `outcome` is outside {0,1}.
 *
 * It deliberately does NOT skip a zero-amount trade, which `useTradeLedger.ts:242`
 * does. That hook computes a cost basis, where a zero denominator is useless; this
 * feeds a REPLAY, where dropping an event is a hole in the fold and every later
 * reserve is wrong. `execYesBps()` already returns null for degenerate amounts, so
 * keeping the event costs nothing and loses no ordering. (The contract's
 * ZeroAmount/ZeroShares guards make it unreachable in either case.)
 */
export function toIndexedEvent(log: RawEventLog): IndexedEvent | null {
  const id = identify(log);
  if (id === null) return null;
  const args = namedArgs(log.args);
  if (args === null) return null;
  const name = typeof log.eventName === 'string' ? log.eventName : '';

  const trade = TRADE_FIELDS[name];
  if (trade) {
    const actor = safeAddress(args[trade.actor]);
    const outcome = toOutcome(args.outcome);
    const collateral = toBig(args[trade.collateral]);
    const shares = toBig(args[trade.shares]);
    if (actor === null || outcome === null || collateral === null || shares === null) return null;
    return { ...id, kind: trade.kind, actor, outcome, collateral, shares };
  }

  if (name === 'LiquidityAdded' || name === 'LiquidityRemoved') {
    // BY NAME for both, which is the whole point: `LiquidityRemoved` declares
    // (shares, collateral) and `LiquidityAdded` declares (collateral, shares).
    const actor = safeAddress(args.provider);
    const collateral = toBig(args.collateral);
    const shares = toBig(args.shares);
    if (actor === null || collateral === null || shares === null) return null;
    return {
      ...id,
      kind: name === 'LiquidityAdded' ? 'liquidity_added' : 'liquidity_removed',
      actor,
      // Liquidity touches BOTH sides, so it belongs to neither outcome.
      outcome: null,
      collateral,
      shares,
    };
  }

  return null;
}

/**
 * Decode a batch of FPMM logs, dropping the unusable ones.
 *
 * Order is preserved but not relied upon: `replay()` sorts by
 * (blockNumber, logIndex) itself, because a batch assembled from several chunked
 * `eth_getLogs` calls can arrive out of order.
 */
export function decodeFpmmLogs(logs: readonly unknown[]): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const log of logs) {
    if (!log || typeof log !== 'object') continue;
    const ev = toIndexedEvent(log as RawEventLog);
    if (ev) out.push(ev);
  }
  return out;
}

/** One `MarketCreated` log as a row, or null when it is unusable. */
function toMarketCreated(id: LogIdentity, args: Record<string, unknown>): MarketCreatedRow | null {
  const questionId = toBig(args.questionId);
  const fpmm = safeAddress(args.fpmm);
  const conditionId = toHash32(args.conditionId);
  const resolutionTime = toBig(args.resolutionTime);
  const resolver = safeAddress(args.resolver);
  const fee = toBig(args.fee);
  if (
    questionId === null ||
    fpmm === null ||
    conditionId === null ||
    resolutionTime === null ||
    resolver === null ||
    fee === null
  ) {
    return null;
  }
  // The bound is STORAGE, not policy: `fee_bps` is a Postgres integer. The FPMM
  // constructor rejects fee > MAX_FEE (1000 bps) before this event can be
  // emitted, so a wider value means the log is not from a factory we understand;
  // a market is not dropped merely for an unusual-but-storable fee, because fee
  // plays no part in the replay arithmetic.
  if (fee > MAX_INT32) return null;
  if (typeof args.question !== 'string' || typeof args.category !== 'string') return null;
  return {
    questionId,
    fpmm,
    conditionId,
    // Verbatim; sanitized at render, never here.
    question: args.question,
    category: args.category,
    resolutionTime,
    resolver,
    feeBps: Number(fee),
    blockNumber: id.blockNumber,
  };
}

/**
 * One `MarketResolved` log as a row, or null when it is unusable.
 *
 * `payouts` is the one argument read positionally, and legitimately so: it is a
 * `uint256[2]`, whose two slots ARE its meaning (`MarketFactory.sol:106` —
 * [yesNumerator, noNumerator]).
 */
function toMarketResolved(id: LogIdentity, args: Record<string, unknown>): MarketResolvedRow | null {
  const questionId = toBig(args.questionId);
  const payouts = args.payouts;
  if (questionId === null || !Array.isArray(payouts) || payouts.length < 2) return null;
  const payoutYes = toBig(payouts[0]);
  const payoutNo = toBig(payouts[1]);
  if (payoutYes === null || payoutNo === null) return null;
  return { questionId, payoutYes, payoutNo, blockNumber: id.blockNumber };
}

/**
 * Decode a batch of factory logs into the two row kinds, dropping unusable ones.
 *
 * The same skip discipline as `decodeFpmmLogs`, except that `address` is the
 * factory rather than a pool: it is still required, because a log with no
 * address has no provenance.
 */
export function decodeFactoryLogs(logs: readonly unknown[]): {
  created: MarketCreatedRow[];
  resolved: MarketResolvedRow[];
} {
  const created: MarketCreatedRow[] = [];
  const resolved: MarketResolvedRow[] = [];
  for (const log of logs) {
    if (!log || typeof log !== 'object') continue;
    const raw = log as RawEventLog;
    const id = identify(raw);
    if (id === null) continue;
    const args = namedArgs(raw.args);
    if (args === null) continue;
    if (raw.eventName === 'MarketCreated') {
      const row = toMarketCreated(id, args);
      if (row) created.push(row);
    } else if (raw.eventName === 'MarketResolved') {
      const row = toMarketResolved(id, args);
      if (row) resolved.push(row);
    }
  }
  return { created, resolved };
}
