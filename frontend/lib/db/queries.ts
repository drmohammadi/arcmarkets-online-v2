/**
 * The ONLY file in the indexer that contains SQL.
 *
 * WHY ONE FILE. Every statement here is parameterized — `$1`, `$2`, … always,
 * with no exception and no string interpolation of caller data, ever. Keeping
 * them in one module makes that claim auditable by reading a single file
 * instead of grepping route handlers. Column lists and `VALUES` skeletons ARE
 * composed as strings, but only from constants declared in this file: a row
 * count and a fixed column list decide the shape, and every value travels as a
 * bound parameter.
 *
 * MUTUAL EXCLUSION IS A LEASE ROW, NOT `pg_advisory_lock`. This is the opposite
 * choice from `db/migrate.ts`, deliberately, and the two must NOT be unified:
 *
 *  - `migrate.ts` is a one-shot CLI that holds a dedicated `Client` for its
 *    entire life, so a transaction-scoped advisory lock fits perfectly and is
 *    released by COMMIT/ROLLBACK.
 *  - This module runs inside serverless functions behind Neon's
 *    transaction-mode pooler. There is no session affinity — two runs can be
 *    multiplexed onto one backend, where a session lock on the same key is a
 *    recursive re-acquire that succeeds instantly and serializes nothing — and
 *    a function killed mid-run (timeout, redeploy, OOM) releases no lock of any
 *    scope, wedging the indexer until someone notices. A lease row EXPIRES BY
 *    ITSELF, and it is visible to `/api/indexer/status`, so a stuck run is
 *    diagnosable rather than silent.
 *
 * Each is wrong in the other's setting.
 *
 * IDEMPOTENCY DOES NOT DEPEND ON THE LEASE. `insertMarketEvents` ends with
 * `ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`, so two runs
 * that somehow overlap write each row once regardless. A lease that failed
 * open would cost duplicated work, never duplicated rows.
 *
 * `numeric(78,0)` and `bigint` come back from `pg` as STRINGS (they do not fit
 * a JS `number`), and every one of them is converted with `BigInt(...)` at this
 * boundary. No amount and no block number is ever a `number` above this line.
 *
 * NOTE ON `markets` VS `market_events`/`blocks`: there is deliberately no
 * foreign key between them (`001_init.sql`), because a pool's first `Buy` can
 * share a block with its own `MarketCreated`. Nothing here assumes markets are
 * inserted first, and nothing here should ever add that constraint.
 */

import type { PoolClient } from 'pg';
import type { MarketCreatedRow, MarketResolvedRow } from '../indexer/decode';
import type { EventKind, PoolState } from '../indexer/replay';
import { getPool } from './pool';

/**
 * Postgres refuses a statement with more than 65535 bound parameters (the wire
 * protocol counts them in an int16). Batch sizes are derived from it rather
 * than assumed: see `rowsPerStatement`.
 */
const MAX_BIND_PARAMS = 65535;

/**
 * Rows per statement, before the parameter bound is applied. Neon round trips
 * dominate the cost of a write, so one statement per row would be pathological
 * — a 5000-event range would be 5000 round trips instead of 10. The ceiling is
 * kept at 500 rather than pushed to the parameter limit because a single
 * multi-megabyte statement is its own hazard (parse time, memory, and a
 * failure that costs the whole batch).
 */
const MAX_ROWS_PER_STATEMENT = 500;

/**
 * How many rows of `columns` columns may share one statement.
 *
 * `market_events` binds 17 parameters per row, so the parameter bound allows
 * floor(65535 / 17) = 3855 rows and the 500-row policy ceiling wins: 500 x 17 =
 * 8500 parameters, comfortably inside the protocol limit. Computed rather than
 * hard-coded so that adding a column can never silently push a batch over the
 * edge — the batch shrinks instead.
 */
function rowsPerStatement(columns: number): number {
  return Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_BIND_PARAMS / columns)));
}

/** Split `rows` into consecutive groups of at most `size`. */
function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * A multi-row `VALUES` skeleton: `($1,$2),($3,$4)`.
 *
 * `shape` holds one expression per column with `?` standing for that column's
 * bound parameter, so a column needing a cast or a conversion function can say
 * so (`to_timestamp(?::double precision)`) while its VALUE still arrives as a
 * parameter. `shape` is only ever a constant declared in this file — it is
 * never built from caller input, which is what keeps the no-interpolation rule
 * intact.
 */
