/**
 * The indexer's run loop: one forward-only pass over a bounded block range.
 *
 * FIVE PROPERTIES, each one a bug this file exists to prevent.
 *
 * 1. **`runIndexer` NEVER THROWS.** It returns `error` in its result. Its main
 *    caller is `scheduleBackgroundIndex`, which hands the promise to Vercel's
 *    `waitUntil()`; a rejection there is an unhandled rejection in a background
 *    task with no request to attach it to and nowhere to surface. Every failure
 *    path below converges on `failed()`.
 *
 * 2. **ONE TRANSACTION PER RANGE.** Blocks, markets, resolutions, events and the
 *    checkpoint land together or not at all. A checkpoint ahead of the rows it
 *    describes is a PERMANENT hole: the next run starts above the blocks that
 *    were lost, so nothing ever re-reads them.
 *
 * 3. **FORWARD-ONLY, ONE CURSOR.** `last_indexed_block` is the only cursor and it
 *    only moves up (except on a reorg, which deletes what it rewinds past). A run
 *    that hits `maxBlocks` or its request budget commits what it reached and
 *    exits; the next run continues. Nothing is ever re-scanned, and there is no
 *    backward crawl — `CLAUDE.md` documents twice what a head-relative window
 *    does to this project's history.
 *
 * 4. **ONE `getBlock` PER DISTINCT EVENT-BEARING BLOCK, EVER.** Not one per
 *    event, and not one per block in the range. `blocks` is the permanent cache,
 *    `knownBlockHeaders` is consulted before fetching, and this is the entire
 *    reason the chart can afford a real time axis at all.
 *
 * 5. **`budgetStopped` IS NOT `error`.** A run that stopped at its cap is
 *    healthy and its result says so with `error: null`; a run whose request
 *    failed is not. Conflating them makes the UI warn about a working system.
 *
 * NO SQL LIVES HERE. Every statement is in `lib/db/queries.ts`, which is what
 * makes the parameterized-everything claim auditable by reading one file.
 */

import { http } from 'viem';
import { getDeployment } from '../contracts';
import { withTx } from '../db/pool';
import {
  acquireLease,
  blocksAtOrBelow,
  commitCheckpoint,
  ensureIndexerState,
  insertMarketEvents,
  knownBlockHeaders,
  latestReplayState,
  markResolved,
  questionIdByFpmm,
  recordError,
  releaseLease,
  resetCheckpoint,
  saveAcceptedChunk,
  truncateAbove,
  upsertBlocks,
  upsertMarkets,
  type BlockRow,
  type IndexerStateRow,
  type MarketEventInsert,
} from '../db/queries';
import { safeAddress } from '../sanitize';
import { nextChunkCeiling } from './chunking';
import { getIndexerConfig } from './config';
import {
  FACTORY_EVENTS,
  FPMM_EVENTS,
  decodeFactoryLogs,
  decodeFpmmLogs,
  type MarketCreatedRow,
  type MarketResolvedRow,
} from './decode';
import { replay, zeroState, type IndexedEvent } from './replay';
import { createIndexerRpc } from './rpc';

const ZERO = BigInt(0);
const ONE = BigInt(1);

/**
 * Which chain to index, and how to reach it.
 *
 * Normally derived from `getIndexerConfig()` plus `lib/deployments/index.json`.
 * It is a named type because `IndexRunOptions.chain` overrides it wholesale.
 */
export interface ChainSettings {
  chainId: number;
  /** The `MarketFactory`. Lowercased by `normalizeChainSettings`. */
  factory: string;
  /** The factory's deploy block: the exact, sound floor for every sweep. */
  startBlock: bigint;
  rpcUrl: string;
  /** Blocks left unindexed at the head, so the common reorg never reaches the db. */
  confirmations: number;
}

export interface IndexRunOptions {
  maxBlocks: bigint;
  /**
   * Cap on `eth_getLogs` attempts, split between the factory and pool sweeps.
   *
   * It bounds THIS CODEBASE'S attempts, not HTTP round trips — viem's `http`
   * transport retries 3 times by default underneath. `runIndexer` therefore
   * builds its client with `http(rpcUrl, { retryCount: 0 })` so the number is
   * literal, and the only retry is `rpc.ts`'s rate-limit ladder.
   *
   * Block-header fetches are NOT charged to it; see `headerBudget`.
   */
  maxRequests: number;
  reason: 'traffic' | 'cron' | 'manual';
  /**
   * Index this chain instead of the configured one, replacing
   * `getIndexerConfig()`'s chain fields and the deployments lookup.
   *
   * This exists because the local Hardhat chain (31337) has no entry in
   * `lib/deployments/index.json` and must not get one: that file is the record of
   * REAL deployments, and a fake entry there would show a phantom chain to the
   * whole frontend. The e2e proof passes its freshly-deployed factory address,
   * `startBlock: 0` and `confirmations: 0` through here instead.
   *
   * NOT config-free: `DATABASE_URL` and `INDEXER_CHUNK_BLOCKS` are still read.
   * The chunk width is a property of the RPC ENDPOINT rather than of the chain,
   * and the per-chain `accepted_chunk` already supersedes it, so there would be
   * nothing for an override to say about it.
   */
  chain?: ChainSettings;
}

export interface IndexRunResult {
  /** Blocks committed by this run: 0 when nothing landed. */
  ranBlocks: bigint;
  fromBlock: bigint;
  /** The committed checkpoint. Below `fromBlock` when nothing landed. */
  toBlock: bigint;
  eventsInserted: number;
  /** Every RPC attempt this run made: sweeps, headers, reorg probes, head read. */
  requests: number;
  skippedBecauseLeased: boolean;
  reorgDepth: number;
  backfillComplete: boolean;
  error: string | null;
  /**
   * A cap — request budget or header budget — ended this run early. NOT an
   * error, and deliberately a separate field from one: history not fetched yet is
   * a healthy state, and reporting it as a failure makes the status endpoint warn
   * about a working system.
   */
  budgetStopped: boolean;
  /**
   * Replayed events whose own numbers contradicted the replayed reserves.
   *
   * `MarketEventInsert` has no column for `ReplayedEvent.checksumOk`, so without
   * this the free drift detector `replay()` provides would die at the persistence
   * boundary. A non-zero count is also written to `last_error` AFTER the commit
   * (the commit clears it), which is what makes `/api/indexer/status` report
   * `degraded`.
   */
  checksumFailures: number;
  /**
   * There WAS a range to cover and the checkpoint did not move.
   *
   * Distinct from `budgetStopped`, which means a cap ended a run that still
   * committed something. This is the pathological case: a run that reached the
   * head of nothing, repeated, is zero progress. It is reported through
   * `last_error` as well, so `/api/indexer/status` shows `degraded` rather than a
   * healthy tick — a stamped `last_tick_at` with no error would make a stuck
   * indexer indistinguishable from an idle one.
   *
   * False when there was genuinely nothing to do (`safeHead <= last_indexed_block`),
   * which is a healthy state and stays one.
   */
  noProgress: boolean;
}

