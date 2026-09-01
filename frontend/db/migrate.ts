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

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env, .env.local, .env)');
  }

  const client = new Client({ connectionString });
  await client.connect();
  console.log(`connected to ${describeTarget(connectionString)}`);
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );

    // Serialize the WHOLE check-then-apply sequence, not just the insert:
    // `db:migrate` is a build step, and parallel deploys are normal, so two
    // runners can otherwise both pass the `done` check below and the loser's
    // INSERT fails the deploy on the filename primary key.
    //
    // A SESSION-level advisory lock is right *here* and wrong elsewhere in this
    // project. lib/db/queries.ts uses a lease ROW instead, because it runs on
    // serverless functions behind a transaction-mode pooler: no session
    // affinity, and a killed function would never release a session lock.
    // migrate.ts is a one-shot CLI holding a single dedicated Client for its
    // entire life, which is exactly the case this lock fits. Do not unify the
    // two mechanisms — each is wrong in the other's setting.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const done = new Set(
      (
        await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
      ).rows.map((r) => r.filename)
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip ${file}`);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        // ON CONFLICT is a second line of defence behind the advisory lock, so
        // correctness does not rest on the lock alone: a runner that somehow
        // raced past it records nothing rather than aborting the deploy.
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        // Guarded: the likeliest mid-migration failure is a dropped connection,
        // and then ROLLBACK rejects too. An unguarded rollback would let that
        // secondary rejection replace the error an operator actually needs to
        // see. Postgres discards an aborted transaction on disconnect anyway,
        // so a failed rollback costs nothing but a log line.
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('rollback also failed (original error follows):', rollbackErr);
        }
        throw err;
      }
    }
  } finally {
    // Releasing the lock is belt-and-braces: ending the session drops it. Both
    // are guarded so neither can mask a migration failure on the way out.
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // Nothing to do: the lock dies with the session on the next line.
    }
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