function valuesClause(rowCount: number, shape: readonly string[], firstParam = 1): string {
  const rows: string[] = [];
  let p = firstParam;
  for (let r = 0; r < rowCount; r += 1) {
    const cols: string[] = [];
    for (const expr of shape) {
      cols.push(expr.replace('?', `$${p}`));
      p += 1;
    }
    rows.push(`(${cols.join(',')})`);
  }
  return rows.join(',');
}

/** `?` repeated `n` times — the shape of a table whose columns need no casts. */
function plainShape(n: number): string[] {
  return new Array<string>(n).fill('?');
}

/** A `bigint`/`numeric` column as `pg` returns it: a string. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** As above, preserving SQL NULL. */
function toBigIntOrNull(value: string | number | bigint | null): bigint | null {
  return value === null ? null : toBigInt(value);
}

/**
 * The largest unix second `timestamptz` can hold (9999-12-31T23:59:59Z).
 *
 * `resolution_time` arrives as a uint256 from a log, so it can be a value no
 * timestamp can represent. `to_timestamp()` on such a value raises, and inside
 * the indexer's single commit transaction that would abort the WHOLE range —
 * permanently, since every later run re-reads the same log and fails the same
 * way. Clamping stores a wrong-but-bounded resolution date for a market whose
 * own creator wrote nonsense, and keeps the pipeline alive for every other
 * market in the range. `resolution_time` plays no part in the replay or the
 * chart, so nothing downstream depends on it being exact.
 */
const MAX_TIMESTAMP_SECONDS = BigInt('253402300799');

/**
 * Clamp is the right trade here, but it must never be SILENT: a market whose
 * displayed resolution date is not the one the chain recorded is a real (if
 * minor) discrepancy, and the only way anyone learns of it is this line. Warns
 * only when a clamp actually fires, so a normal range logs nothing.
 */
function clampResolutionSeconds(value: bigint, chainId: number, questionId: bigint): bigint {
  if (value >= BigInt(0) && value <= MAX_TIMESTAMP_SECONDS) return value;
  const clamped = value < BigInt(0) ? BigInt(0) : MAX_TIMESTAMP_SECONDS;
  console.warn(
    `upsertMarkets: resolution_time ${value} is outside timestamptz range ` +
      `(chain ${chainId}, question ${questionId}); stored as ${clamped}`
  );
  return clamped;
}

/** Errors are stored for an operator to read, not to archive. */
const MAX_ERROR_CHARS = 2000;

// ---------------------------------------------------------------------------
// Row types. Each mirrors its table's columns exactly — same names, same
// order, one field per column — so a schema change and a type change are the
// same edit rather than two edits that can drift apart.
// ---------------------------------------------------------------------------

/** `indexer_state`, as `acquireLease` and `readIndexerState` return it. */
export interface IndexerStateRow {
  chainId: number;
  startBlock: bigint;
  lastIndexedBlock: bigint;
  lastIndexedBlockHash: string | null;
  backfillComplete: boolean;
  acceptedChunk: bigint | null;
  lastTickAt: Date | null;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  lastError: string | null;
}

/** One row of `blocks`: a block that CONTAINS indexed events, never every block. */
export interface BlockRow {
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
}

/**
 * One row of `market_events`, one field per column (`chain_id` excepted — it is
 * a parameter of the call, not of the row).
 *
 * `execYesBps` is `number | null` and **0 IS A LEGITIMATE VALUE**: an
 * `outcome === 1` trade filled at 10000 bps on the NO side is 0 on the YES
 * side, which is reachable on-chain. Zero is falsy, so `execYesBps || null`
 * would convert a real execution price into "no execution price" and draw a
 * hole in the chart with nothing raised anywhere. Nothing in this file
 * coalesces it; `contracts/test/IndexerDb.test.ts` asserts the round trip.
 */
export interface MarketEventInsert {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  questionId: bigint;
  fpmm: string;
  kind: EventKind;
  actor: string;
  outcome: 0 | 1 | null;
  collateral: bigint;
  shares: bigint;
  reserveYes: bigint;
  reserveNo: bigint;
  totalSupply: bigint;
  yesBps: number;
  execYesBps: number | null;
  blockTime: Date;
}

