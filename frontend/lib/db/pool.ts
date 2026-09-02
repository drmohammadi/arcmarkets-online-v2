/**
 * The indexer's one Postgres pool, and the transaction helper every multi-write
 * path goes through.
 *
 * THE POOL IS A MODULE-SCOPED SINGLETON, BUILT LAZILY. Both halves matter:
 *
 *  - Module-scoped, so a warm serverless instance reuses its TCP+TLS
 *    connections. A pool created per request would pay a fresh TLS handshake to
 *    Neon on every chart load, which is most of the latency of a cheap query.
 *  - Built on FIRST CALL, never at import time. Nothing here reads
 *    `process.env` or calls `getIndexerConfig()` while the module is being
 *    evaluated, because `getIndexerConfig()` throws when `DATABASE_URL` is
 *    unset and `next build` imports every route module: a module-scope call
 *    would turn a missing env var into a failed build instead of a failed
 *    request. Same rule `lib/indexer/config.ts` documents for itself.
 *
 * `max: 3` — Neon's pooler is generous per connection but a serverless fleet
 * multiplies clients by instance count, so the per-instance number stays small.
 * `idleTimeoutMillis` / `connectionTimeoutMillis` are both 10s: a frozen
 * instance should drop its sockets rather than hold them, and a request that
 * cannot get a connection in 10s should fail while the caller can still
 * degrade, not hang until the platform kills it. `ensurePoolReachable` layers a
 * bounded retry on top of that timeout for the FIRST connect only — with daily
 * cron a suspended endpoint is the normal state, and a wake-up must not read as
 * an outage. See its comment for why that is a retry rather than a longer
 * timeout.
 *
 * SQL LIVES IN `queries.ts`, not here — except `BEGIN`/`COMMIT`/`ROLLBACK`,
 * which are transaction control rather than statements against our schema.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { getIndexerConfig } from '../indexer/config';

const MAX_CLIENTS = 3;
const IDLE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Backoff before re-attempting a FAILED FIRST CONNECT, and the total wall-clock
 * budget for those attempts. See `ensurePoolReachable` for the policy; these are
 * the two numbers it is made of.
 */
const COLD_START_BACKOFF_MS: readonly number[] = [250, 1000];
const COLD_START_BUDGET_MS = 12_000;

let pool: Pool | null = null;

/**
 * The query string of a Postgres URL, or '' when it has none.
 *
 * Parsed with `URL` first so that a password containing `?` cannot be mistaken
 * for the start of the query; the manual fallback exists only for a string
 * `URL` refuses outright, and then the LAST `?` is the best guess available.
 */
function queryStringOf(connectionString: string): string {
  try {
    return new URL(connectionString).search;
  } catch {
    const q = connectionString.lastIndexOf('?');
    return q < 0 ? '' : connectionString.slice(q);
  }
}

/**
 * The `ssl` option to pass to `pg`, or `undefined` meaning "pass none".
 *
 * WHY DEFERRING TO THE URL IS THE CORRECT DEFAULT. The production
 * `DATABASE_URL` carries `sslmode=require&channel_binding=require`. `pg`
 * honours those keywords itself — but ONLY when no `ssl` option is supplied;
 * an explicit object overrides them wholesale. So hard-coding one here would
 * either weaken the connection (dropping channel binding) or break it (forcing
 * TLS onto a local, TLS-less scratch Postgres reached via `sslmode=disable`).
 * Both failures are ours to cause and neither is visible in a code review of
 * the connection string.
 *
 * When the URL says nothing about SSL we must choose, and the safe choice is
 * verified TLS: `{ rejectUnauthorized: true }`. `pg`'s own default for a bare
 * URL is NO TLS at all, which would silently send credentials in plaintext to
 * a managed provider. A caller that genuinely wants plaintext (a local
 * database) says so in the URL with `sslmode=disable`.
 *
 * Exported so the decision is unit-testable without a database.
 */
export function sslConfigFor(connectionString: string): { rejectUnauthorized: true } | undefined {
  const params = new URLSearchParams(queryStringOf(connectionString));
  for (const key of params.keys()) {
    // `ssl` as well as `sslmode`: pg-connection-string reads both, so either
    // one means the URL has an opinion we must not overrule.
    const k = key.toLowerCase();
    if (k === 'sslmode' || k === 'ssl') return undefined;
  }
  return { rejectUnauthorized: true };
}

/**
 * The pool, created on first use.
 *
 * `getIndexerConfig()` is called here rather than at module scope — see the
 * header. It throws on a missing `DATABASE_URL`, which is the right failure at
 * request time and the wrong one at build time.
 */
export function getPool(): Pool {
  if (pool) return pool;
  const { databaseUrl } = getIndexerConfig();
  const ssl = sslConfigFor(databaseUrl);
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: MAX_CLIENTS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Conditional spread, not `ssl: ssl` — `pg` treats an explicitly present
    // key as an override, and "no key" is a distinct, meaningful state here.
    ...(ssl ? { ssl } : {}),
  };
  const created = new Pool(config);
  // An IDLE client that dies (Neon closes idle connections, a network blip,
  // a pooler restart) emits 'error' on the Pool with no query to attach it to.
  // Node's default for an unhandled 'error' event is to THROW, which would
  // take down the whole serverless instance for a connection nobody was using.
  // Log it and let the pool replace the client. The message never contains the
  // connection string.
  created.on('error', (err: Error) => {
    console.error('pg pool: idle client error:', err.message);
  });
  pool = created;
  return created;
}