/**
 * How deep a reorg this indexer will handle, in blocks, and how many stored
 * blocks the probe will examine. One constant because they are one question.
 *
 * TWO ROLES, both bounds on the same thing:
 *  - the probe examines at most this many stored `blocks` rows, each costing one
 *    `eth_getBlock`, so a chain that disagrees everywhere cannot spend thousands
 *    of requests;
 *  - a fork more than this many blocks below the checkpoint is NOT treated as a
 *    reorg. It is reported and nothing is truncated.
 *
 * The second role is an assumption, and it is the same KIND of assumption as
 * `INDEXER_CONFIRMATIONS` (12 blocks of finality) — 21x more conservative. It is
 * also CHECKED rather than merely assumed: a stored block that disagrees with the
 * chain more than this far down contradicts it, and that case reports instead of
 * cutting. See `probeReorgCut` for why the bound has to exist at all — `blocks`
 * holds only event-bearing blocks, so "no stored witness nearby" is common and is
 * NOT evidence that no common ancestor exists.
 */
export const MAX_REORG_WALKBACK = 256;

/**
 * Lease duration per reason, in seconds.
 *
 * Long enough to cover the run it protects and no longer: an over-long lease
 * wedges the indexer for its whole duration after a function is killed, and an
 * over-short one lets a second run start alongside the first. `cron` matches the
 * route's `maxDuration = 300`; `traffic` runs inside `waitUntil` with a small
 * request budget and finishes in seconds. `acquireLease` clamps to [1, 3600]
 * regardless, so a bad value here cannot produce an immortal lease.
 */
export const LEASE_SECONDS: Record<IndexRunOptions['reason'], number> = {
  traffic: 120,
  cron: 300,
  manual: 300,
};

/** Floor and multiplier for `headerBudget`. */
const MIN_HEADER_BUDGET = 50;
const HEADERS_PER_REQUEST_UNIT = 10;

/** How many drift notes fit in `last_error` before it stops being readable. */
const MAX_DRIFT_NOTES = 12;

/** The largest unix second a `timestamptz` can hold (9999-12-31T23:59:59Z). */
const MAX_TIMESTAMP_SECONDS = BigInt('253402300799');

// ---------------------------------------------------------------------------
// Pure helpers. Extracted so the arithmetic that decides WHAT gets indexed is
// assertable without a node and without a database: every one of these fails
// silently when it is wrong — a range clamped to nothing, a block header fetched
// per event, events folded in the wrong order — and yields less data rather than
// an error. `contracts/test/IndexerRun.test.ts` pins them.
// ---------------------------------------------------------------------------

/**
 * The highest block safe to index: `head - confirmations`.
 *
 * MAY RETURN A NEGATIVE NUMBER, deliberately, and is not clamped to 0. On a chain
 * younger than the confirmation window the honest answer is "no block is final
 * yet", and the caller's `clampRange` turns that into "nothing to do". Clamping
 * to 0 would instead index block 0 as though it were final.
 *
 * A non-finite or negative `confirmations` is read as 0 rather than trusted: it
 * can only come from a misconfigured env var, and 0 is the value that indexes the
 * most while still never inventing a block.
 */
export function computeSafeHead(head: bigint, confirmations: number): bigint {
  const conf =
    Number.isFinite(confirmations) && confirmations > 0 ? Math.floor(confirmations) : 0;
  return head - BigInt(conf);
}

/**
 * The next range to index, or null when there is nothing to do.
 *
 * `from` is always `lastIndexedBlock + 1` — the one cursor, never a head-relative
 * guess. `to` is the nearer of the safe head and the `maxBlocks` limit, so a
 * 1.7M-block backfill is walked in bounded runs that each commit their progress.
 *
 * A non-positive `maxBlocks` is treated as one block: a zero step is a run that
 * commits nothing forever, which looks exactly like a working indexer on an idle
 * chain.
 */
export function clampRange(
  lastIndexedBlock: bigint,
  safeHead: bigint,
  maxBlocks: bigint
): { from: bigint; to: bigint } | null {
  const from = lastIndexedBlock + ONE;
  if (safeHead < from) return null;
  const width = maxBlocks > ZERO ? maxBlocks : ONE;
  const limit = from + width - ONE;
  return { from, to: safeHead < limit ? safeHead : limit };
}

/** Rows at or below `maxBlock`. Used to trim both sweeps to the committed range. */
export function atOrBelow<T extends { blockNumber: bigint }>(
  rows: readonly T[],
  maxBlock: bigint
): T[] {
  return rows.filter((r) => r.blockNumber <= maxBlock);
}

/**
 * The distinct block numbers appearing in any of `groups`, ascending.
 *
 * This is property 4 of the header comment expressed as a function: the run loop
 * fetches one header per element of this array, so a duplicate here is a wasted
 * `eth_getBlock` and a missing one is a `NOT NULL` violation on `block_time`.
 * Ascending because the header budget takes a PREFIX of it, and a prefix is only
 * a contiguous range of history if the list is sorted.
 */
export function distinctBlockNumbers(
  groups: readonly (readonly { blockNumber: bigint }[])[]
): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const group of groups) {
    for (const row of group) {
      const key = row.blockNumber.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row.blockNumber);
    }
  }
  return out.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** Those of `distinct` we hold no header for. `known` is keyed by `toString()`. */
export function missingBlockNumbers(
  distinct: readonly bigint[],
  known: ReadonlySet<string>
): bigint[] {
  return distinct.filter((n) => !known.has(n.toString()));
}

/** One market's events, in the order the contract applied them. */
export interface MarketEventGroup {
  questionId: bigint;
  fpmm: string;
  events: IndexedEvent[];
}