/**
 * The `indexer_state` columns every read of that table returns, as one
 * constant so `acquireLease`'s RETURNING and `readIndexerState`'s SELECT cannot
 * drift. `factory_address` is deliberately absent: the factory is authoritative
 * in `lib/deployments/index.json`, and a second copy that callers read from
 * would be a second source of truth.
 */
const STATE_COLUMNS = `chain_id, start_block, last_indexed_block, last_indexed_block_hash,
          backfill_complete, accepted_chunk, last_tick_at, lease_until, lease_owner, last_error`;

/** `indexer_state` exactly as `pg` hands it back. */
interface RawStateRow {
  chain_id: string;
  start_block: string;
  last_indexed_block: string;
  last_indexed_block_hash: string | null;
  backfill_complete: boolean;
  accepted_chunk: string | null;
  last_tick_at: Date | null;
  lease_until: Date | null;
  lease_owner: string | null;
  last_error: string | null;
}

function toStateRow(raw: RawStateRow): IndexerStateRow {
  return {
    // chain_id is a Postgres bigint, so it arrives as a string. It is a chain
    // id, not an amount, so Number is exact and is what every caller wants.
    chainId: Number(raw.chain_id),
    startBlock: toBigInt(raw.start_block),
    lastIndexedBlock: toBigInt(raw.last_indexed_block),
    lastIndexedBlockHash: raw.last_indexed_block_hash,
    backfillComplete: raw.backfill_complete,
    acceptedChunk: toBigIntOrNull(raw.accepted_chunk),
    lastTickAt: raw.last_tick_at,
    leaseUntil: raw.lease_until,
    leaseOwner: raw.lease_owner,
    lastError: raw.last_error,
  };
}

// ---------------------------------------------------------------------------
// indexer_state: bootstrap, lease, checkpoint, error
// ---------------------------------------------------------------------------

/**
 * Create this chain's state row if it is absent, and reconcile it with the
 * configured factory and anchor.
 *
 * `last_indexed_block` starts at `start_block - 1`, so the first range begins
 * exactly at the factory's deploy block: the anchor CLAUDE.md insists on, and
 * an exact bound rather than a guess, because no market event can predate the
 * factory. (A `start_block` of 0 — the local Hardhat case — gives -1, which a
 * Postgres bigint stores without complaint.)
 *
 * The factory is CHECKED, never overwritten. Every indexed row belongs to the
 * factory that emitted it; quietly re-pointing the row at a redeployed factory
 * would blend two histories into one chart with no symptom but wrong prices.
 * Redeploying the factory means the indexed data is about a chain state that no
 * longer exists, and clearing it is a deliberate operator act, not a side
 * effect of a boot check.
 *
 * The anchor is RECONCILED, and never silently ignored — CLAUDE.md's twice-bitten
 * rule is that "a floor above the real deploy block is worse than none: it hides
 * trades silently", so a state row that disagrees with the configured anchor
 * must produce an action and a log line, not a no-op.
 */
export async function ensureIndexerState(
  chainId: number,
  factory: string,
  startBlock: bigint
): Promise<void> {
  const wanted = factory.toLowerCase();
  const res = await getPool().query<{
    factory_address: string;
    start_block: string;
    last_indexed_block: string;
  }>(
    `INSERT INTO indexer_state (chain_id, factory_address, start_block, last_indexed_block)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain_id) DO UPDATE SET updated_at = now()
       RETURNING factory_address, start_block, last_indexed_block`,
    [chainId, wanted, startBlock.toString(), (startBlock - BigInt(1)).toString()]
  );
  const row = res.rows[0];
  const stored = (row?.factory_address ?? '').toLowerCase();
  if (stored !== wanted) {
    throw new Error(
      `indexer_state for chain ${chainId} was built for factory ${stored}, not ${wanted} — ` +
        'clear this chain\'s indexed rows deliberately before re-pointing it'
    );
  }
  await reconcileStartBlock(chainId, startBlock, toBigInt(row.start_block));
}

