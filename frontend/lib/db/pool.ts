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
 * degrade, not hang until the platform kills it.
 *
 * SQL LIVES IN `queries.ts`, not here — except `BEGIN`/`COMMIT`/`ROLLBACK`,
 * which are transaction control rather than statements against our schema.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { getIndexerConfig } from '../indexer/config';

const MAX_CLIENTS = 3;
const IDLE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

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