/**
 * Group FPMM events by market and order each group by `(blockNumber, logIndex)`.
 *
 * ORDER IS CORRECTNESS, not tidiness. `replay` folds pre-event state into
 * post-event state, so one transposed pair silently corrupts every later reserve
 * in that pool — and a batch assembled from several chunked `eth_getLogs` calls
 * arrives unordered as a matter of course. `replay` sorts again internally; this
 * sort exists so the ordering is assertable here rather than only observable
 * through the fold.
 *
 * Groups come back sorted by question id so a run's writes and log lines are
 * deterministic across invocations.
 *
 * ORPHANS are events whose pool address maps to no market. It should be
 * unreachable — the address filter is built FROM this same map — so a non-empty
 * list means a `MarketCreated` was dropped as unusable, which is a hole in that
 * pool's replay. Returned rather than discarded so the caller can report it;
 * they must never be inserted, since `market_events.question_id` is NOT NULL.
 */
export function groupEventsByMarket(
  events: readonly IndexedEvent[],
  questionIdByPool: ReadonlyMap<string, bigint>
): { groups: MarketEventGroup[]; orphans: IndexedEvent[] } {
  const byQuestion = new Map<string, MarketEventGroup>();
  const orphans: IndexedEvent[] = [];

  for (const ev of events) {
    const pool = ev.fpmm.toLowerCase();
    const questionId = questionIdByPool.get(pool);
    if (questionId === undefined) {
      orphans.push(ev);
      continue;
    }
    const key = questionId.toString();
    const group = byQuestion.get(key);
    if (group) group.events.push(ev);
    else byQuestion.set(key, { questionId, fpmm: pool, events: [ev] });
  }

  const groups = [...byQuestion.values()];
  for (const group of groups) {
    group.events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      return a.logIndex - b.logIndex;
    });
  }
  groups.sort((a, b) => (a.questionId === b.questionId ? 0 : a.questionId < b.questionId ? -1 : 1));
  return { groups, orphans };
}

/**
 * The ceiling to persist after a run, or null when the run learned nothing.
 *
 * Two rules, both from `chunking.ts`:
 *  - the largest span any sweep served AT ITS FULL REQUESTED WIDTH is the only
 *    evidence about the endpoint's limit; a `null` span is no information;
 *  - the fold is `nextChunkCeiling`, which ONLY EVER RAISES, because
 *    `eth_getLogs` can be refused for RESULT COUNT as well as width and one dense
 *    range must not throttle every later scan permanently.
 *
 * Returning null (rather than the unchanged current value) matters: it is what
 * lets `commitCheckpoint` COALESCE and keep a ceiling this run had no opinion on.
 */
export function foldAcceptedChunk(
  current: bigint | null,
  spans: readonly (bigint | null)[]
): bigint | null {
  let best: bigint | null = null;
  for (const span of spans) {
    if (span === null || span <= ZERO) continue;
    if (best === null || span > best) best = span;
  }
  return best === null ? null : nextChunkCeiling(current, best);
}

/**
 * How many block headers one run may fetch.
 *
 * SEPARATE FROM `maxRequests`, and that separation is load-bearing. A log sweep's
 * cost scales with the WIDTH of the range, so it must be capped by a request
 * budget or a 4M-block cron span becomes thousands of calls. A header fetch's
 * cost scales with the number of event-bearing blocks in the range — real data,
 * paid for exactly once ever and cached in `blocks` forever. Charging headers to
 * the sweep budget would mean a range containing 300 trades could never be
 * committed at a budget of 40, and the backfill would stall permanently on the
 * first busy stretch of chain.
 *
 * It is still a cap, because "bounded by data" is not "bounded": a range holding
 * 50,000 event blocks would otherwise issue 50,000 sequential calls and hit the
 * function timeout, losing the whole uncommitted range. When it binds, the run
 * commits up to the last block it fetched a header for and the next run continues
 * — forward-only progress, reported as `budgetStopped`, never as an error.
 */
export function headerBudget(maxRequests: number): number {
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) return MIN_HEADER_BUDGET;
  const scaled = Math.floor(maxRequests) * HEADERS_PER_REQUEST_UNIT;
  return scaled > MIN_HEADER_BUDGET ? scaled : MIN_HEADER_BUDGET;
}

/**
 * A block-count delta as a `number`, saturating instead of losing digits.
 *
 * `reorgDepth` is a count for a human to read, not an amount, so a `number` is
 * the right type — but a cut back to the anchor makes the delta millions of
 * blocks, and a silently wrong figure in a diagnostic is worse than a visibly
 * saturated one.
 */
export function toCount(delta: bigint): number {
  if (delta <= ZERO) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return delta > max ? Number.MAX_SAFE_INTEGER : Number(delta);
}

/**
 * A block's unix-second timestamp as a `Date`.
 *
 * Throws outside `timestamptz`'s range rather than storing a garbage date.
 * `block_time` IS the chart's x-axis and the bucket key, so a wrong value is not
 * a cosmetic defect; and `new Date(Infinity)` would reach Postgres as an invalid
 * date and abort the range transaction with a far less obvious message than this.
 * (`resolution_time` is CLAMPED instead — see `queries.ts` — because it comes
 * from a market creator's arbitrary input and affects nothing downstream. A block
 * timestamp comes from the chain and cannot be nonsense without something being
 * very wrong.)
 */
export function blockTimeOf(seconds: bigint): Date {
  if (seconds < ZERO || seconds > MAX_TIMESTAMP_SECONDS) {
    throw new Error(`blockTimeOf: block timestamp ${seconds} is outside timestamptz range`);
  }
  return new Date(Number(seconds) * 1000);
}

/**
 * Validate and normalize chain settings, whatever their source.
 *
 * A malformed factory address is refused rather than lowercased and used:
 * `ensureIndexerState` stores it and then REFUSES every later run whose factory
 * disagrees, so a typo here is sticky until an operator clears the chain's rows
 * by hand. The `startBlock` is refused if negative for the reason `CLAUDE.md`
 * gives twice — a wrong floor hides trades silently — and `confirmations` is
 * clamped rather than refused, since 0 is meaningful (a Hardhat node does not
 * reorg) and a negative value is only ever a config slip.
 */