/**
 * Bring a stored anchor into line with the configured one, loudly.
 *
 * LOWERING IS APPLIED. A smaller anchor is strictly more history, and it cannot
 * corrupt anything: the sweep is forward-only from `last_indexed_block`, the
 * primary key makes every re-read of a block idempotent, and no event can
 * predate the factory's real deploy block whatever we record here.
 *
 * It also moves `last_indexed_block` down to the new floor — but ONLY while the
 * row is still untouched (`last_indexed_block <= start_block - 1`), which is the
 * case that matters: an operator who spots a wrong anchor and fixes it before
 * the backfill has begun gets the corrected history, instead of a correction
 * that changes nothing. On a chain already mid-backfill the checkpoint is left
 * alone deliberately — dragging it below already-indexed blocks would make the
 * run loop re-discover early events and fold them onto a LATER replay tail,
 * writing wrong reserves. Re-indexing such a chain is an operator procedure
 * (Task 14's runbook), and the log line below says so.
 *
 * RAISING IS REFUSED. Raising the floor is precisely the silent-truncation case:
 * it can only hide trades. It is refused rather than thrown on because it cannot
 * corrupt data — the checkpoint, not the anchor, decides what is scanned — and
 * wedging the whole indexer over a config edit would be a worse failure than a
 * loud refusal.
 */
async function reconcileStartBlock(
  chainId: number,
  configured: bigint,
  stored: bigint
): Promise<void> {
  if (configured === stored) return;

  if (configured > stored) {
    console.error(
      `indexer_state: REFUSING to raise chain ${chainId}'s start_block from ${stored} to ` +
        `${configured}. A floor above the real deploy block hides trades silently. ` +
        'The stored anchor is unchanged; correct the deployments entry or reset this chain.'
    );
    return;
  }

  const res = await getPool().query<{ last_indexed_block: string }>(
    `UPDATE indexer_state
        SET start_block = $2,
            last_indexed_block =
              CASE WHEN last_indexed_block <= start_block - 1
                   THEN $2::bigint - 1
                   ELSE last_indexed_block END,
            updated_at = now()
      WHERE chain_id = $1
    RETURNING last_indexed_block`,
    [chainId, configured.toString()]
  );
  const checkpoint = toBigIntOrNull(res.rows[0]?.last_indexed_block ?? null);
  const rewound = checkpoint !== null && checkpoint === configured - BigInt(1);
  console.warn(
    `indexer_state: lowered chain ${chainId}'s start_block from ${stored} to ${configured}` +
      (rewound
        ? ' and rewound the checkpoint to the new floor (nothing was indexed yet).'
        : `. The checkpoint stays at ${checkpoint}: blocks below it are NOT re-scanned ` +
          'automatically, because re-discovered early events would be replayed onto a later ' +
          'tail. Re-index this chain deliberately to pick up the earlier history.')
  );
}

/**
 * Take the run lease, or return null when another run holds it.
 *
 * One UPDATE does the test and the take together, so two simultaneous callers
 * cannot both pass the check: the row lock serializes them and the loser's
 * WHERE no longer matches. A null return means "another run is working" and the
 * caller must do nothing at all and exit — not wait, not retry. The next tick
 * is seconds away, and a queue of waiting serverless functions is how a fleet
 * turns one slow run into a bill.
 *
 * An expired lease is simply taken (`lease_until < now()`), which is the whole
 * point of a lease over a lock: a run killed mid-flight blocks nothing beyond
 * its own expiry.
 *
 * A MISSING STATE ROW IS NOT A CONTENDED LEASE, and the two must not share the
 * `null`: an un-bootstrapped chain would otherwise look permanently busy, and
 * the indexer would report "another run has it" forever with no other run in
 * existence. It cannot happen after `ensureIndexerState`, so it means the row
 * was deleted underneath us or the caller skipped the bootstrap — a loud error
 * that `recordError` puts in `/api/indexer/status`'s `lastError`, rather than a
 * silence that looks like healthy contention. The extra round trip is only paid
 * on the rare no-take path.
 */
