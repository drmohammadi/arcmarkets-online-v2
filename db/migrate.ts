/**
 * Migration runner. Standalone CLI, run with `npm run db:migrate`
 * (`npx tsx db/migrate.ts`).
 *
 * Deliberately does NOT import lib/indexer/config.ts: that module is the
 * request-path config and throws on a missing DATABASE_URL as a request-time
 * error. A migration is a one-shot script with a different failure mode and no
 * business depending on the runtime config surface.
 *
 * It also resolves DATABASE_URL itself. `npx tsx` is not Next, so it does not
 * load .env.local — without this the script would fail on a machine where the
 * URL lives only in that file. The parser is inline rather than `dotenv`
 * because a 15-line job does not justify a dependency (see DEPENDENCIES.md).
 *
 * The connection string is never logged. Only its host is ever printed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

/**
 * Fixed advisory-lock key for "this database's migration runner". Arbitrary, but
 * it must never change and every process that migrates this database must use
 * the same value — a different key is no lock at all. Passed as a string
 * because the parameter is a Postgres bigint.
 */
const MIGRATION_LOCK_KEY = '5042002001';

/** Wait this long for the lock, then fail loudly rather than hang a deploy. */
const LOCK_TIMEOUT = '5s';

/**
 * Minimal KEY=VALUE reader. Skips blanks and `#` comments, splits on the FIRST
 * `=` (values contain `=` — a Postgres URL with query params does), and strips
 * one matching pair of surrounding quotes. A missing file is not an error.
 */
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** process.env wins; then .env.local; then .env. */
function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  const root = join(here, '..');
  for (const file of ['.env.local', '.env']) {
    const value = readEnvFile(join(root, file))['DATABASE_URL'];
    if (value) return value;
  }
  return '';
}

/** Host only — never the credentials, the database name or the query string. */
function describeTarget(connectionString: string): string {
  try {
    return new URL(connectionString).host || '<redacted>';
  } catch {
    return '<redacted>';
  }
}

/**
 * Runs `body` in a transaction that first takes the migration lock.
 *
 * The lock is TRANSACTION-scoped (`pg_advisory_xact_lock`), which is the only
 * variant that works here: `DATABASE_URL` points at Neon's `-pooler` endpoint,
 * i.e. PgBouncer in transaction mode. There, two runners can be multiplexed
 * onto the SAME backend session, and a *session* lock (`pg_advisory_lock`) on
 * the same key would then be a recursive re-acquire that succeeds instantly and
 * serializes nothing — protection in appearance only. PgBouncer does pin a
 * server connection for the duration of a transaction, so a transaction-scoped
 * lock is genuinely exclusive, and it is released by COMMIT/ROLLBACK rather than
 * by session teardown.
 *
 * Contrast with `lib/db/queries.ts` (a later task), which uses a lease ROW: a
 * serverless function can be killed mid-run, and a killed function releases no
 * lock of any scope, whereas a lease simply expires. Do not unify the two —
 * each is wrong in the other's setting.
 *
 * `lock_timeout` is set transaction-locally (`set_config(..., true)`) rather
 * than as a session GUC, for the same pooling reason: a session-level SET may
 * land on a backend that does not serve the next transaction. Local means it is
 * always in force on the backend that will actually do the waiting, so a wedged
 * holder fails a parallel deploy fast (Postgres 55P03) instead of hanging.
 */
async function inLockedTransaction<T>(client: Client, body: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['lock_timeout', LOCK_TIMEOUT]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    const result = await body();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Guarded: the likeliest mid-migration failure is a dropped connection, and
    // then ROLLBACK rejects too. An unguarded rollback would let that secondary
    // rejection replace the error an operator actually needs to see. Postgres
    // discards an aborted transaction — and its xact lock — on disconnect
    // anyway, so a failed rollback costs nothing but a log line.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('rollback also failed (original error follows):', rollbackErr);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env, .env.local, .env)');
  }

  const client = new Client({ connectionString });
  await client.connect();
  console.log(`connected to ${describeTarget(connectionString)}`);
  try {
    // The bootstrap needs the lock too. Two concurrent `CREATE TABLE IF NOT
    // EXISTS` can collide in the catalog and fail with a unique violation on
    // pg_type_typname_nsp_index — on a fresh database that is exactly the
    // deploy failure this lock exists to prevent.
    await inLockedTransaction(client, () =>
      client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
      )
    );

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      // One transaction per file, each holding the lock, each carrying its own
      // INSERT — so a failed migration leaves no record, and check-then-apply
      // is serialized as a whole rather than only at the insert.
      await inLockedTransaction(client, async () => {
        // Re-read inside the lock. A read taken before acquiring it could have
        // been overtaken by a runner that has since committed this very file.
        const done = new Set(
          (
            await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
          ).rows.map((r) => r.filename)
        );
        if (done.has(file)) {
          console.log(`skip ${file}`);
          return;
        }
        const sql = readFileSync(join(dir, file), 'utf8');
        await client.query(sql);
        // ON CONFLICT is independent defence behind the lock, so correctness
        // does not rest on the lock alone: a runner that somehow raced past it
        // records nothing rather than aborting the deploy. rowCount tells us
        // which of those two actually happened, so the log cannot claim an
        // insert that did not occur.
        const insert = await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
          [file]
        );
        console.log(
          (insert.rowCount ?? 0) > 0
            ? `applied ${file}`
            : `applied ${file} (record already present — no row written)`
        );
      });
    }
  } finally {
    // Guarded for the same reason as the rollback: an end() rejection must not
    // displace the error we are already unwinding with. Nothing leaks if it
    // fails — the xact lock is gone with the transaction, and the socket dies
    // with the process.
    try {
      await client.end();
    } catch (endErr) {
      console.error('closing the connection failed:', endErr);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