export function normalizeChainSettings(settings: ChainSettings): ChainSettings {
  const factory = safeAddress(settings.factory);
  if (factory === null) {
    throw new Error(`indexer: factory address ${String(settings.factory)} is malformed`);
  }
  if (!Number.isSafeInteger(settings.chainId)) {
    throw new Error(`indexer: chainId ${String(settings.chainId)} is not an integer`);
  }
  if (typeof settings.startBlock !== 'bigint' || settings.startBlock < ZERO) {
    throw new Error(`indexer: startBlock ${String(settings.startBlock)} is not a block number`);
  }
  const rpcUrl = typeof settings.rpcUrl === 'string' ? settings.rpcUrl.trim() : '';
  if (rpcUrl === '') throw new Error('indexer: rpcUrl is empty');
  return {
    chainId: settings.chainId,
    factory,
    startBlock: settings.startBlock,
    rpcUrl,
    confirmations:
      Number.isFinite(settings.confirmations) && settings.confirmations > 0
        ? Math.floor(settings.confirmations)
        : 0,
  };
}

// ---------------------------------------------------------------------------
// Settings, result shaping and error text
// ---------------------------------------------------------------------------

/**
 * Chain settings from config plus the committed deployments record.
 *
 * `startBlock` is REQUIRED here, unlike `lib/contracts.ts:getStartBlock`, which
 * falls back to block 0 for the browser's log sweep. Block 0 is a safe floor for
 * a cache-backed sweep but a terrible one for the indexer: it would anchor
 * `indexer_state.start_block` at 0 and make the real value a RAISE, which
 * `ensureIndexerState` refuses on purpose. Better to refuse the run and say why.
 */
function deploymentSettings(chainId: number, rpcUrl: string, confirmations: number): ChainSettings {
  const deployment = getDeployment(chainId);
  if (!deployment) {
    throw new Error(
      `indexer: no deployments entry for chain ${chainId}. Pass IndexRunOptions.chain ` +
        'to index a chain that is not in lib/deployments/index.json.'
    );
  }
  const startBlock = deployment.startBlock;
  if (typeof startBlock !== 'number' || !Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error(
      `indexer: chain ${chainId}'s deployments entry has no usable startBlock. Run ` +
        'discover:startblock, or pass IndexRunOptions.chain explicitly.'
    );
  }
  return normalizeChainSettings({
    chainId,
    factory: deployment.marketFactory,
    startBlock: BigInt(startBlock),
    rpcUrl,
    confirmations,
  });
}

/** An error's message, never its stack, and never an empty string. */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'unknown error';
}

/**
 * A lease owner id.
 *
 * Built from the reason plus time and randomness rather than `randomUUID`, which
 * would be the obvious choice but pulls in a runtime global this module has no
 * other need of. The lease is not a security boundary — `acquireLease`'s single
 * `UPDATE … WHERE` is what serializes runs — so an id only has to be unique
 * enough not to let one run release another's lease, and descriptive enough that
 * `/api/indexer/status` shows which kind of run is holding it.
 */