export async function acquireLease(
  chainId: number,
  owner: string,
  seconds: number
): Promise<IndexerStateRow | null> {
  // A garbage interval would either be rejected by Postgres or, worse, produce
  // a lease that never expires. Bound it here.
  const secs = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.floor(seconds))) : 60;
  const res = await getPool().query<RawStateRow>(
    `UPDATE indexer_state
        SET lease_until = now() + make_interval(secs => $3::double precision),
            lease_owner = $2,
            updated_at = now()
      WHERE chain_id = $1
        AND (lease_until IS NULL OR lease_until < now())
    RETURNING ${STATE_COLUMNS}`,
    [chainId, owner, secs]
  );
  const row = res.rows[0];
  if (row) return toStateRow(row);
  const exists = await getPool().query(
    'SELECT 1 FROM indexer_state WHERE chain_id = $1',
    [chainId]
  );
  if ((exists.rowCount ?? 0) === 0) {
    throw new Error(
      `acquireLease: no indexer_state row for chain ${chainId} — ` +
        'call ensureIndexerState first (this is not a contended lease)'
    );
  }
  return null;
}

/**
 * Release the lease — but only if we still hold it.
 *
 * The `lease_owner = $2` guard matters: a run that overran its lease must not
 * release the lease of the run that legitimately took over from it, which would
 * let a third run start alongside that one.
 */
export async function releaseLease(chainId: number, owner: string): Promise<void> {
  await getPool().query(
    `UPDATE indexer_state
        SET lease_until = NULL, lease_owner = NULL, updated_at = now()
      WHERE chain_id = $1 AND lease_owner = $2`,
    [chainId, owner]
  );
}

/** This chain's state, or null when it has never been indexed. */
export async function readIndexerState(chainId: number): Promise<IndexerStateRow | null> {
  const res = await getPool().query<RawStateRow>(
    `SELECT ${STATE_COLUMNS} FROM indexer_state WHERE chain_id = $1`,
    [chainId]
  );
  const row = res.rows[0];
  return row ? toStateRow(row) : null;
}

/**
 * Advance the checkpoint. Takes a client because it MUST commit in the same
 * transaction as the rows it describes — a checkpoint ahead of its rows is a
 * permanent hole, since the next run starts above the blocks that were lost.
 *
 * `accepted_chunk` is COALESCEd rather than assigned: `null` means "this run
 * learned nothing new about the endpoint's range limit", and storing that null
 * would throw away a ceiling we already paid requests to discover. The
 * monotonic-ceiling rule from `lib/indexer/chunking.ts` lives on the caller's
 * side; this statement only refuses to forget.
 *
 * A committed range is also a successful tick, so `last_error` is cleared and
 * `last_tick_at` refreshed here. Otherwise one transient failure would leave
 * `/api/indexer/status` reporting `degraded` forever while the indexer worked
 * perfectly.
 */
export async function commitCheckpoint(
  c: PoolClient,
  chainId: number,
  block: bigint,
  hash: string,
  acceptedChunk: bigint | null,
  backfillComplete: boolean
): Promise<void> {
  await c.query(
    `UPDATE indexer_state
        SET last_indexed_block = $2,
            last_indexed_block_hash = $3,
            accepted_chunk = COALESCE($4::bigint, accepted_chunk),
            backfill_complete = $5,
            last_error = NULL,
            last_tick_at = now(),
            updated_at = now()
      WHERE chain_id = $1`,
    [chainId, block.toString(), hash, acceptedChunk === null ? null : acceptedChunk.toString(), backfillComplete]
  );
}

/**
 * Record (or clear) the last error, and stamp the tick.
 *
 * `recordError(chainId, null)` is also the "ticked, nothing to do" path: a run
 * that finds no new blocks still proves the indexer is alive, and without the
 * stamp `/api/indexer/status` would call a perfectly healthy but idle chain
 * `stalled`. Runs on the pool, not on a transaction client, because the error
 * must survive the rollback of the transaction that failed.
 */
export async function recordError(chainId: number, message: string | null): Promise<void> {
  await getPool().query(
    `UPDATE indexer_state
        SET last_error = $2, last_tick_at = now(), updated_at = now()
      WHERE chain_id = $1`,
    [chainId, message === null ? null : message.slice(0, MAX_ERROR_CHARS)]
  );
}

// ---------------------------------------------------------------------------
// blocks: the timestamp cache and the reorg witness
// ---------------------------------------------------------------------------

const BLOCK_COLUMNS = 4;