/**
 * Wait for the database to be REACHABLE, retrying the connect — and only the
 * connect — on a bounded budget. Call it once before the queries of a request.
 *
 * WHY THIS EXISTS. Cron runs DAILY (per-minute cron would keep Neon's compute
 * awake and exhaust the free tier's 100 CU-hours/month, suspending the database
 * for the rest of the billing month), and Neon suspends an idle endpoint after
 * about five minutes. So on this project's traffic the endpoint is nearly always
 * ASLEEP when the first visitor of a session arrives, and a wake-up is the
 * COMMON case rather than the exception. `frontend/lib/db/` has no retry
 * anywhere else, and `connectionTimeoutMillis` is 10s: without this, the chart
 * route's degraded path — the RPC log sweep this whole feature exists to replace
 * — becomes the default path, and a 3-second wake-up reads as an outage.
 *
 * MEASURED, not assumed, against this project's own Neon endpoint:
 *  - a cold connect after ~6 minutes idle: **4.1s** (a warm one from the same
 *    machine is 2.5s, so the wake itself is ~1.5s). Comfortably inside the 10s
 *    timeout, and the reason no retry was needed to ship Tasks 1-9.
 *  - after a LONGER idle, three consecutive attempts each hit the 10s timeout
 *    and a fourth, a minute later, succeeded in 3.4s. That is a wake far past
 *    any budget a chart request can hold.
 *  - Task 9's proof script hit the same 10s wall with three CONCURRENT
 *    handshakes and had to serialize them.
 *
 * SO THE POLICY IS A HYBRID, AND THE SPLIT IS THE POINT. Retry the connect on a
 * budget of about two timeouts (~20s worst case), which covers the measured cold
 * start and a first attempt that fails fast for an unrelated reason. Past that,
 * ACCEPT AND DEGRADE: the caller reports `degraded: true` and the RPC fallback
 * carries that one request. Waiting a minute for a chart is not a trade worth
 * making, and it does not need to be — a timed-out attempt has ALREADY asked
 * Neon to wake, so the degrade is self-healing: the next request lands on a warm
 * endpoint. The cost of the deep case is one visitor's history, once, not a
 * persistent state.
 *
 * WHY NOT SIMPLY RAISE `connectionTimeoutMillis`. That timeout protects the WARM
 * path: when the pooler is dead or the network is gone, a request should fail
 * while the caller can still degrade rather than hang until the platform kills
 * it. Raising it to 30s would make every genuinely-broken connection hold a
 * request three times as long — including the ones that will never succeed. A
 * retry keeps the fast failure and spends the extra time only on the case that
 * benefits from it.
 *
 * WHY THE CONNECT AND NOT THE QUERY. Acquiring a connection is idempotent, so
 * retrying it cannot repeat a side effect; retrying a statement can. Nothing
 * here re-runs SQL. It is also where the cost actually is — TLS plus Neon's
 * wake-up — and a connect established here is reused by every query in the same
 * request, because `release()` returns the client to the pool's idle set.
 *
 * WHY A DEADLINE AND NOT JUST A COUNT. The budget makes the attempt count
 * adaptive rather than fixed: a fast failure (a pooler restart, a reset socket)
 * leaves room for all three attempts, while an attempt that burns the whole 10s
 * timeout leaves room for one more and then stops — bounding the worst case at
 * roughly two connect timeouts instead of three.
 *
 * Throws the last error when the budget is spent. Callers degrade on it; they
 * must not translate it into a 5xx on the chart path.
 */
export async function ensurePoolReachable(): Promise<void> {
  const started = Date.now();
  const db = getPool();
  let lastError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    try {
      // A warm pool answers this from its idle set with no round trip at all, so
      // the happy path costs nothing measurable.
      const client = await db.connect();
      client.release();
      return;
    } catch (err) {
      lastError = err;
      const backoff = COLD_START_BACKOFF_MS[attempt];
      if (backoff === undefined || Date.now() - started >= COLD_START_BUDGET_MS) break;
      console.warn(
        `pg pool: connect attempt ${attempt + 1} failed (${
          err instanceof Error ? err.message : 'unknown error'
        }); retrying in ${backoff}ms — a suspended Neon endpoint is expected here`
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoff);
      });
    }
  }
  throw lastError;
}

/**
 * Run `fn` inside one transaction on one client, committing on return and
 * rolling back on throw.
 *
 * Every write path that must land atomically takes a `PoolClient` parameter for
 * exactly this reason: the indexer commits a whole block range — blocks,
 * markets, resolutions, events, checkpoint — or none of it, so the checkpoint
 * can never run ahead of the rows it claims to cover.
 *
 * The ROLLBACK is guarded because the likeliest cause of a mid-transaction
 * failure is a dropped connection, and then ROLLBACK rejects too; an unguarded
 * one would replace the error the caller actually needs with a secondary
 * failure. Postgres discards an aborted transaction on disconnect anyway.
 */
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('rollback also failed (original error follows):', rollbackErr);
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Close the pool and forget it.
 *
 * NOT for the request path — a serverless function should leave its pool warm
 * for the next invocation. This exists for one-shot processes (the local e2e
 * script, the test suite) where an open pool keeps the event loop alive and the
 * process never exits.
 */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