function leaseOwner(reason: IndexRunOptions['reason']): string {
  return `${reason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A result with nothing done. Every field explicit, so a new one cannot default. */
function emptyResult(from: bigint): IndexRunResult {
  return {
    ranBlocks: ZERO,
    fromBlock: from,
    // Below `fromBlock` on purpose: an empty range, not a range covering `from`.
    toBlock: from - ONE,
    eventsInserted: 0,
    requests: 0,
    skippedBecauseLeased: false,
    reorgDepth: 0,
    backfillComplete: false,
    error: null,
    budgetStopped: false,
    checksumFailures: 0,
    noProgress: false,
  };
}

/**
 * Write this run's accumulated notes to `last_error`, or clear it when there are
 * none.
 *
 * `recordError(chainId, null)` is the "ticked, nothing wrong" path: it stamps
 * `last_tick_at` so `/api/indexer/status` does not call a healthy idle chain
 * `stalled`, and clears a stale error because this run proved the indexer alive.
 * Anything in `notes` makes the same stamp report `degraded` instead — which is
 * the point: a tick is not the same claim as a healthy tick.
 */
async function flushNotes(chainId: number, notes: readonly string[]): Promise<void> {
  await recordError(chainId, notes.length > 0 ? notes.join(' | ') : null);
}

/**
 * A run that had a range to cover and committed none of it.
 *
 * Not an `error` — no request failed — and not merely `budgetStopped`, which
 * describes a run that committed something and stopped early. Zero progress on a
 * chain with blocks to index is a distinct fact, and left unmarked it stamps a
 * HEALTHY tick: repeated, that is a stuck indexer reporting as a working one.
 * So it is both a result flag and a `last_error` note.
 */
async function noProgressResult(
  chainId: number,
  notes: string[],
  what: string,
  result: IndexRunResult
): Promise<IndexRunResult> {
  const note = `${what} covered no contiguous range; the checkpoint did not move`;
  console.error(`[indexer] chain ${chainId}: ${note}`);
  notes.push(note);
  await flushNotes(chainId, notes);
  return { ...result, noProgress: true };
}

/**
 * Report a failure both ways: to the log, and to `indexer_state.last_error` so
 * `/api/indexer/status` reports `degraded`.
 *
 * ONLY SOUND AFTER `ensureIndexerState`. `recordError` is an
 * `UPDATE … WHERE chain_id = $1`: with no row it updates nothing and returns
 * happily, so a pre-bootstrap failure reported through it disappears without
 * trace. Its own failure is swallowed — the caller already has an error to
 * return, and replacing it with a secondary database error loses the diagnosis.
 */
async function reportError(chainId: number, err: unknown): Promise<string> {
  const error = messageOf(err);
  console.error(`[indexer] chain ${chainId} run failed:`, error);
  try {
    await recordError(chainId, error);
  } catch (recordErr) {
    console.error('[indexer] recordError also failed:', messageOf(recordErr));
  }
  return error;
}

/** Release the lease, never letting its own failure replace the run's result. */
async function releaseQuietly(chainId: number, owner: string): Promise<void> {
  try {
    await releaseLease(chainId, owner);
  } catch (err) {
    console.error(`[indexer] releasing the lease on chain ${chainId} failed:`, messageOf(err));
  }
}

/**
 * Store a range ceiling learned by a run that committed nothing.
 *
 * The committing path carries the ceiling inside `commitCheckpoint` instead. This
 * covers the case finding 4 is about: `acceptedSpan` non-null alongside
 * `coveredTo: null`, which is legitimate — a full-size chunk succeeded and then
 * the budget ended the sweep before any range was contiguously covered. The value
 * is folded through `nextChunkCeiling` first, never written raw.
 */
async function persistLearnedChunk(
  chainId: number,
  current: bigint | null,
  spans: readonly (bigint | null)[]
): Promise<void> {
  const learned = foldAcceptedChunk(current, spans);
  if (learned !== null) await saveAcceptedChunk(chainId, learned);
}

/**
 * Index one bounded range of one chain, and never throw.
 *
 * The order below is the whole design, and each step guards the next:
 * bootstrap (so errors have somewhere to land) → lease (so two runs cannot write
 * at once) → safe head (so the reorg-prone tip is never stored) → reorg check
 * (so a rewritten chain is truncated, not appended to) → range → two log sweeps
 * → headers for distinct blocks only → replay → ONE transaction → release.
 */
export async function runIndexer(opts: IndexRunOptions): Promise<IndexRunResult> {
  // -- Settings. No database, no network, so nothing here can be reported to
  // -- `last_error`: the state row may not exist yet.
  let settings: ChainSettings;
  let configuredChunk: bigint;
  try {
    const cfg = getIndexerConfig();
    settings = opts.chain
      ? normalizeChainSettings(opts.chain)
      : deploymentSettings(cfg.chainId, cfg.rpcUrl, cfg.confirmations);
    configuredChunk = cfg.chunkBlocks;
  } catch (err) {
    const error = messageOf(err);
    console.error('[indexer] cannot resolve chain settings:', error);
    return { ...emptyResult(ZERO), error };
  }

  const chainId = settings.chainId;

  // -- Bootstrap. Deliberately before anything that might need to report an
  // -- error: from here the state row exists, which is the only condition under
  // -- which `recordError` actually records anything.
  try {
    await ensureIndexerState(chainId, settings.factory, settings.startBlock);
  } catch (err) {
    const error = messageOf(err);
    console.error(`[indexer] bootstrap failed for chain ${chainId}:`, error);
    return { ...emptyResult(settings.startBlock), error };
  }

  // -- Lease. A null return is CONTENTION, not failure: do nothing at all and
  // -- exit. Not wait, not retry — the next tick is seconds away and a queue of
  // -- waiting serverless functions is how one slow run becomes a bill.
  const owner = leaseOwner(opts.reason);
  let leased: IndexerStateRow | null;
  try {
    leased = await acquireLease(chainId, owner, LEASE_SECONDS[opts.reason] ?? LEASE_SECONDS.manual);
  } catch (err) {
    return { ...emptyResult(settings.startBlock), error: await reportError(chainId, err) };
  }
  if (leased === null) {
    return { ...emptyResult(settings.startBlock), skippedBecauseLeased: true };
  }
  const state = leased;

  let requests = 0;
  let reorgDepth = 0;
  let cursor = state.lastIndexedBlock;
  let cursorHash = state.lastIndexedBlockHash;
  let backfillComplete = state.backfillComplete;
  /** True once a range exists to cover, so "committed nothing" becomes reportable. */
  let hadWork = false;
  /**
   * Facts worth `degraded` that are not failures: a reorg, replay drift, a run
   * that covered nothing. Written to `last_error` on EVERY exit path that reaches
   * the database, and always AFTER the range commit — `commitCheckpoint` clears
   * `last_error`, so a note written before it would be erased by the very
   * transaction it describes.
   */
  const notes: string[] = [];

  try {
    // Built INSIDE the try: `http()` and `createPublicClient` can throw, and
    // outside it that would be an unhandled rejection AND an orphaned lease —
    // breaking both non-negotiables at once. Nothing between `acquireLease` and
    // this `try` may fail.
    //
    // The remembered ceiling seeds the sweep width; `rpc.ts` shrinks it within this
    // object when the endpoint refuses a width and never grows it back. It comes
    // from `accepted_chunk` (per chain) or `INDEXER_CHUNK_BLOCKS`, NOT from
    // `IndexRunOptions.chain`: a range limit is a property of the ENDPOINT, and the
    // per-chain learned value already supersedes the configured one. The override
    // replaces the chain's identity, anchor, endpoint and finality window; the
    // sweep width and `DATABASE_URL` still come from config.
    const rpc = createIndexerRpc(settings.rpcUrl, state.acceptedChunk ?? configuredChunk, {
      // retryCount: 0 so `maxRequests` is a literal count of round trips rather
      // than a quarter of one — viem's http transport retries 3 times by default,
      // underneath `rpc.ts`'s own rate-limit ladder. The ladder still handles 429s;
      // what this removes is a silent 4x multiplier on every other failure.
      transport: http(settings.rpcUrl, { retryCount: 0 }),
    });

    const head = await rpc.getBlockNumber();
    requests += 1;
    const safeHead = computeSafeHead(head, settings.confirmations);

    // -- Reorg check. Re-read the checkpoint block's header and compare it with
    // -- the hash we stored for it. A match is the overwhelmingly common case and
    // -- costs exactly one request.
    if (cursorHash !== null && cursor >= ZERO) {
      const atCursor = await rpc.getBlockHeader(cursor);
      requests += 1;
      if (atCursor.hash !== cursorHash.toLowerCase()) {
        const candidates = await blocksAtOrBelow(chainId, cursor - ONE, MAX_REORG_WALKBACK);
        const probe = await probeReorgCut(rpc, candidates, cursor, settings.startBlock);
        requests += probe.requests;
        if (probe.cut === null) {
          // The disagreement is deeper than this indexer handles. Truncate NOTHING
          // and report: a valid ancestor may sit just past the bound, and deleting
          // a whole history because a probe was cut short is not a trade to make.
          throw new Error(
            `reorg probe on chain ${chainId} examined ${probe.examined} stored blocks below ` +
              `${cursor} and found the chain disagreeing deeper than ${MAX_REORG_WALKBACK} ` +
              'blocks. Nothing was truncated; re-index this chain deliberately.'
          );
        }
        const cut = probe.cut;
        const cutHash = probe.cutHash;
        reorgDepth = toCount(cursor - cut);
        // One transaction: rows above the cut and the checkpoint that describes
        // them must never disagree, not even for the width of a crash.
        await withTx(async (c) => {
          await truncateAbove(c, chainId, cut);
          await resetCheckpoint(c, chainId, cut, cutHash);
        });
        const note =
          `reorg on chain ${chainId}: block ${cursor} no longer matches its stored hash; ` +
          `cut at ${cut} (${reorgDepth} blocks, ${probe.reason}) and re-indexing forward`;
        // A rewind to the anchor re-does the entire backfill. Never quietly.
        notes.push(note);
        console.error(`[indexer] ${note}`);
        cursor = cut;
        cursorHash = cutHash;
        backfillComplete = false;
      }
    }

    // -- Range. One cursor, forward only.
    const range = clampRange(cursor, safeHead, opts.maxBlocks);
    if (range === null) {
      // Caught up — genuinely nothing to do, which is a healthy state and stays
      // one. Still a tick: without the stamp `/api/indexer/status` calls a healthy,
      // idle chain `stalled`.
      await flushNotes(chainId, notes);
      return { ...emptyResult(cursor + ONE), requests, reorgDepth, backfillComplete };
    }
    hadWork = true;

    // -- Two sweeps, one budget. The factory goes first because its
    // -- `MarketCreated` logs are what name the pool addresses to ask about; the
    // -- pool sweep then covers only as far as the factory sweep reached, so it
    // -- cannot spend a request on a span whose factory logs we do not have.
    const logBudget = Math.max(
      2,
      Number.isFinite(opts.maxRequests) ? Math.floor(opts.maxRequests) : 2
    );
    const factorySweep = await rpc.getLogsAdaptive({
      address: settings.factory,
      events: FACTORY_EVENTS,
      from: range.from,
      to: range.to,
      // Floor, not ceiling: the pool sweep must cover the same span at the same
      // chunk width, so it must never be the one left a request short.
      maxRequests: Math.floor(logBudget / 2),
    });
    requests += factorySweep.requests;
    let budgetStopped = factorySweep.budgetStopped;

    if (factorySweep.coveredTo === null) {
      // The budget ended the sweep before one range landed contiguously. Keep
      // whatever it learned about the endpoint's width limit — `acceptedSpan` can
      // be non-null here — or those requests bought nothing at all.
      await persistLearnedChunk(chainId, state.acceptedChunk, [factorySweep.acceptedSpan]);
      return await noProgressResult(chainId, notes, `factory sweep of [${range.from}, ${range.to}]`, {
        ...emptyResult(range.from),
        requests,
        reorgDepth,
        backfillComplete,
        budgetStopped: true,
      });
    }

    const poolToQuestion = await questionIdByFpmm(chainId);
    const factory = decodeFactoryLogs(factorySweep.logs);
    for (const market of factory.created) {
      poolToQuestion.set(market.fpmm.toLowerCase(), market.questionId);
    }

    // An EMPTY address array is refused by `getLogsAdaptive` on purpose (most
    // nodes read it as "no address filter" and would hand back those four topic0s
    // from every contract on the chain), so a chain with no markets yet simply has
    // no pool sweep — not a sweep with an empty filter.
    const pools = [...poolToQuestion.keys()];
    const poolSweep =
      pools.length === 0
        ? null
        : await rpc.getLogsAdaptive({
            address: pools,
            events: FPMM_EVENTS,
            from: range.from,
            to: factorySweep.coveredTo,
            maxRequests: Math.max(1, logBudget - factorySweep.requests),
          });
    if (poolSweep) {
      requests += poolSweep.requests;
      budgetStopped = budgetStopped || poolSweep.budgetStopped;
    }

    // The narrower of the two coverages, because the checkpoint may only claim a
    // range BOTH sweeps saw. Logs above it are dropped rather than stored: the
    // next run re-sweeps from the checkpoint, and an event stored above it would
    // be folded a second time onto a replay tail that already includes it, which
    // writes wrong reserves for every later event in that pool.
    const coverageTo = poolSweep ? poolSweep.coveredTo : factorySweep.coveredTo;
    if (coverageTo === null) {
      await persistLearnedChunk(chainId, state.acceptedChunk, [
        factorySweep.acceptedSpan,
        poolSweep ? poolSweep.acceptedSpan : null,
      ]);
      return await noProgressResult(chainId, notes, `pool sweep of [${range.from}, ${factorySweep.coveredTo}]`, {
        ...emptyResult(range.from),
        requests,
        reorgDepth,
        backfillComplete,
        budgetStopped: true,
      });
    }

    const created = atOrBelow(factory.created, coverageTo);
    const resolved = atOrBelow(factory.resolved, coverageTo);
    const poolEvents = atOrBelow(poolSweep ? decodeFpmmLogs(poolSweep.logs) : [], coverageTo);

    // -- Headers, once per DISTINCT event-bearing block and never once per event.
    // -- `knownBlockHeaders` is why "once per block" is once EVER and not once per
    // -- run: a block already in `blocks` is never re-fetched, and its stored time
    // -- still feeds `upsertMarkets` when a rewound checkpoint re-covers it.
    const stored = await knownBlockHeaders(chainId, range.from, coverageTo);
    const missing = missingBlockNumbers(
      distinctBlockNumbers([created, resolved, poolEvents]),
      new Set(stored.keys())
    );

    const cap = headerBudget(opts.maxRequests);
    let effectiveTo = coverageTo;
    let toFetch = missing;
    if (missing.length > cap) {
      // Commit up to the last block we hold a header for and let the next run
      // continue. `missing` is ascending, so a prefix of it is a contiguous
      // prefix of history — this is a smaller range, never a hole.
      toFetch = missing.slice(0, cap);
      effectiveTo = toFetch[toFetch.length - 1];
      budgetStopped = true;
      console.warn(
        `[indexer] chain ${chainId}: ${missing.length} new event-bearing blocks in ` +
          `[${range.from}, ${coverageTo}] exceeds the ${cap}-header budget. Committing up to ` +
          `${effectiveTo}; the next run continues from there.`
      );
    }

    const headers = new Map(stored);
    const fetched: BlockRow[] = [];
    for (const blockNumber of toFetch) {
      const header = await rpc.getBlockHeader(blockNumber);
      requests += 1;
      const row: BlockRow = {
        blockNumber,
        blockHash: header.hash,
        blockTime: blockTimeOf(header.timestamp),
      };
      headers.set(blockNumber.toString(), row);
      fetched.push(row);
    }

    // The checkpoint's witness hash must be FIRST-HAND. A header sitting in
    // `blocks` was read by an earlier run and, being above the old checkpoint, was
    // never covered by a reorg check — so it is re-read rather than trusted. The
    // extra call is only paid when the checkpoint block is not itself event-bearing
    // (the usual case) or when a rewound range re-covers a stored block. Its header
    // is NOT written to `blocks`: that table holds event-bearing blocks only.
    const fetchedHash = fetched.find((r) => r.blockNumber === effectiveTo)?.blockHash;
    let witness = fetchedHash;
    if (witness === undefined) {
      const header = await rpc.getBlockHeader(effectiveTo);
      requests += 1;
      witness = header.hash;
    }
    const checkpointHash = witness;

    // -- Replay, per market, seeded from the stored tail. `latestReplayState` is
    // -- what makes this resumable: reserves are a fold over the pool's whole
    // -- history, so without a stored tail every run would re-replay from the
    // -- pool's first LiquidityAdded.
    const finalCreated = atOrBelow(created, effectiveTo);
    const finalResolved = atOrBelow(resolved, effectiveTo);
    const grouped = groupEventsByMarket(atOrBelow(poolEvents, effectiveTo), poolToQuestion);

    const eventRows: MarketEventInsert[] = [];
    const drift: string[] = [];
    let checksumFailures = 0;

    for (const group of grouped.groups) {
      // Seeded from history strictly BELOW this range, not from the global tail:
      // see `latestReplayState`. In a normal forward-only run they are the same
      // row; when a checkpoint has been rewound without truncating they are not,
      // and the global tail would fold this range onto a state that includes it.
      const seed = (await latestReplayState(chainId, group.questionId, range.from)) ?? zeroState();
      for (const row of replay(seed, group.events)) {
        const header = headers.get(row.blockNumber.toString());
        if (!header) {
          throw new Error(
            `indexer: no block header for block ${row.blockNumber} (question ${group.questionId})`
          );
        }
        if (!row.checksumOk) {
          // `MarketEventInsert` has no column for this, so it would die here if it
          // were not logged and reported. A liquidity event carries a value fully
          // recomputable from pre-event state, so a mismatch is real evidence that
          // our reserves have drifted — a missed event, a missed reorg, or a wrong
          // start state. That is worth `degraded`, not a shrug.
          checksumFailures += 1;
          console.error(
            `[indexer] replay checksum mismatch: chain=${chainId} question=${group.questionId} ` +
              `fpmm=${row.fpmm} block=${row.blockNumber} logIndex=${row.logIndex} kind=${row.kind}`
          );
          if (drift.length < MAX_DRIFT_NOTES) {
            drift.push(`q${group.questionId}@${row.blockNumber}.${row.logIndex}:${row.kind}`);
          }
        }
        eventRows.push({
          blockNumber: row.blockNumber,
          logIndex: row.logIndex,
          txHash: row.txHash,
          questionId: group.questionId,
          fpmm: row.fpmm,
          kind: row.kind,
          actor: row.actor,
          outcome: row.outcome,
          collateral: row.collateral,
          shares: row.shares,
          reserveYes: row.reserveYes,
          reserveNo: row.reserveNo,
          totalSupply: row.totalSupply,
          yesBps: row.yesBps,
          // Passed through exactly as it arrived. 0 is a real execution price and
          // it is falsy; `|| null` here would draw a hole in the chart.
          execYesBps: row.execYesBps,
          blockTime: header.blockTime,
        });
      }
    }

    const times = new Map<string, Date>();
    for (const [key, row] of headers) times.set(key, row.blockTime);
    const learnedChunk = foldAcceptedChunk(state.acceptedChunk, [
      factorySweep.acceptedSpan,
      poolSweep ? poolSweep.acceptedSpan : null,
    ]);
    const reachedHead = effectiveTo >= safeHead;

    // -- ONE transaction. Either the whole range lands or none of it does, so the
    // -- checkpoint can never claim rows that are not there.
    const eventsInserted = await withTx(async (c) => {
      await upsertBlocks(c, chainId, atOrBelow(fetched, effectiveTo));
      // Markets before events for the reader's sake, NOT because the database
      // requires it: there is deliberately no foreign key between them, because a
      // pool's first Buy can share a block with its own MarketCreated and an FK
      // would reject a legitimate range. Do not add one.
      await upsertMarkets(c, chainId, finalCreated, times);
      await markResolved(c, chainId, finalResolved);
      const inserted = await insertMarketEvents(c, chainId, eventRows);
      await commitCheckpoint(c, chainId, effectiveTo, checkpointHash, learnedChunk, reachedHead);
      return inserted;
    });

    // AFTER the commit, deliberately: `commitCheckpoint` clears `last_error`, so a
    // note written before it would be erased by the very transaction that stored
    // the rows it is about. (This is also why a reorg note pushed earlier in this
    // run is only flushed here.)
    //
    // HOW LONG THE SIGNAL LASTS. `last_error` is cleared by the next successful
    // tick, so `degraded` is reported until then and no longer — there is no
    // checksum column to make it durable (`MarketEventInsert` deliberately has
    // none). The per-event `console.error` above is the permanent record, and
    // reconciling replayed reserves against a live `reserves()` call is the
    // durable check the design assigns to the cron path. Do not read a cleared
    // `last_error` as evidence the drift was resolved.
    if (checksumFailures > 0) {
      notes.push(`replay checksum mismatch on ${checksumFailures} event(s): ${drift.join(', ')}`);
    }
    if (grouped.orphans.length > 0) {
      // Should be unreachable: the address filter is built from the same map the
      // grouping consults. If it fires, a MarketCreated was dropped as unusable and
      // some pool's replay has a hole — a distinct fact from a checksum mismatch,
      // so it gets its own sentence rather than being folded into that count.
      console.error(
        `[indexer] chain ${chainId}: ${grouped.orphans.length} pool event(s) matched no known ` +
          'market and were NOT stored'
      );
      notes.push(`${grouped.orphans.length} pool event(s) could not be attributed to a market`);
    }
    await flushNotes(chainId, notes);

    return {
      ranBlocks: effectiveTo - range.from + ONE,
      fromBlock: range.from,
      toBlock: effectiveTo,
      eventsInserted,
      requests,
      skippedBecauseLeased: false,
      reorgDepth,
      backfillComplete: reachedHead,
      error: null,
      budgetStopped,
      checksumFailures,
      noProgress: false,
    };
  } catch (err) {
    // Every failure lands here, including a hard `getLogsAdaptive` rejection.
    // Nothing is committed: the logs from ranges the sweep had already covered are
    // discarded, which is WASTED WORK rather than lost data — the checkpoint never
    // moved, so the next run re-sweeps the same range. Partial progress on a hard
    // failure would have to be asked for explicitly, and is not, because a failing
    // endpoint is exactly when a half-swept range is least trustworthy.
    return {
      ...emptyResult(cursor + ONE),
      requests,
      reorgDepth,
      backfillComplete,
      // A failed run that had a range to cover advanced the checkpoint by zero
      // blocks, which is exactly what `noProgress` reports. `error` says why.
      noProgress: hadWork,
      error: await reportError(chainId, err),
    };
  } finally {
    await releaseQuietly(chainId, owner);
  }
}

/** The minimum a reorg probe needs from the RPC facade, so it can be stubbed. */
export interface BlockHeaderReader {
  getBlockHeader(n: bigint): Promise<{ hash: string; timestamp: bigint }>;
}

/** Where a reorg probe decided to cut, and on what grounds. */
export interface ReorgProbe {
  /** The cut, or null meaning DO NOT TRUNCATE — report instead. */
  cut: bigint | null;
  /** First-hand hash of `cut`, or null when it is the anchor (not a block we index). */
  cutHash: string | null;
  reason: 'verified-ancestor' | 'bounded-window' | 'no-indexed-data' | 'full-rewind' | 'too-deep';
  examined: number;
  requests: number;
}

/**
 * Decide where to cut after the checkpoint's hash stopped matching the chain.
 *
 * THE TRAP THIS EXISTS TO AVOID. `blocks` holds ONLY event-bearing blocks, so an
 * empty or far-below candidate list is the NORMAL state, not evidence that no
 * common ancestor exists. Reading it that way turns an ordinary one-block tip
 * reorg into a rewind to the anchor: on Arc testnet, with trades clustered near
 * 55.7M and the checkpoint past 57.3M, cutting at "the highest stored block that
 * still matches" throws away 1.6M blocks of sweep progress, and cutting at the
 * anchor when nothing is stored yet throws away all 1.7M. Neither loses data —
 * every write is idempotent — but both silently redo the whole backfill, and
 * silent-and-total is the failure class this project has already shipped twice.
 *
 * WHAT MAKES A CUT SOUND. Two things must hold for every block at or below it:
 * any stored hash still matches the chain, and the implicit claim "this block was
 * scanned" is still true. A verified stored hash proves BOTH for everything below
 * it (a fork underneath would have changed that hash). Where there is no stored
 * hash there is no proof, so the cut rests on `MAX_REORG_WALKBACK` as a maximum
 * fork depth — stated, 21x `confirmations`, and contradicted loudly rather than
 * assumed away: a stored block that disagrees from deeper than the bound returns
 * `too-deep` and truncates nothing.
 *
 * `candidates` must be the stored blocks at or below `cursor - 1`, HIGHEST FIRST,
 * at most `MAX_REORG_WALKBACK` of them — `blocksAtOrBelow` returns exactly that.
 * It is a parameter rather than a query so the decision is testable offline.
 */
export async function probeReorgCut(
  rpc: BlockHeaderReader,
  candidates: readonly BlockRow[],
  cursor: bigint,
  anchor: bigint
): Promise<ReorgProbe> {
  const depthFloor = cursor - BigInt(MAX_REORG_WALKBACK);
  const atAnchor = anchor - ONE;
  let requests = 0;
  let examined = 0;
  let verified: bigint | null = null;
  let verifiedHash: string | null = null;
  let lowestMismatch: bigint | null = null;

  for (const candidate of candidates) {
    examined += 1;
    const header = await rpc.getBlockHeader(candidate.blockNumber);
    requests += 1;
    if (header.hash === candidate.blockHash.toLowerCase()) {
      verified = candidate.blockNumber;
      verifiedHash = header.hash;
      break;
    }
    // Descending, so this keeps getting lower and ends at the deepest disagreement.
    lowestMismatch = candidate.blockNumber;
  }

  // A disagreement deeper than the bound contradicts it. Report; truncate nothing.
  if (lowestMismatch !== null && lowestMismatch <= depthFloor) {
    return { cut: null, cutHash: null, reason: 'too-deep', examined, requests };
  }
  // The probe ran out of budget before finding an ancestor: same answer, and for
  // the same reason — there may be a valid ancestor just past the bound, and
  // deleting a whole history because a walk was cut short is not a trade to make.
  if (verified === null && candidates.length >= MAX_REORG_WALKBACK) {
    return { cut: null, cutHash: null, reason: 'too-deep', examined, requests };
  }

  // Highest sound cut: a verified ancestor if it is above the bound, else the
  // bound itself. Mismatches (all above `depthFloor` by the guard) cap it, and it
  // can never fall below the anchor.
  //
  // Note that finding NO match is not a reason to rewind further. Every mismatch
  // sits above `depthFloor`, and with fewer than `MAX_REORG_WALKBACK` candidates
  // that list is COMPLETE — so nothing we hold at or below `depthFloor` is in
  // question, and cutting there deletes exactly the invalid rows. The anchor is
  // reached only when the checkpoint is itself within the bound of it, i.e. when
  // the whole indexed span is inside the reorg window.
  const base = verified !== null && verified > depthFloor ? verified : depthFloor;
  const capped = lowestMismatch === null ? base : base < lowestMismatch - ONE ? base : lowestMismatch - ONE;
  const cut = capped < atAnchor ? atAnchor : capped;

  if (cut === atAnchor) {
    return { cut, cutHash: null, reason: 'full-rewind', examined, requests };
  }
  if (verified !== null && cut === verified) {
    return { cut, cutHash: verifiedHash, reason: 'verified-ancestor', examined, requests };
  }
  // No stored hash for this block, so read one first-hand for the next run's witness.
  const header = await rpc.getBlockHeader(cut);
  requests += 1;
  return {
    cut,
    cutHash: header.hash,
    reason: candidates.length === 0 ? 'no-indexed-data' : 'bounded-window',
    examined,
    requests,
  };
}