/**
 * Store the headers of event-bearing blocks.
 *
 * `DO UPDATE` rather than `DO NOTHING`: a header we have just fetched is, by
 * definition, what the chain says now, so overwriting a stale one self-heals a
 * row that a reorg truncation somehow missed. Keeping a stale hash would poison
 * the very comparison the reorg check depends on.
 */
export async function upsertBlocks(
  c: PoolClient,
  chainId: number,
  rows: BlockRow[]
): Promise<void> {
  const shape = plainShape(BLOCK_COLUMNS);
  for (const batch of chunkRows(rows, rowsPerStatement(BLOCK_COLUMNS))) {
    const params: unknown[] = [];
    for (const r of batch) {
      params.push(chainId, r.blockNumber.toString(), r.blockHash.toLowerCase(), r.blockTime);
    }
    await c.query(
      `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
            VALUES ${valuesClause(batch.length, shape)}
       ON CONFLICT (chain_id, block_number)
       DO UPDATE SET block_hash = EXCLUDED.block_hash, block_time = EXCLUDED.block_time`,
      params
    );
  }
}

/** The stored hash of one block, or null when we have never indexed it. */
export async function getBlockHash(chainId: number, blockNumber: bigint): Promise<string | null> {
  const res = await getPool().query<{ block_hash: string }>(
    'SELECT block_hash FROM blocks WHERE chain_id = $1 AND block_number = $2',
    [chainId, blockNumber.toString()]
  );
  return res.rows[0]?.block_hash ?? null;
}

// ---------------------------------------------------------------------------
// markets
// ---------------------------------------------------------------------------

/**
 * `resolution_time` is the one column that needs a conversion function: the log
 * carries unix seconds as a uint256 and the column is `timestamptz`. The VALUE
 * still arrives as a bound parameter — only the conversion is in the SQL.
 */
const MARKET_SHAPE = [
  '?', // chain_id
  '?', // question_id
  '?', // fpmm
  '?', // condition_id
  '?', // question
  '?', // category
  'to_timestamp(?::double precision)', // resolution_time
  '?', // resolver
  '?', // fee_bps
  '?', // created_block
  '?', // created_at
];

/**
 * Insert markets seen in this range, or refresh them if they are already known.
 *
 * `times` maps `blockNumber.toString()` to that block's timestamp, supplied by
 * the caller because it has already fetched every header once (one `getBlock`
 * per distinct block, never one per event). A MISSING entry throws rather than
 * inventing a `created_at`: a wrong creation time is indistinguishable from a
 * right one after the fact, and the throw aborts the range transaction, so the
 * next run simply re-fetches it.
 *
 * The conflict update deliberately touches ONLY the `MarketCreated` fields.
 * `resolved`, `resolved_block` and the payouts belong to `markResolved`, and
 * resetting them here would un-resolve a market every time its creation log was
 * re-indexed — which a reorg replay does routinely.
 */
export async function upsertMarkets(
  c: PoolClient,
  chainId: number,
  rows: MarketCreatedRow[],
  times: Map<string, Date>
): Promise<void> {
  for (const batch of chunkRows(rows, rowsPerStatement(MARKET_SHAPE.length))) {
    const params: unknown[] = [];
    for (const r of batch) {
      const createdAt = times.get(r.blockNumber.toString());
      if (!createdAt) {
        throw new Error(
          `upsertMarkets: no block time for block ${r.blockNumber} (question ${r.questionId})`
        );
      }
      params.push(
        chainId,
        r.questionId.toString(),
        r.fpmm.toLowerCase(),
        r.conditionId.toLowerCase(),
        r.question,
        r.category,
        clampResolutionSeconds(r.resolutionTime, chainId, r.questionId).toString(),
        r.resolver.toLowerCase(),
        r.feeBps,
        r.blockNumber.toString(),
        createdAt
      );
    }
    await c.query(
      `INSERT INTO markets (chain_id, question_id, fpmm, condition_id, question, category,
                            resolution_time, resolver, fee_bps, created_block, created_at)
            VALUES ${valuesClause(batch.length, MARKET_SHAPE)}
       ON CONFLICT (chain_id, question_id) DO UPDATE
               SET fpmm = EXCLUDED.fpmm,
                   condition_id = EXCLUDED.condition_id,
                   question = EXCLUDED.question,
                   category = EXCLUDED.category,
                   resolution_time = EXCLUDED.resolution_time,
                   resolver = EXCLUDED.resolver,
                   fee_bps = EXCLUDED.fee_bps,
                   created_block = EXCLUDED.created_block,
                   created_at = EXCLUDED.created_at,
                   updated_at = now()`,
      params
    );
  }
}

/**
 * Every value in a `VALUES` list feeding an UPDATE needs an explicit type: a
 * bound parameter there has no target column to infer from, so Postgres would
 * treat it as `text` and then refuse to compare it with a bigint column. Cast on
 * every row rather than only the first — uniform is harder to get wrong.
 */
const RESOLVED_SHAPE = ['?::bigint', '?::bigint', '?::numeric', '?::numeric'];

/**
 * Mark resolved markets and store their payouts.
 *
 * One statement per batch via `UPDATE … FROM (VALUES …)` rather than one round
 * trip per row — resolutions are rare, but the shape should not depend on that
 * staying true.
 *
 * A row that matches no market updates nothing, silently and correctly: there
 * is no FK to violate, and `MarketResolved` cannot precede its market's
 * `MarketCreated` on-chain, so the only way to see one without the other is a
 * chain whose creation block sits below `start_block` — a market we were never
 * asked to index.
 */
export async function markResolved(
  c: PoolClient,
  chainId: number,
  rows: MarketResolvedRow[]
): Promise<void> {
  for (const batch of chunkRows(rows, rowsPerStatement(RESOLVED_SHAPE.length))) {
    const params: unknown[] = [chainId];
    for (const r of batch) {
      params.push(
        r.questionId.toString(),
        r.blockNumber.toString(),
        r.payoutYes.toString(),
        r.payoutNo.toString()
      );
    }
    await c.query(
      `UPDATE markets AS m
          SET resolved = true,
              resolved_block = v.resolved_block,
              payout_yes = v.payout_yes,
              payout_no = v.payout_no,
              updated_at = now()
         FROM (VALUES ${valuesClause(batch.length, RESOLVED_SHAPE, 2)})
              AS v(question_id, resolved_block, payout_yes, payout_no)
        WHERE m.chain_id = $1 AND m.question_id = v.question_id`,
      params
    );
  }
}

/** `chain_id` plus the 16 fields of `MarketEventInsert`. */
const EVENT_COLUMNS = 17;

/**
 * Append replayed events. Returns how many rows were actually written.
 *
 * `ON CONFLICT … DO NOTHING` is the idempotency guarantee, and it is
 * INDEPENDENT of the lease: a double-run, a retry after a timeout, or a
 * re-scanned range writes each `(chain_id, block_number, log_index)` once.
 * `DO NOTHING` rather than `DO UPDATE` because the primary key identifies a
 * specific log on a specific chain — if its replayed reserves were to differ on
 * a second pass, overwriting would hide the discrepancy instead of leaving the
 * first-written truth in place for `latestReplayState` and the e2e proof to
 * compare against. Reorg handling deletes rows explicitly (`truncateAbove`); it
 * does not rely on overwriting them.
 *
 * The returned count is the caller's log line, and it is what makes
 * "the second run inserted 0 rows" an assertion rather than a hope.
 */
export async function insertMarketEvents(
  c: PoolClient,
  chainId: number,
  rows: MarketEventInsert[]
): Promise<number> {
  const shape = plainShape(EVENT_COLUMNS);
  let inserted = 0;
  for (const batch of chunkRows(rows, rowsPerStatement(EVENT_COLUMNS))) {
    const params: unknown[] = [];
    for (const r of batch) {
      params.push(
        chainId,
        r.blockNumber.toString(),
        r.logIndex,
        r.txHash.toLowerCase(),
        r.questionId.toString(),
        r.fpmm.toLowerCase(),
        r.kind,
        r.actor.toLowerCase(),
        r.outcome,
        r.collateral.toString(),
        r.shares.toString(),
        r.reserveYes.toString(),
        r.reserveNo.toString(),
        r.totalSupply.toString(),
        r.yesBps,
        // NOT `r.execYesBps || null`. 0 is a real execution price; see
        // MarketEventInsert. Passed through exactly as it arrived.
        r.execYesBps,
        r.blockTime
      );
    }
    const res = await c.query(
      `INSERT INTO market_events (chain_id, block_number, log_index, tx_hash, question_id, fpmm,
                                  kind, actor, outcome, collateral, shares, reserve_yes,
                                  reserve_no, total_supply, yes_bps, exec_yes_bps, block_time)
            VALUES ${valuesClause(batch.length, shape)}
       ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`,
      params
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Reads the run loop depends on
// ---------------------------------------------------------------------------

/**
 * Every known pool address on this chain, mapped to its market.
 *
 * The join key from an FPMM log back to a market: the log carries the pool
 * address, and `market_events.question_id` is what the chart queries. Addresses
 * are lowercased on both write and read so the map cannot miss on casing.
 */
export async function questionIdByFpmm(chainId: number): Promise<Map<string, bigint>> {
  const res = await getPool().query<{ fpmm: string; question_id: string }>(
    'SELECT fpmm, question_id FROM markets WHERE chain_id = $1',
    [chainId]
  );
  const out = new Map<string, bigint>();
  for (const row of res.rows) out.set(row.fpmm.toLowerCase(), toBigInt(row.question_id));
  return out;
}

/**
 * The pool state after the most recent indexed event for a market, or null when
 * it has none.
 *
 * This is what makes the replay RESUMABLE. Reserves are a fold over the whole
 * event history, so without a stored tail every run — and every reorg recovery
 * — would have to re-replay from the pool's first `LiquidityAdded`. Ordering by
 * `(block_number DESC, log_index DESC)` and not by `block_time`: several events
 * share a timestamp within one block, and only the log order is the order the
 * contract applied them in.
 *
 * After `truncateAbove`, the surviving row below the cut is what this returns,
 * so a reorg replay resumes from there rather than from genesis.
 */
export async function latestReplayState(
  chainId: number,
  questionId: bigint
): Promise<PoolState | null> {
  const res = await getPool().query<{
    reserve_yes: string;
    reserve_no: string;
    total_supply: string;
  }>(
    `SELECT reserve_yes, reserve_no, total_supply
       FROM market_events
      WHERE chain_id = $1 AND question_id = $2
      ORDER BY block_number DESC, log_index DESC
      LIMIT 1`,
    [chainId, questionId.toString()]
  );
  const row = res.rows[0];
  if (!row) return null;
  // numeric(78,0) arrives as a string; BigInt at the boundary, always.
  return {
    reserveYes: toBigInt(row.reserve_yes),
    reserveNo: toBigInt(row.reserve_no),
    totalSupply: toBigInt(row.total_supply),
  };
}

/**
 * Undo everything above `cutBlock` for one chain, in preparation for re-indexing
 * it — the reorg path.
 *
 * All four statements are scoped by `chain_id` AND a block bound; none of them
 * can touch another chain, and there is no unqualified DELETE here.
 *
 * The last statement is the one that is easy to forget: a reorg can unmake a
 * RESOLUTION as well as an event. `markets` rows are keyed by question id, not
 * by block, so a resolved-then-reorged market would keep `resolved = true`
 * forever, and the payouts of a resolution that never happened. Creation rows
 * above the cut are deleted outright; the market will be re-inserted when its
 * `MarketCreated` is re-indexed.
 */
export async function truncateAbove(
  c: PoolClient,
  chainId: number,
  cutBlock: bigint
): Promise<void> {
  const args = [chainId, cutBlock.toString()];
  await c.query('DELETE FROM market_events WHERE chain_id = $1 AND block_number > $2', args);
  await c.query('DELETE FROM blocks WHERE chain_id = $1 AND block_number > $2', args);
  await c.query('DELETE FROM markets WHERE chain_id = $1 AND created_block > $2', args);
  await c.query(
    `UPDATE markets
        SET resolved = false, resolved_block = NULL, payout_yes = NULL, payout_no = NULL,
            updated_at = now()
      WHERE chain_id = $1 AND resolved_block > $2`,
    args
  );
}

// `selectChartRows` (and its ChartQueryArgs/ChartRow types) belongs to Task 10,
// which owns the bucket policy the query depends on. It is omitted rather than
// stubbed: an exported function returning [] would typecheck at every call site
// and silently produce an empty chart.
