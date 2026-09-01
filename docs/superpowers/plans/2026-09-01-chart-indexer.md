# Chart Data Indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser's 1.7M-block `eth_getLogs` chart sweep with a serverless indexer writing to managed Postgres, read back through an API, and plot a real time axis.

**Architecture:** A forward-only checkpointed indexer runs as Next.js Route Handlers in the existing `frontend/` app, triggered by user traffic via `waitUntil()` and by a daily Vercel Cron. It decodes six events, replays pool reserves exactly from event args, and stores one row per price-changing event in Neon Postgres. A chart API serves downsampled series; `useTradeHistory` fetches it instead of scanning logs, keeping the old sweep as a permanent fallback.

**Tech Stack:** Next.js 14.2.35 (App Router, Node runtime route handlers) · viem 2.21.37 · `pg` 8.23.0 · `@vercel/functions` 3.9.5 · Neon Postgres · Hardhat 2.22.17 + mocha/chai for tests

**Spec:** `docs/superpowers/specs/2026-08-31-chart-indexer-design.md` (commit `eb4a43d`)

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline commits `7c03dbc` and `60151a9` must not be amended, rebased or force-pushed.** They are the rollback point.
- **Dependency versions are exact and fixed:** `pg@8.23.0`, `@vercel/functions@3.9.5`. `save-exact=true` is already active. Add no other dependency without a `DEPENDENCIES.md` entry and a `npm view <pkg>@<ver> time` check showing >7 days.
- **`BigInt(0)`, never `0n`.** tsconfig target compatibility. This applies to every new file.
- **USDC is 6 decimals.** Never `10**18`. Use `lib/format.ts` on the frontend, `usdc()` from `contracts/test/helpers.ts` in tests.
- **Never `NEXT_PUBLIC_` a secret.** `DATABASE_URL`, `INDEXER_RPC_URL`, `CRON_SECRET` are server-only. The only new public var is `NEXT_PUBLIC_CHART_SOURCE`.
- **Every SQL statement is parameterized** (`$1`, `$2`, …). No template interpolation into SQL, ever — including `interval` and `limit`, which are allowlisted and coerced to integers first.
- **Chain-derived strings stay untrusted.** `markets.question` / `.category` originate in `MarketCreated`. Storing them in Postgres does not launder them; render paths still use `lib/sanitize.ts`.
- **Pure modules must have ZERO imports.** `lib/indexer/replay.ts`, `lib/indexer/chunking.ts`, `lib/chart/buckets.ts` and `lib/chartScale.ts` import nothing — not viem, not `@/`-aliased paths. This is what lets `contracts/test/*.test.ts` (CommonJS, own tsconfig, no `@/` alias) import them by relative path. Violating it silently makes them untestable.
- **Do not touch** `lib/logScan.ts`, `lib/logCache.ts`, `lib/rpcQueue.ts`, `useTradeLedger`, `useTradeStats`, `lib/ledger.ts`, or any contract. `/profile` and `/leaderboard` are out of scope.
- **Verification gate after every task:** `cd frontend && npx tsc --noEmit && npm run build`, plus `npm test` from the repo root when contracts tests changed.
- Arc testnet RPC is unreachable from the dev environment (Cloudflare 1009). Nothing in Tasks 1–13 may require it.

---

## File Structure

**Created — server, pure (zero imports, testable from the contracts workspace):**
| File | Responsibility |
|---|---|
| `frontend/lib/indexer/replay.ts` | Reserve replay arithmetic. Events in → reserves + `yes_bps` out. The correctness core. |
| `frontend/lib/indexer/chunking.ts` | Range-size policy: halving on refusal, monotonic ceiling, backoff delays. |
| `frontend/lib/chart/buckets.ts` | `interval=auto` resolution and bucket-count clamping. |
| `frontend/lib/chartScale.ts` | X-axis scale selection (time vs sequence) for `PriceChart`. |

**Created — server, impure:**
| File | Responsibility |
|---|---|
| `frontend/lib/db/pool.ts` | The single `pg.Pool`, module-scoped for serverless reuse. |
| `frontend/lib/db/queries.ts` | Every SQL statement. Nothing else writes SQL. |
| `frontend/lib/indexer/decode.ts` | viem log → `IndexedEvent`. The only viem-aware indexer file. |
| `frontend/lib/indexer/rpc.ts` | `getLogs` / `getBlock` with retry, 429 backoff, range-refusal halving. |
| `frontend/lib/indexer/run.ts` | The run loop: lease, reorg check, fetch, replay, write, checkpoint. |
| `frontend/lib/indexer/background.ts` | The *only* place that knows how background work starts. |
| `frontend/lib/indexer/config.ts` | Env parsing with defaults, server-only. |
| `frontend/db/migrations/001_init.sql` | Four tables + two indexes. |
| `frontend/db/migrate.ts` | Migration runner; records applied files in `schema_migrations`. |

**Created — routes:**
`frontend/app/api/markets/[questionId]/chart/route.ts` · `frontend/app/api/indexer/tick/route.ts` · `frontend/app/api/indexer/status/route.ts`

**Created — tests:**
`contracts/test/IndexerReplay.test.ts` · `contracts/test/ChartScale.test.ts` · `contracts/test/ChartBuckets.test.ts` · `contracts/scripts/e2e-indexer.ts`

**Modified:**
| File | Change |
|---|---|
| `frontend/package.json` | Add `pg@8.23.0`, `@vercel/functions@3.9.5`, `@types/pg`; add `db:migrate` script |
| `frontend/hooks/useTradeHistory.ts:114-118` | `TradePoint` gains optional `t` |
| `frontend/hooks/useTradeHistory.ts:180-247` | Fetch the API; keep the RPC sweep as fallback |
| `frontend/components/PriceChart.tsx:200-205` | Time-proportional x via `lib/chartScale.ts` |
| `frontend/components/PriceChart.tsx:324-332` | Add x-axis date labels |
| `frontend/components/PriceChart.tsx:354-372` | Timestamp column in the `sr-only` table |
| `frontend/.env.example` | Document every new variable |
| `vercel.json` (create) | Daily cron entry |
| `DEPENDENCIES.md` · `TODO.md` | Two entries + the explicit reversal; session log |

`CLAUDE.md` was already updated in `eb4a43d`.

---

## Phase 1 — Data layer and indexer (nothing user-visible)

### Task 1: Dependencies and server-only config

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/lib/indexer/config.ts`
- Modify: `frontend/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `getIndexerConfig(): IndexerConfig` with fields `chainId: number`, `rpcUrl: string`, `confirmations: number`, `chunkBlocks: bigint`, `staleSeconds: number`, `trafficMaxBlocks: bigint`, `cronMaxBlocks: bigint`, `cronSecret: string | null`, `databaseUrl: string`. Every later server task imports this.

- [ ] **Step 1: Verify publish dates before installing**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
npm view pg@8.23.0 time.created
npm view @vercel/functions@3.9.5 time.created
npm view @types/pg version
```

Expected: `pg@8.23.0` → `2026-08-08…`, `@vercel/functions@3.9.5` → `2026-08-20…`. Both must be more than 7 days before today. **If either is younger than 7 days, stop and report** — do not pick a different version unilaterally.

- [ ] **Step 2: Install, pinned exactly**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend"
npm install --save-exact pg@8.23.0 @vercel/functions@3.9.5
npm install --save-exact --save-dev @types/pg@8.11.10
```

`save-exact=true` and `ignore-scripts=true` come from `.npmrc`; do not pass `--ignore-scripts` explicitly. Confirm `frontend/package.json` shows bare versions with no `^`.

- [ ] **Step 3: Add the migrate script**

In `frontend/package.json` `"scripts"`, after `"typecheck"`:

```json
"db:migrate": "node --loader ts-node/esm db/migrate.ts"
```

Note: `ts-node` is not a frontend dependency. Use this instead, which needs nothing new:

```json
"db:migrate": "npx tsx db/migrate.ts"
```

If `npx tsx` is unavailable offline, fall back to compiling with the existing TypeScript: `"db:migrate": "npx tsc db/migrate.ts --outDir .db-build --module commonjs --target ES2022 --esModuleInterop && node .db-build/migrate.js"`, and add `.db-build/` to `.gitignore`. Pick one, and record which in the commit message.

- [ ] **Step 4: Write the config module**

Create `frontend/lib/indexer/config.ts`:

```ts
/**
 * Server-only indexer configuration.
 *
 * Nothing here is NEXT_PUBLIC_, so none of it reaches the browser bundle. Every
 * value has a safe default except DATABASE_URL, which has no sensible default —
 * a missing database is a hard failure, not a degraded mode.
 */

export interface IndexerConfig {
  chainId: number;
  rpcUrl: string;
  confirmations: number;
  chunkBlocks: bigint;
  staleSeconds: number;
  trafficMaxBlocks: bigint;
  cronMaxBlocks: bigint;
  cronSecret: string | null;
  databaseUrl: string;
}

/** Public Arc testnet endpoint, matching lib/chains.ts. */
const DEFAULT_RPC = 'https://rpc.testnet.arc.io';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function bigEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v > BigInt(0) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getIndexerConfig(): IndexerConfig {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  // https only, and no credentials in the URL — the same rule lib/chains.ts
  // applies to the public RPC, for the same reason.
  let rpcUrl = process.env.INDEXER_RPC_URL ?? DEFAULT_RPC;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== 'https:' || u.username || u.password) rpcUrl = DEFAULT_RPC;
  } catch {
    rpcUrl = DEFAULT_RPC;
  }

  return {
    chainId: intEnv('INDEXER_CHAIN_ID', 5042002),
    rpcUrl,
    confirmations: intEnv('INDEXER_CONFIRMATIONS', 12),
    chunkBlocks: bigEnv('INDEXER_CHUNK_BLOCKS', BigInt(250_000)),
    staleSeconds: intEnv('INDEXER_STALE_SECONDS', 120),
    trafficMaxBlocks: bigEnv('INDEXER_TRAFFIC_MAX_BLOCKS', BigInt(500_000)),
    cronMaxBlocks: bigEnv('INDEXER_CRON_MAX_BLOCKS', BigInt(4_000_000)),
    cronSecret: process.env.CRON_SECRET ?? null,
    databaseUrl,
  };
}
```

- [ ] **Step 5: Document the variables**

Append to `frontend/.env.example`, matching the file's existing style — each block explains *why* the variable exists and what happens when it is absent. Include a header stating that **unlike every other variable in this file, these are server-only and must never be renamed to `NEXT_PUBLIC_*`**, and document `DATABASE_URL`, `INDEXER_RPC_URL`, `CRON_SECRET`, `INDEXER_CHAIN_ID`, `INDEXER_CONFIRMATIONS`, `INDEXER_CHUNK_BLOCKS`, `INDEXER_STALE_SECONDS`, `INDEXER_TRAFFIC_MAX_BLOCKS`, `INDEXER_CRON_MAX_BLOCKS`, and `NEXT_PUBLIC_CHART_SOURCE` (`api` | `rpc` | `auto`, default `api`).

- [ ] **Step 6: Verify**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend" && npx tsc --noEmit && npm run build
```

Expected: 0 errors, build succeeds, route count still 11 (no routes added yet).

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
git add frontend/package.json frontend/package-lock.json frontend/lib/indexer/config.ts frontend/.env.example
git commit -m "feat(indexer): add pg + @vercel/functions, server-only config module"
```

---

### Task 2: Schema and migration runner

**Files:**
- Create: `frontend/db/migrations/001_init.sql`
- Create: `frontend/db/migrate.ts`

**Interfaces:**
- Consumes: `getIndexerConfig()` from Task 1.
- Produces: the four tables. Column names below are referenced verbatim by every later task — do not rename them.

- [ ] **Step 1: Write the migration**

Create `frontend/db/migrations/001_init.sql`:

```sql
-- Chart indexer schema. RPC is the source of truth; this is a read-optimized
-- projection of it. Amounts are numeric(78,0) because they are uint256 in the
-- contracts; bigint would silently overflow at 9.2e18.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  chain_id                bigint PRIMARY KEY,
  factory_address         text    NOT NULL,
  start_block             bigint  NOT NULL,
  last_indexed_block      bigint  NOT NULL,
  last_indexed_block_hash text,
  backfill_complete       boolean NOT NULL DEFAULT false,
  accepted_chunk          bigint,
  lease_until             timestamptz,
  lease_owner             text,
  last_error              text,
  last_tick_at            timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Only blocks CONTAINING indexed events. The timestamp cache and the reorg
-- witness. Never one row per chain block: that would be 1.7M rows of nothing.
CREATE TABLE IF NOT EXISTS blocks (
  chain_id     bigint      NOT NULL,
  block_number bigint      NOT NULL,
  block_hash   text        NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS markets (
  chain_id        bigint  NOT NULL,
  question_id     bigint  NOT NULL,
  fpmm            text    NOT NULL,
  condition_id    text    NOT NULL,
  question        text    NOT NULL,
  category        text    NOT NULL,
  resolution_time timestamptz NOT NULL,
  resolver        text    NOT NULL,
  fee_bps         integer NOT NULL,
  created_block   bigint  NOT NULL,
  created_at      timestamptz NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  resolved_block  bigint,
  payout_yes      numeric(78,0),
  payout_no       numeric(78,0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, question_id)
);

-- The join key from an FPMM log back to its market.
CREATE UNIQUE INDEX IF NOT EXISTS markets_fpmm_uk ON markets (chain_id, fpmm);

-- Raw event args AND replayed reserves AND derived prices, append-only.
-- One table rather than separate price/liquidity tables: liquidity events carry
-- a price too (addLiquidity moves it on an unbalanced pool), and their reserve
-- magnitudes are what every later replay step reads. One table means no join on
-- the hot path and one place to truncate on reorg.
CREATE TABLE IF NOT EXISTS market_events (
  chain_id     bigint  NOT NULL,
  block_number bigint  NOT NULL,
  log_index    integer NOT NULL,
  tx_hash      text    NOT NULL,
  question_id  bigint  NOT NULL,
  fpmm         text    NOT NULL,
  kind         text    NOT NULL
    CHECK (kind IN ('buy','sell','liquidity_added','liquidity_removed')),
  actor        text    NOT NULL,
  outcome      smallint CHECK (outcome IS NULL OR outcome IN (0,1)),
  collateral   numeric(78,0) NOT NULL,
  shares       numeric(78,0) NOT NULL,
  reserve_yes  numeric(78,0) NOT NULL,
  reserve_no   numeric(78,0) NOT NULL,
  total_supply numeric(78,0) NOT NULL,
  yes_bps      integer NOT NULL CHECK (yes_bps BETWEEN 0 AND 10000),
  exec_yes_bps integer CHECK (exec_yes_bps IS NULL OR exec_yes_bps BETWEEN 0 AND 10000),
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- The ONLY chart index. (chain_id, question_id, block_time) serves every chart
-- query; the primary key serves dedupe and ordering. Deliberately nothing else:
-- writes must stay cheap.
CREATE INDEX IF NOT EXISTS market_events_chart
  ON market_events (chain_id, question_id, block_time);
```

- [ ] **Step 2: Write the runner**

Create `frontend/db/migrate.ts`. It must: read `DATABASE_URL`; connect with `pg.Client` (not Pool — this is a one-shot script); `CREATE TABLE IF NOT EXISTS schema_migrations` first; read `db/migrations/*.sql` sorted by filename; skip any already in `schema_migrations`; run each remaining file **inside a transaction together with its own `INSERT INTO schema_migrations`**, so a failed migration leaves no partial record; log each applied filename; exit non-zero on failure.

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const done = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename
      )
    );
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip ${file}`);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run it against a real database**

Provision a scratch Postgres — a Neon branch, or any local instance. Then:

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend"
DATABASE_URL='postgresql://…' npm run db:migrate
```

Expected: `applied 001_init.sql`.

- [ ] **Step 4: Prove idempotency**

Run the identical command again. Expected: `skip 001_init.sql`, exit 0, no error. A migration runner that is not idempotent will corrupt a redeploy.

- [ ] **Step 5: Verify the shape**

```bash
psql "$DATABASE_URL" -c '\d market_events' -c '\di market_events*'
```

Expected: `market_events_pkey` on `(chain_id, block_number, log_index)` and `market_events_chart`. Exactly two indexes on the table — if there are more, remove them.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
git add frontend/db
git commit -m "feat(indexer): four-table schema and idempotent migration runner"
```

---

### Task 3: Reserve replay engine (pure, TDD)

This is the correctness core of the whole change. Everything else is plumbing.

**Files:**
- Create: `frontend/lib/indexer/replay.ts` (**zero imports**)
- Test: `contracts/test/IndexerReplay.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, imported by Tasks 5, 6 and 8:
```ts
export type EventKind = 'buy' | 'sell' | 'liquidity_added' | 'liquidity_removed';
export interface IndexedEvent {
  blockNumber: bigint; logIndex: number; txHash: string; fpmm: string;
  kind: EventKind; actor: string; outcome: 0 | 1 | null;
  collateral: bigint; shares: bigint;
}
export interface PoolState { reserveYes: bigint; reserveNo: bigint; totalSupply: bigint }
export interface ReplayedEvent extends IndexedEvent {
  reserveYes: bigint; reserveNo: bigint; totalSupply: bigint;
  yesBps: number; execYesBps: number | null; checksumOk: boolean;
}
export function zeroState(): PoolState;
export function yesProbBps(reserveYes: bigint, reserveNo: bigint): number;
export function execYesBps(kind: EventKind, outcome: 0 | 1 | null, collateral: bigint, shares: bigint): number | null;
export function applyEvent(state: PoolState, ev: IndexedEvent): { state: PoolState; checksumOk: boolean };
export function replay(initial: PoolState, events: IndexedEvent[]): ReplayedEvent[];
```

**The arithmetic, derived from `contracts/src/FixedProductMarketMaker.sol`.** Each rule reads *pre-event* state and writes post-event state, so events MUST be applied in `(blockNumber, logIndex)` order:

| Kind | Effect | Contract |
|---|---|---|
| `liquidity_added` | `yes += collateral; no += collateral; totalSupply += shares` | `:103` splits the whole amount into full sets |
| `buy` | `yes += collateral; no += collateral;` then `outcome===0 ? yes -= shares : no -= shares` | `:212-215` splits **all** of `investmentAmount`, then transfers `sharesOut` out |
| `sell` | `outcome===0 ? yes += shares : no += shares;` then `yes -= collateral; no -= collateral` | `:237-239` takes `sharesIn` in, merges `returnAmount` full sets |
| `liquidity_removed` | `yesOut = shares*yes/totalSupply; noOut = shares*no/totalSupply; yes -= yesOut; no -= noOut; totalSupply -= shares` | `:134-135` |

No `fee` value is needed anywhere: the fee is already baked into `sharesOut` / `sharesIn` by `calcBuyAmount` / `calcSellAmount`.

`checksumOk` is `min(yesOut, noOut) === collateral` for `liquidity_removed` (the contract emits exactly that, `:140`) and `true` for every other kind. Guard `totalSupply === BigInt(0)`: return the state unchanged with `checksumOk: false` rather than dividing by zero.

`yesProbBps` must match `frontend/lib/pricing.ts:25-29` **exactly**, including returning `5000` for an empty pool — a divergence here would make the API and the live point disagree, which is the bug being fixed.

- [ ] **Step 1: Write the failing test**

Create `contracts/test/IndexerReplay.test.ts`. Numbers below are hand-verified against the contract's own `calcBuyAmount` / `calcSellAmount` with `fee = 0`; the `sell` case deliberately asserts that the replayed YES reserve equals the contract's computed `endingSellReserve` of 954.

```ts
import { expect } from "chai";
import {
  applyEvent, replay, yesProbBps, execYesBps, zeroState,
  type IndexedEvent, type PoolState,
} from "../../frontend/lib/indexer/replay";

const ev = (
  kind: IndexedEvent["kind"],
  collateral: number,
  shares: number,
  outcome: 0 | 1 | null = null,
  logIndex = 0
): IndexedEvent => ({
  blockNumber: BigInt(100 + logIndex), logIndex, txHash: "0xtx",
  fpmm: "0xpool", kind, actor: "0xactor", outcome,
  collateral: BigInt(collateral), shares: BigInt(shares),
});

describe("indexer replay", () => {
  it("mirrors lib/pricing.ts, including the empty pool", () => {
    expect(yesProbBps(BigInt(0), BigInt(0))).to.equal(5000);
    expect(yesProbBps(BigInt(1000), BigInt(1000))).to.equal(5000);
    expect(yesProbBps(BigInt(910), BigInt(1100))).to.equal(5472);
  });

  it("seeds a balanced pool at even odds", () => {
    const { state } = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000));
    expect(state).to.deep.equal({
      reserveYes: BigInt(1000), reserveNo: BigInt(1000), totalSupply: BigInt(1000),
    });
    expect(yesProbBps(state.reserveYes, state.reserveNo)).to.equal(5000);
  });

  it("moves the price the right way on a YES buy", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    // buy(outcome=0, investmentAmount=100) with fee=0 yields sharesOut=190.
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    expect(s.reserveYes).to.equal(BigInt(910));
    expect(s.reserveNo).to.equal(BigInt(1100));
    // Buying YES makes YES dearer: 5000 -> 5472.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(5472);
  });

  it("reproduces the contract's endingSellReserve", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    // sell(outcome=0, returnAmount=50) with fee=0 yields sharesIn=94,
    // and calcSellAmount's endingSellReserve is 954.
    s = applyEvent(s, ev("sell", 50, 94, 0)).state;
    expect(s.reserveYes).to.equal(BigInt(954));
    expect(s.reserveNo).to.equal(BigInt(1050));
  });

  it("addLiquidity MOVES the price on an unbalanced pool", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    const before = yesProbBps(s.reserveYes, s.reserveNo); // 5472
    s = applyEvent(s, ev("liquidity_added", 100, 90)).state;
    expect(s.reserveYes).to.equal(BigInt(1010));
    expect(s.reserveNo).to.equal(BigInt(1200));
    // Equal amounts onto unequal reserves pull the ratio toward 50/50.
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.equal(5429);
    expect(yesProbBps(s.reserveYes, s.reserveNo)).to.be.lessThan(before);
  });

  it("removeLiquidity does NOT move the price, and its checksum holds", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    s = applyEvent(s, ev("buy", 100, 190, 0)).state;
    s = applyEvent(s, ev("sell", 50, 94, 0)).state; // yes=954, no=1050, ts=1000
    const before = yesProbBps(s.reserveYes, s.reserveNo);
    // shares=500 -> yesOut=477, noOut=525, so the contract emits collateral=477.
    const res = applyEvent(s, ev("liquidity_removed", 477, 500));
    expect(res.checksumOk).to.equal(true);
    expect(res.state.reserveYes).to.equal(BigInt(477));
    expect(res.state.reserveNo).to.equal(BigInt(525));
    expect(res.state.totalSupply).to.equal(BigInt(500));
    // Proportional withdrawal preserves the ratio.
    expect(yesProbBps(res.state.reserveYes, res.state.reserveNo)).to.equal(before);
  });

  it("flags a checksum mismatch instead of trusting the replay", () => {
    let s: PoolState = applyEvent(zeroState(), ev("liquidity_added", 1000, 1000)).state;
    const res = applyEvent(s, ev("liquidity_removed", 999, 500)); // should be 500
    expect(res.checksumOk).to.equal(false);
  });

  it("never divides by zero on an empty LP supply", () => {
    const res = applyEvent(zeroState(), ev("liquidity_removed", 10, 5));
    expect(res.checksumOk).to.equal(false);
    expect(res.state).to.deep.equal(zeroState());
  });

  it("computes execution price on the YES side and rejects nonsense", () => {
    expect(execYesBps("buy", 0, BigInt(100), BigInt(190))).to.equal(5263);
    // A NO buy at 5263 on the NO side is 4737 on the YES side.
    expect(execYesBps("buy", 1, BigInt(100), BigInt(190))).to.equal(10000 - 5263);
    expect(execYesBps("buy", 0, BigInt(100), BigInt(0))).to.equal(null);
    // A share cannot be worth more than the 1 USDC it pays out.
    expect(execYesBps("buy", 0, BigInt(200), BigInt(100))).to.equal(null);
    expect(execYesBps("liquidity_added", null, BigInt(100), BigInt(100))).to.equal(null);
  });

  it("replays a series in order and carries reserves onto each row", () => {
    const rows = replay(zeroState(), [
      ev("liquidity_added", 1000, 1000, null, 0),
      ev("buy", 100, 190, 0, 1),
      ev("sell", 50, 94, 0, 2),
    ]);
    expect(rows).to.have.length(3);
    expect(rows[0].yesBps).to.equal(5000);
    expect(rows[1].yesBps).to.equal(5472);
    expect(rows[2].reserveYes).to.equal(BigInt(954));
    expect(rows[2].yesBps).to.equal(5239);
    expect(rows[0].execYesBps).to.equal(null);
    expect(rows[1].execYesBps).to.equal(5263);
  });
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npx hardhat test contracts/test/IndexerReplay.test.ts
```

Expected: failure to resolve `../../frontend/lib/indexer/replay`. If it fails with a *different* error, fix that before writing the implementation.

- [ ] **Step 3: Implement `replay.ts`**

Write `frontend/lib/indexer/replay.ts` implementing the interface above and the table above. Constraints: **zero imports**; `BigInt(0)` not `0n`; all division is BigInt floor division (`/`), matching Solidity's truncation; `yesProbBps` returns `Number((no * BigInt(10000)) / total)` with `5000` when `total <= 0`; `execYesBps` returns `null` for liquidity kinds, for `shares <= 0`, for `collateral <= 0`, and for any ratio outside `1..10000`, and flips to `10000 - bps` when `outcome === 1`.

- [ ] **Step 4: Run the tests until green**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npx hardhat test contracts/test/IndexerReplay.test.ts
```

Expected: 10 passing. **Do not adjust a test's expected number to make it pass** — every figure is derived from the contract. A mismatch means the implementation is wrong, or the hand-derivation was, and the latter needs re-deriving from `FixedProductMarketMaker.sol` rather than overwriting.

- [ ] **Step 5: Confirm the full suite still passes**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npm test
```

Expected: 74 pre-existing + 10 new = 84 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/indexer/replay.ts contracts/test/IndexerReplay.test.ts
git commit -m "feat(indexer): exact reserve replay from FPMM events, with tests

addLiquidity moves the marginal price on an unbalanced pool; removeLiquidity
does not, because it withdraws both reserves proportionally. Both are asserted
so the replay is pinned to the contract's behaviour rather than to plausible
numbers."
```

---

### Task 4: Range-size policy (pure, TDD)

**Files:**
- Create: `frontend/lib/indexer/chunking.ts` (**zero imports**)
- Test: `contracts/test/IndexerChunking.test.ts`

**Interfaces:**
- Produces:
```ts
export const BACKOFF_MS: readonly number[];               // [1000, 2000, 4000, 8000]
export function isRangeTooLarge(err: unknown): boolean;    // -32012 / "requested range too large"
export function isRateLimit(err: unknown): boolean;        // 429 / -32005 / message substrings
export function halve(span: bigint, minChunk: bigint): bigint | null; // null when not worth subdividing
export function nextChunkCeiling(current: bigint | null, accepted: bigint): bigint; // MONOTONIC: only raises
export function planRanges(from: bigint, to: bigint, chunk: bigint, maxRequests: number): Array<{ from: bigint; to: bigint }>;
```

Behaviour that must be tested, because each line encodes a bug already paid for in this repo:

- `isRangeTooLarge` must be **distinct from** `isRateLimit`. Arc answers `-32012 requested range too large`; retrying that unchanged loops forever — only asking for less helps. Mirror the detection style of `lib/rpcQueue.ts:76-92`: check `status`, `code`, `err.cause` recursively, and message substrings, case-insensitively.
- `nextChunkCeiling` only ever **raises**. A dense range refused for result count must not permanently throttle every later scan (`lib/logCache.ts:231-241` learned this).
- `planRanges` is forward-only, contiguous, inclusive, never emits an empty or inverted range, caps at `maxRequests` entries, and clamps the final `to` at the requested `to`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "chai";
import {
  BACKOFF_MS, halve, isRangeTooLarge, isRateLimit, nextChunkCeiling, planRanges,
} from "../../frontend/lib/indexer/chunking";

describe("indexer chunking", () => {
  it("tells a range refusal apart from a rate limit", () => {
    const range = { code: -32012, message: "requested range too large" };
    expect(isRangeTooLarge(range)).to.equal(true);
    expect(isRateLimit(range)).to.equal(false);
    expect(isRateLimit({ status: 429 })).to.equal(true);
    expect(isRateLimit({ code: -32005 })).to.equal(true);
    expect(isRateLimit({ cause: { message: "Too Many Requests" } })).to.equal(true);
    expect(isRangeTooLarge({ status: 429 })).to.equal(false);
  });

  it("halves down to the floor then gives up", () => {
    expect(halve(BigInt(250000), BigInt(1000))).to.equal(BigInt(125000));
    expect(halve(BigInt(1000), BigInt(1000))).to.equal(null);
    expect(halve(BigInt(1), BigInt(1000))).to.equal(null);
  });

  it("raises the learned ceiling but never lowers it", () => {
    expect(nextChunkCeiling(null, BigInt(250000))).to.equal(BigInt(250000));
    expect(nextChunkCeiling(BigInt(250000), BigInt(500000))).to.equal(BigInt(500000));
    expect(nextChunkCeiling(BigInt(500000), BigInt(50))).to.equal(BigInt(500000));
  });

  it("plans contiguous forward ranges and clamps the tail", () => {
    const r = planRanges(BigInt(100), BigInt(350), BigInt(100), 40);
    expect(r).to.deep.equal([
      { from: BigInt(100), to: BigInt(199) },
      { from: BigInt(200), to: BigInt(299) },
      { from: BigInt(300), to: BigInt(350) },
    ]);
  });

  it("respects the request cap and never inverts a range", () => {
    expect(planRanges(BigInt(0), BigInt(10_000), BigInt(100), 3)).to.have.length(3);
    expect(planRanges(BigInt(500), BigInt(499), BigInt(100), 40)).to.deep.equal([]);
    expect(planRanges(BigInt(7), BigInt(7), BigInt(100), 40)).to.deep.equal([
      { from: BigInt(7), to: BigInt(7) },
    ]);
  });

  it("exposes the same backoff ladder as rpcQueue", () => {
    expect([...BACKOFF_MS]).to.deep.equal([1000, 2000, 4000, 8000]);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails on the missing module**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npx hardhat test contracts/test/IndexerChunking.test.ts
```

- [ ] **Step 3: Implement `chunking.ts`** — zero imports, `BigInt(...)` literals only.

- [ ] **Step 4: Run to green, then the whole suite**

```bash
npx hardhat test contracts/test/IndexerChunking.test.ts && cd "C:/Users/Mhm233-Lifebook/arc" && npm test
```

Expected: 6 new passing; 90 total.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/indexer/chunking.ts contracts/test/IndexerChunking.test.ts
git commit -m "feat(indexer): range-size policy with monotonic ceiling and 429/-32012 split"
```

---

### Task 5: RPC layer — decode and fetch

**Files:**
- Create: `frontend/lib/indexer/decode.ts`
- Create: `frontend/lib/indexer/rpc.ts`

**Interfaces:**
- Consumes: `IndexedEvent` (Task 3), `chunking.ts` (Task 4), `getIndexerConfig()` (Task 1).
- Produces:
```ts
// decode.ts — the ONLY viem-aware indexer file
export const FACTORY_EVENTS;  // parseAbiItem[] for MarketCreated, MarketResolved
export const FPMM_EVENTS;     // parseAbiItem[] for Buy, Sell, LiquidityAdded, LiquidityRemoved
export interface MarketCreatedRow { questionId: bigint; fpmm: string; conditionId: string; question: string; category: string; resolutionTime: bigint; resolver: string; feeBps: number; blockNumber: bigint }
export interface MarketResolvedRow { questionId: bigint; payoutYes: bigint; payoutNo: bigint; blockNumber: bigint }
export function decodeFactoryLogs(logs: unknown[]): { created: MarketCreatedRow[]; resolved: MarketResolvedRow[] };
export function decodeFpmmLogs(logs: unknown[]): IndexedEvent[];

// rpc.ts
export interface IndexerRpc {
  getBlockNumber(): Promise<bigint>;
  getBlockHeader(n: bigint): Promise<{ hash: string; timestamp: bigint }>;
  getLogsAdaptive(args: { address: string | string[]; events: unknown[]; from: bigint; to: bigint }): Promise<{ logs: unknown[]; acceptedSpan: bigint | null; requests: number }>;
}
export function createIndexerRpc(rpcUrl: string, startChunk: bigint): IndexerRpc;
```

Event signatures — copy verbatim from `frontend/lib/abis.ts:18-19,46-49`, do not retype from memory:

```
event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)
event MarketResolved(uint256 indexed questionId, uint256[2] payouts)
event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)
event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)
event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)
event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)
```

**Mind the argument order on `LiquidityRemoved`:** it is `(shares, collateral)`, the reverse of `LiquidityAdded`'s `(collateral, shares)`. Mapping it positionally will silently swap the two and corrupt every replay downstream.

`decodeFpmmLogs` maps to `IndexedEvent` as: `buy` → `collateral = investmentAmount`, `shares = sharesOut`, `actor = buyer`; `sell` → `collateral = returnAmount`, `shares = sharesIn`, `actor = seller`; `liquidity_added` → `collateral`, `shares`, `actor = provider`, `outcome = null`; `liquidity_removed` → same, `outcome = null`. Skip any log with a null `blockNumber`/`logIndex`, an unrecognised `eventName`, or an `outcome` outside `{0,1}` on a trade — mirroring `useTradeLedger.ts:231-261`.

`getLogsAdaptive` behaviour:
- Build ranges with `planRanges`. One request covers **all** FPMM addresses and **all four** event types at once (viem accepts an `address` array and an `events` array, turning the latter into a topic0 OR-set). This is why the whole history is ~14 requests, not thousands.
- On `isRangeTooLarge`, `halve` and recurse into both halves. Never retry the same span.
- On `isRateLimit`, sleep `BACKOFF_MS[attempt]` and retry the same span, up to 4 attempts.
- On any other error, throw — a non-rate-limit, non-range error must not be retried blindly.
- Record `acceptedSpan` only for requests issued at the **full** current chunk size, so a 50-block tail request cannot teach a 50-block ceiling (`lib/logScan.ts:240-250` documents why).
- Use a viem `createPublicClient` with `http(rpcUrl)`; **do not** import `lib/wagmi.tsx` or `lib/chains.ts` — those are client modules.

- [ ] **Step 1: Write `decode.ts`, then `rpc.ts`.**

- [ ] **Step 2: Typecheck and build**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend" && npx tsc --noEmit && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/indexer/decode.ts frontend/lib/indexer/rpc.ts
git commit -m "feat(indexer): viem log decoding and adaptive getLogs with backoff"
```

---

### Task 6: Database access layer

**Files:**
- Create: `frontend/lib/db/pool.ts`
- Create: `frontend/lib/db/queries.ts`

**Interfaces:**
- Produces:
```ts
// pool.ts
export function getPool(): Pool;                  // module-scoped singleton
export function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;

// queries.ts — the ONLY file containing SQL
export async function ensureIndexerState(chainId: number, factory: string, startBlock: bigint): Promise<void>;
export async function acquireLease(chainId: number, owner: string, seconds: number): Promise<IndexerStateRow | null>;
export async function releaseLease(chainId: number, owner: string): Promise<void>;
export async function readIndexerState(chainId: number): Promise<IndexerStateRow | null>;
export async function upsertBlocks(c: PoolClient, chainId: number, rows: BlockRow[]): Promise<void>;
export async function getBlockHash(chainId: number, blockNumber: bigint): Promise<string | null>;
export async function upsertMarkets(c: PoolClient, chainId: number, rows: MarketCreatedRow[], times: Map<string, Date>): Promise<void>;
export async function markResolved(c: PoolClient, chainId: number, rows: MarketResolvedRow[]): Promise<void>;
export async function insertMarketEvents(c: PoolClient, chainId: number, rows: MarketEventInsert[]): Promise<number>;
export async function questionIdByFpmm(chainId: number): Promise<Map<string, bigint>>;
export async function latestReplayState(chainId: number, questionId: bigint): Promise<PoolState | null>;
export async function commitCheckpoint(c: PoolClient, chainId: number, block: bigint, hash: string, acceptedChunk: bigint | null, backfillComplete: boolean): Promise<void>;
export async function recordError(chainId: number, message: string | null): Promise<void>;
export async function truncateAbove(c: PoolClient, chainId: number, cutBlock: bigint): Promise<void>;
export async function selectChartRows(args: ChartQueryArgs): Promise<ChartRow[]>;  // added in Task 10
```

Requirements:

- **`pool.ts` holds the `Pool` at module scope**, so a warm serverless instance reuses connections instead of opening one per request. `max: 3` — Neon's free pooler is generous but a serverless fleet multiplies clients; `idleTimeoutMillis: 10_000`; `connectionTimeoutMillis: 10_000`. Set `ssl: { rejectUnauthorized: true }` unless the URL already carries `sslmode`.
- **Every statement is parameterized.** No exceptions, no interpolation.
- `acquireLease` is the single mutual-exclusion primitive, exactly as specified:

```sql
UPDATE indexer_state
   SET lease_until = now() + make_interval(secs => $3), lease_owner = $2, updated_at = now()
 WHERE chain_id = $1
   AND (lease_until IS NULL OR lease_until < now())
RETURNING chain_id, start_block, last_indexed_block, last_indexed_block_hash,
          backfill_complete, accepted_chunk, last_tick_at, lease_until, lease_owner, last_error;
```

Zero rows means another run holds it → the caller returns immediately having done nothing. A lease is used rather than `pg_advisory_lock` because a transaction-mode pooler gives no session affinity, and because a killed serverless function would never release a session lock whereas a lease expires by itself.

- `insertMarketEvents` ends every insert with `ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`. **Idempotency must not depend on the lease** — a double-run has to be harmless on its own. Return the inserted row count so the caller can log it.
- Batch inserts with a multi-row `VALUES` list built from a parameter array (`$1..$n`), not one round trip per row: Neon round trips dominate the cost. Cap each statement at ~500 rows.
- `latestReplayState` reads the most recent row for a market and is what lets a reorg replay resume from the surviving row below the cut instead of re-replaying from genesis:

```sql
SELECT reserve_yes, reserve_no, total_supply
  FROM market_events
 WHERE chain_id = $1 AND question_id = $2
 ORDER BY block_number DESC, log_index DESC
 LIMIT 1;
```

- `numeric(78,0)` comes back from `pg` as a **string**. Convert with `BigInt(row.reserve_yes)` at the boundary and never let a `number` touch an amount.

- [ ] **Step 1: Write `pool.ts` and `queries.ts`.**

- [ ] **Step 2: Typecheck and build**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend" && npx tsc --noEmit && npm run build
```

- [ ] **Step 3: Smoke-test the lease against a real database**

Write a throwaway script that calls `ensureIndexerState` then `acquireLease` twice in a row with different owners. Expected: first returns a row, second returns `null`. Delete the script afterwards.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/db
git commit -m "feat(indexer): pg pool and parameterized query layer with lease locking"
```

---

### Task 7: The indexer run loop

**Files:**
- Create: `frontend/lib/indexer/run.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4, 5, 6.
- Produces:
```ts
export interface IndexRunOptions { maxBlocks: bigint; maxRequests: number; reason: 'traffic' | 'cron' | 'manual' }
export interface IndexRunResult {
  ranBlocks: bigint; fromBlock: bigint; toBlock: bigint;
  eventsInserted: number; requests: number;
  skippedBecauseLeased: boolean; reorgDepth: number;
  backfillComplete: boolean; error: string | null;
}
export async function runIndexer(opts: IndexRunOptions): Promise<IndexRunResult>;
```

`runIndexer` **never throws** — it returns `error` instead. A thrown error inside `waitUntil()` becomes an unhandled rejection with nowhere to surface.

The loop, in order:

1. `ensureIndexerState(chainId, factory, startBlock)` — read `factory` and `startBlock` from `frontend/lib/deployments/index.json` (chain `5042002` → factory `0x5277062A9Fc026f7AB50a2f2c2E491A829356037`, `startBlock` 55632013). `last_indexed_block` initialises to `start_block - 1`.
2. `acquireLease`. Null → return `{ skippedBecauseLeased: true }` immediately.
3. `safeHead = getBlockNumber() - confirmations`. If `safeHead <= last_indexed_block`, nothing to do: update `last_tick_at`, release, return.
4. **Reorg check.** If `last_indexed_block_hash` is set, fetch that block's header. On mismatch, walk back through `blocks` comparing stored hashes with the chain until one matches (bounded — give up after 256 blocks and report `degraded` rather than walking forever). Then in one transaction: `truncateAbove(cut)`, reset the checkpoint to `cut`, and set `reorgDepth`.
5. `from = last_indexed_block + 1`; `to = min(safeHead, from + maxBlocks - 1)`.
6. Fetch factory logs for `[from, to]` → `decodeFactoryLogs`. Fetch FPMM logs for the **union of all known pool addresses plus any created in this range**, same range → `decodeFpmmLogs`.
7. Fetch block headers for the distinct block numbers appearing in either set, **skipping any already in `blocks`**. One `getBlock` per distinct block, never per event.
8. Group FPMM events by `question_id` (via `questionIdByFpmm` plus this range's new markets), sort each group by `(blockNumber, logIndex)`, seed from `latestReplayState` (or `zeroState()`), and `replay`.
9. **One transaction:** `upsertBlocks` → `upsertMarkets` → `markResolved` → `insertMarketEvents` → `commitCheckpoint(to, hashOf(to), acceptedChunk, to >= safeHead)`. Either the whole range lands or none of it does; the checkpoint can never run ahead of the rows.
10. `releaseLease`. On any error: `recordError`, release the lease, return the error in the result.

Partial progress is always committed — a run that hits `maxBlocks` or its request cap commits what it reached, and the next run continues. Nothing is ever re-scanned.

- [ ] **Step 1: Write `run.ts`.**

- [ ] **Step 2: Typecheck and build.**

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/indexer/run.ts
git commit -m "feat(indexer): forward-only run loop with lease, reorg walk-back, atomic commit"
```

---

### Task 8: Background execution, quarantined

**Files:**
- Create: `frontend/lib/indexer/background.ts`

**Interfaces:**
- Produces: `export function scheduleBackgroundIndex(opts: IndexRunOptions): void;`

This is the **only** module in the codebase that knows how background work is started. Nothing else may import `@vercel/functions`.

```ts
/**
 * The single seam for background execution.
 *
 * waitUntil() from @vercel/functions, NOT after() from next/server: after()
 * requires Next 15.1+ and this project is pinned to 14.2.35, where upgrading is
 * a semver-major change bundled with wagmi/viem (see TODO.md).
 *
 * Everything else calls scheduleBackgroundIndex(). Swapping the mechanism —
 * to after() after a future Next upgrade, to Vercel Queues, to a plain await in
 * a test — is a change to this file alone.
 */
import { waitUntil } from '@vercel/functions';
import { runIndexer, type IndexRunOptions } from './run';

export function scheduleBackgroundIndex(opts: IndexRunOptions): void {
  // runIndexer never throws, so this promise always settles; the catch is a
  // belt-and-braces guard against an unhandled rejection in a background task,
  // which on Vercel would be invisible.
  const work = runIndexer(opts).then(
    (r) => {
      if (r.error) console.error('[indexer] run error', r.error);
    },
    (err) => console.error('[indexer] unexpected throw', err)
  );

  try {
    waitUntil(work);
  } catch {
    // No Vercel runtime (local dev, the Hardhat e2e). waitUntil throws outside
    // a request context, so fall back to letting the promise run detached. The
    // e2e script awaits runIndexer directly instead of going through here, so
    // its assertions are never racing a fire-and-forget.
    void work;
  }
}
```

- [ ] **Step 1: Write the file exactly as above.**

- [ ] **Step 2: Verify nothing else imports the package**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend"
grep -rn "@vercel/functions" --include=*.ts --include=*.tsx . | grep -v node_modules
```

Expected: exactly one hit, in `lib/indexer/background.ts`.

- [ ] **Step 3: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build
cd "C:/Users/Mhm233-Lifebook/arc"
git add frontend/lib/indexer/background.ts
git commit -m "feat(indexer): quarantine background execution behind one module"
```

---

### Task 9: End-to-end proof against a local chain

The decisive test. Arc testnet is unreachable from the dev environment, so this is the only place the whole pipeline is proven before deploy.

**Files:**
- Create: `contracts/scripts/e2e-indexer.ts`

**Interfaces:**
- Consumes: `deploySystem()` from `contracts/test/helpers.ts:16`, `usdc()` from `:6`, `runIndexer` (Task 7), `queries.ts` (Task 6), `replay.ts` (Task 3).
- Produces: a runnable script; no exports.

**Prerequisites the script must check and report clearly if missing:** `DATABASE_URL` pointing at a **scratch** database (it truncates the four tables on start — never point it at production), and a Hardhat node on `http://127.0.0.1:8545`.

- [ ] **Step 1: Write the scenario**

```
1.  Truncate market_events, blocks, markets, indexer_state (scratch DB only).
2.  deploySystem(); mint MockUSDC to two signers; approve the pools.
3.  createMarket x3, including one "Event: Outcome" pair so grouping is exercised.
4.  Market A:  addLiquidity(1000 USDC)
                buy(outcome 0, 100 USDC)
                buy(outcome 1, 50 USDC)
                sell(outcome 0, 25 USDC)
                addLiquidity(200 USDC)      <- pool is now UNBALANCED, so this MOVES the price
                removeLiquidity(half the LP shares)  <- proportional, so this does NOT
5.  Market B:  addLiquidity only (never traded)
6.  Market C:  addLiquidity, one buy, then resolveMarket
7.  Point the indexer at 127.0.0.1:8545 with chainId 31337, startBlock 0,
    confirmations 0 (a Hardhat node does not reorg), and AWAIT runIndexer
    directly — not scheduleBackgroundIndex, so nothing races.
```

The deployments entry for chain 31337 must be supplied to the indexer for this run. Do **not** write a fake entry into `frontend/lib/deployments/index.json`; pass the factory address and start block through `runIndexer`'s config path (add an optional override parameter to `IndexRunOptions` if needed) so the committed deployments file stays truthful.

- [ ] **Step 2: Write the assertions**

Each must fail loudly with the expected-vs-actual values, not just throw:

```
A. Row count equals the number of emitted indexed events. Exactly.
B. For EVERY pool: replayed (reserve_yes, reserve_no) on the latest row EQUALS
   the on-chain reserves() call. Exact equality, not a tolerance — the replay is
   integer arithmetic mirroring the contract. THIS IS THE DECISIVE ASSERTION.
C. total_supply on the latest row equals the pool's on-chain totalSupply().
D. yes_bps on the latest row equals yesProbBps(...on-chain reserves...).
E. Market A's second addLiquidity row has a yes_bps DIFFERENT from the row
   before it.  (addLiquidity moves the price on an unbalanced pool.)
F. Market A's removeLiquidity row has a yes_bps EQUAL to the row before it,
   within 1 bps for integer truncation.  (Proportional withdrawal preserves it.)
G. checksumOk held on the removeLiquidity row (collateral == min(yesOut,noOut)).
H. Market B has exactly one row, kind liquidity_added, yes_bps 5000.
I. Market C is marked resolved with the correct payouts.
J. Every event row's block_time equals that block's on-chain timestamp.
K. blocks holds exactly the DISTINCT event-bearing block numbers — no more.
   (Proves headers are fetched once per block, not once per event.)
L. Run runIndexer a SECOND time: zero rows inserted, identical row count.
M. Reset last_indexed_block to a mid-range value, re-run, and assert the final
   state is byte-identical to before. (Resumability and idempotency together.)
N. Truncate above a mid-range block, reset the checkpoint there, re-run, and
   assert convergence to the same final state. (Reorg recovery.)
O. Call acquireLease with a foreign owner, then runIndexer, and assert it
   returns skippedBecauseLeased with zero rows written.
```

- [ ] **Step 3: Run it**

```bash
# terminal 1
cd "C:/Users/Mhm233-Lifebook/arc" && npm run node
# terminal 2
cd "C:/Users/Mhm233-Lifebook/arc/contracts"
DATABASE_URL='postgresql://…scratch…' npx hardhat run scripts/e2e-indexer.ts --network localhost
```

Expected: every assertion passes, and the script prints the final reserves side by side (replayed vs on-chain) for each pool.

- [ ] **Step 4: If assertion B fails, do NOT loosen it**

A mismatch means the replay diverges from the contract. Debug by printing the replayed state after each event alongside a `reserves()` call at that block, and find the first divergence. The most likely causes, in order: `LiquidityRemoved`'s reversed `(shares, collateral)` argument order; events applied out of `(blockNumber, logIndex)` order; a `number` used where a `bigint` was required.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
git add contracts/scripts/e2e-indexer.ts
git commit -m "test(indexer): end-to-end local proof, replayed reserves vs on-chain"
```

---

## Phase 2 — API (still unused by the UI)

### Task 10: Bucket policy and the chart query

**Files:**
- Create: `frontend/lib/chart/buckets.ts` (**zero imports**)
- Modify: `frontend/lib/db/queries.ts` — add `selectChartRows`
- Test: `contracts/test/ChartBuckets.test.ts`

**Interfaces:**
- Produces:
```ts
// buckets.ts
export type IntervalName = 'auto' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const INTERVAL_SECONDS: Readonly<Record<Exclude<IntervalName,'auto'>, number>>;
export function parseFrom(from: string | null, nowSec: number): number;   // '24h' | '7d' | '30d' | 'all' | unix
export function resolveInterval(name: IntervalName, spanSec: number, limit: number): number;  // → step seconds
export function clampLimit(raw: string | null): number;                    // default 300, hard max 2000

// queries.ts
export interface ChartQueryArgs { chainId: number; questionId: bigint; fromSec: number; toSec: number; stepSec: number; limit: number }
export interface ChartRow { t: number; bps: number }
export async function selectChartRows(args: ChartQueryArgs): Promise<ChartRow[]>;
```

`resolveInterval` for `auto`: span ≤ 1 day → 5m, ≤ 7 days → 15m, ≤ 30 days → 1h, else 1d — **then widen to the next larger step until `spanSec / stepSec <= limit`**, so the response can never exceed `limit` points regardless of span. `parseFrom('all', now)` returns 0.

The SQL — **last** value per bucket, never the average, because an average of a probability path is not a price and would smooth away exactly the extremes a trader is looking for:

```sql
SELECT DISTINCT ON (bucket)
       (floor(extract(epoch FROM block_time) / $5) * $5)::bigint AS bucket,
       yes_bps
  FROM market_events
 WHERE chain_id = $1
   AND question_id = $2
   AND block_time >= to_timestamp($3)
   AND block_time <= to_timestamp($4)
 ORDER BY bucket, block_number DESC, log_index DESC
 LIMIT $6;
```

`$5` is `stepSec` — an integer produced by `resolveInterval`, never a caller string. Order the final result ascending by bucket in JS, or wrap the statement in `SELECT * FROM (…) s ORDER BY bucket`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "chai";
import { clampLimit, parseFrom, resolveInterval } from "../../frontend/lib/chart/buckets";

const DAY = 86400;

describe("chart buckets", () => {
  it("parses relative and absolute from-values", () => {
    const now = 1_756_651_200;
    expect(parseFrom("24h", now)).to.equal(now - DAY);
    expect(parseFrom("7d", now)).to.equal(now - 7 * DAY);
    expect(parseFrom("30d", now)).to.equal(now - 30 * DAY);
    expect(parseFrom("all", now)).to.equal(0);
    expect(parseFrom("1756000000", now)).to.equal(1_756_000_000);
    expect(parseFrom(null, now)).to.equal(now - DAY);   // default 24h
    expect(parseFrom("garbage", now)).to.equal(now - DAY);
  });

  it("picks the documented auto steps", () => {
    expect(resolveInterval("auto", DAY, 2000)).to.equal(300);
    expect(resolveInterval("auto", 7 * DAY, 2000)).to.equal(900);
    expect(resolveInterval("auto", 30 * DAY, 2000)).to.equal(3600);
    expect(resolveInterval("auto", 365 * DAY, 2000)).to.equal(86400);
  });

  it("widens auto until the point count fits the limit", () => {
    // 1 day at 5m is 288 buckets; with limit 100 it must widen.
    const step = resolveInterval("auto", DAY, 100);
    expect(DAY / step).to.be.at.most(100);
    expect(step).to.be.greaterThan(300);
  });

  it("honours an explicit interval", () => {
    expect(resolveInterval("1m", DAY, 2000)).to.equal(60);
    expect(resolveInterval("4h", 30 * DAY, 2000)).to.equal(14400);
  });

  it("clamps limit to a sane integer", () => {
    expect(clampLimit(null)).to.equal(300);
    expect(clampLimit("50")).to.equal(50);
    expect(clampLimit("999999")).to.equal(2000);
    expect(clampLimit("0")).to.equal(300);
    expect(clampLimit("-5")).to.equal(300);
    expect(clampLimit("abc")).to.equal(300);
    expect(clampLimit("12.9")).to.equal(12);
  });
});
```

- [ ] **Step 2: Run, confirm failure. Step 3: implement both. Step 4: run to green.**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npx hardhat test contracts/test/ChartBuckets.test.ts && npm test
```

Expected: 6 new passing; 96 total.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/chart frontend/lib/db/queries.ts contracts/test/ChartBuckets.test.ts
git commit -m "feat(api): bucket policy and downsampled chart query"
```

---

### Task 11: Route handlers

**Files:**
- Create: `frontend/app/api/markets/[questionId]/chart/route.ts`
- Create: `frontend/app/api/indexer/tick/route.ts`
- Create: `frontend/app/api/indexer/status/route.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 8, 10.
- Produces: three HTTP endpoints. The chart response shape is consumed by Task 12.

All three need `export const runtime = 'nodejs'` (`pg` uses TCP sockets, unavailable on the edge runtime) and `export const dynamic = 'force-dynamic'` (never statically cached at build time).

**`GET /api/markets/[questionId]/chart`**

Query params: `outcome` (`0`|`1`, default `0`), `from`, `to`, `interval`, `limit`. Validate `questionId` as a non-negative integer and reject anything else with **400**, before touching the database.

```json
{
  "points": [{ "t": 1756651200, "bps": 4200 }],
  "meta": {
    "questionId": 3, "outcome": 0, "interval": "5m",
    "complete": true, "lastIndexedBlock": 57301912, "blocksBehind": 4
  }
}
```

- `outcome=1` returns `10000 - bps` per point. Binary markets make NO exactly the complement, which is why no second row is stored per event.
- `meta.complete` is the state row's `backfill_complete`.
- **After building the response and before returning it**, if `now - last_tick_at > staleSeconds`, call `scheduleBackgroundIndex({ maxBlocks: trafficMaxBlocks, maxRequests: 6, reason: 'traffic' })`. The response must not await it.
- On a database error return **200** with `{ points: [], meta: { …, degraded: true } }` rather than a 5xx. The hook falls back to the RPC sweep on a non-OK response, and a chart that silently degrades to the slow path beats one that shows an error.
- Set `Cache-Control: public, s-maxage=15, stale-while-revalidate=60`. Cheap protection against many simultaneous users hitting the same market, with no Redis.

**`POST /api/indexer/tick`** (and `GET`, since Vercel Cron issues GET)

- Require `Authorization: Bearer <CRON_SECRET>`. Compare with a **timing-safe** comparison (`node:crypto` `timingSafeEqual` on equal-length buffers). If `CRON_SECRET` is unset, return **503** — never run unauthenticated.
- `await runIndexer({ maxBlocks: cronMaxBlocks, maxRequests: 40, reason: 'cron' })` and return the `IndexRunResult` as JSON. Cron may await; only the user-facing path must not.
- `export const maxDuration = 300;` — the Fluid-compute ceiling on Hobby, and Pro's default.

**`GET /api/indexer/status`**

Exactly the required shape, plus diagnostics:

```json
{
  "latestBlockchainBlock": 57301916,
  "latestIndexedBlock": 57301904,
  "blocksBehind": 12,
  "status": "healthy",
  "backfillComplete": true,
  "lastTickAt": "2026-09-01T09:14:02.000Z",
  "leaseHeld": false,
  "lastError": null
}
```

`status`: `healthy` when `blocksBehind <= confirmations + 50` and `lastError` is null; `syncing` when `backfill_complete` is false; `degraded` when `lastError` is set; `stalled` when `last_tick_at` is older than 48h (twice the daily cron interval, so one missed run is not an alarm). Requires no auth — it leaks no secret and being able to check health without a token is the point.

- [ ] **Step 1: Write the three routes.**

- [ ] **Step 2: Verify the build registers them**

```bash
cd "C:/Users/Mhm233-Lifebook/arc/frontend" && npx tsc --noEmit && npm run build
```

Expected: 14 routes (11 existing + 3 new), each new one marked dynamic (`ƒ`), not static.

- [ ] **Step 3: Exercise them locally**

With the scratch `DATABASE_URL` and `CRON_SECRET=devsecret` in `frontend/.env.local`, and the Hardhat node plus Task 9's data in place:

```bash
npm run dev
curl -s 'http://localhost:3000/api/indexer/status' | head -20
curl -s 'http://localhost:3000/api/markets/0/chart?from=all&interval=auto&limit=50'
curl -s 'http://localhost:3000/api/markets/0/chart?from=all&outcome=1&limit=50'
curl -s -i 'http://localhost:3000/api/indexer/tick'                       # expect 401
curl -s -i -H 'Authorization: Bearer devsecret' 'http://localhost:3000/api/indexer/tick'
curl -s -i 'http://localhost:3000/api/markets/notanumber/chart'            # expect 400
```

Expected: status returns JSON; the chart returns ascending `t` values; `outcome=1` values are the complement of `outcome=0`; the unauthenticated tick is 401; the bad id is 400.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
git add frontend/app/api
git commit -m "feat(api): chart, indexer tick and status route handlers"
```

---

## Phase 3 — Frontend

### Task 12: `useTradeHistory` reads the API

**Files:**
- Modify: `frontend/hooks/useTradeHistory.ts` — `TradePoint` at `:114-118`, the hook body at `:180-247`, and the file's doc comment at `:1-54`

**Interfaces:**
- Consumes: the chart API from Task 11.
- Produces: the unchanged `TradeHistory` shape, plus `TradePoint.t`:
```ts
export interface TradePoint { bps: number; kind: 'buy' | 'sell' | 'now'; t?: number }
```

`app/market/[id]/page.tsx` must need **zero edits** — the signature `useTradeHistory(fpmm, currentBps)` and the returned `{ points, isLoading, degraded, complete, refresh }` are unchanged.

Requirements:

- The hook needs the **`questionId`**, which it does not currently receive; it takes an `fpmm` address. Add an optional third parameter `questionId?: bigint` and pass `market.questionId` from `app/market/[id]/page.tsx:108`. That is a one-line call-site change — the earlier "zero edits" claim covers the *component*, and this is the one exception; make it explicitly.
- `NEXT_PUBLIC_CHART_SOURCE` selects the path. Read it as a **literal** `process.env.NEXT_PUBLIC_CHART_SOURCE` access, never a computed one — Next only inlines static property accesses (`lib/links.ts:15` documents this trap).
  - `api` (default): fetch only. On failure, `degraded: true` and just the live point.
  - `rpc`: the existing sweep, untouched.
  - `auto`: try the API; on a non-OK response or a throw, fall back to the sweep.
- Keep `loadTrades` and every existing import. They are the fallback, not dead code — **do not delete them**, and do not delete the `EV_BUY`/`EV_SELL` definitions or `priceBps`.
- The API returns `{ t, bps }` ascending. Map to `TradePoint` with `kind: 'buy'` — the API does not distinguish direction, and the chart only uses `kind` to label the live point and the `sr-only` table. Note this in a comment so nobody later "fixes" it by adding a direction column the chart cannot use.
- The `'now'` point gets `t: Math.floor(Date.now() / 1000)` so a time axis has a right-hand anchor.
- Request `interval=auto&limit=200&from=all` to match the existing `MAX_POINTS = 200`.
- Keep the React Query config as-is (`staleTime` 5min, `retry: false`, no `refetchInterval`) and keep `refresh` as invalidate-only.
- Rewrite the file's header comment. It currently states "the x-axis is trade SEQUENCE, which is why there are no time-range tabs" and "Do NOT reintroduce a reserve replay" — the first is now false and the second is true only of the browser. Say what is true: history comes from the indexer API, the browser never fetches block headers, the replay happens server-side, and the RPC sweep below is the permanent fallback.

- [ ] **Step 1: Make the changes. Step 2: typecheck and build.**

- [ ] **Step 3: Verify all three modes by hand**

With the dev server and Task 9's local data: set `NEXT_PUBLIC_CHART_SOURCE` to `api`, then `rpc`, then `auto` (restart `npm run dev` each time — these are build-time inlined). Confirm the chart renders in all three, and that `auto` still renders with `DATABASE_URL` deliberately broken.

- [ ] **Step 4: Confirm the browser makes no chart log calls in `api` mode**

Open devtools → Network, filter for the RPC host, and load a market page. Expected: **no `eth_getLogs` for the chart.** Calls for `markets`, `reserves` and balances are expected and correct — those are live state, not history.

- [ ] **Step 5: Commit**

```bash
git add frontend/hooks/useTradeHistory.ts frontend/app/market/
git commit -m "feat(chart): read history from the indexer API, keep RPC sweep as fallback"
```

---

### Task 13: Real time x-axis

**Files:**
- Create: `frontend/lib/chartScale.ts` (**zero imports**)
- Test: `contracts/test/ChartScale.test.ts`
- Modify: `frontend/components/PriceChart.tsx` — `:200-205`, `:324-332`, `:354-372`, header comment `:8-52`

**Interfaces:**
- Produces:
```ts
export interface ScalePoint { bps: number; t?: number }
export interface XScale { mode: 'time' | 'sequence'; xAt(i: number): number; ticks: Array<{ x: number; label: string }> }
export function buildXScale(points: ScalePoint[], padLeft: number, plotW: number, tickCount?: number): XScale;
```

`buildXScale` is where the mode decision lives, and it is a pure function precisely so it can be tested without a DOM:

| Condition | Mode |
|---|---|
| ≥2 points, **every** point has a finite `t`, and `tMax > tMin` | `time` |
| anything else | `sequence` |

- `time`: `x = padLeft + ((t - tMin) / (tMax - tMin)) * plotW`.
- `sequence`: `x = padLeft + (i / (n - 1)) * plotW`, and for `n === 1`, `padLeft + plotW` — **exactly the current behaviour at `PriceChart.tsx:200-205`**, so a single point still parks at the right edge and an untraded market still draws its flat dashed line.
- `ticks`: in `time` mode, `tickCount` (default 4) evenly spaced labels formatted with `Intl.DateTimeFormat` — time-of-day when the span is under a day, day+month under a year, month+year beyond. In `sequence` mode, `ticks` is `[]`, so the axis simply has no labels, as today.

**Do not add a date library.** `DEPENDENCIES.md` rejects `date-fns`/`dayjs` and `lib/time.ts` already establishes `Intl` as the convention.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "chai";
import { buildXScale } from "../../frontend/lib/chartScale";

const PAD = 26, W = 600;

describe("chart x-scale", () => {
  it("falls back to sequence when any timestamp is missing", () => {
    const s = buildXScale([{ bps: 5000, t: 1 }, { bps: 5100 }], PAD, W);
    expect(s.mode).to.equal("sequence");
    expect(s.xAt(0)).to.equal(PAD);
    expect(s.xAt(1)).to.equal(PAD + W);
    expect(s.ticks).to.deep.equal([]);
  });

  it("falls back to sequence when every timestamp is identical", () => {
    const s = buildXScale([{ bps: 1, t: 99 }, { bps: 2, t: 99 }], PAD, W);
    expect(s.mode).to.equal("sequence");
  });

  it("parks a lone point at the right edge, as the flat-line case needs", () => {
    const s = buildXScale([{ bps: 5000, t: 42 }], PAD, W);
    expect(s.mode).to.equal("sequence");
    expect(s.xAt(0)).to.equal(PAD + W);
  });

  it("positions by time, not by index", () => {
    // Three points where the middle one is 10% of the way through the span.
    const s = buildXScale(
      [{ bps: 1, t: 0 }, { bps: 2, t: 10 }, { bps: 3, t: 100 }], PAD, W
    );
    expect(s.mode).to.equal("time");
    expect(s.xAt(0)).to.equal(PAD);
    expect(s.xAt(1)).to.be.closeTo(PAD + 0.1 * W, 0.001);
    expect(s.xAt(2)).to.equal(PAD + W);
    // A sequence scale would have put the middle point at the halfway mark.
    expect(s.xAt(1)).to.be.lessThan(PAD + 0.4 * W);
  });

  it("emits in-range, ordered ticks with non-empty labels", () => {
    const now = 1_756_651_200;
    const s = buildXScale(
      [{ bps: 1, t: now - 86400 }, { bps: 2, t: now }], PAD, W, 4
    );
    expect(s.ticks).to.have.length(4);
    for (const tk of s.ticks) {
      expect(tk.x).to.be.at.least(PAD);
      expect(tk.x).to.be.at.most(PAD + W);
      expect(tk.label).to.be.a("string").and.not.empty;
    }
    const xs = s.ticks.map((t) => t.x);
    expect(xs).to.deep.equal([...xs].sort((a, b) => a - b));
  });

  it("never returns NaN for a degenerate input", () => {
    for (const pts of [[], [{ bps: 5000 }]]) {
      const s = buildXScale(pts as { bps: number; t?: number }[], PAD, W);
      expect(Number.isFinite(s.xAt(0))).to.equal(true);
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure. Step 3: implement `chartScale.ts`. Step 4: run to green.**

```bash
cd "C:/Users/Mhm233-Lifebook/arc" && npx hardhat test contracts/test/ChartScale.test.ts && npm test
```

Expected: 6 new passing; 102 total.

- [ ] **Step 5: Wire it into `PriceChart.tsx`**

Replace the `coords` computation at `:200-205`:

```tsx
const scale = buildXScale(points, PAD_LEFT, plotW);
const coords = points.map((p, i) => ({
  x: scale.xAt(i),
  y: yForPct(Math.max(0, Math.min(10000, p.bps)) / 100),
  kind: p.kind,
  bps: p.bps,
}));
```

Everything downstream of `coords` — `linePath`, the circles, the live marker, the flat dashed no-history line — is unchanged. `hasHistory` stays `points.length > 1`.

Then add the x tick labels beneath the SVG, as a sibling of the existing y-label block at `:324-332`, absolutely positioned at each `tick.x`, `aria-hidden="true"`, rendered only when `scale.ticks.length > 0`. Reserve the vertical space unconditionally so the plot does not shift height between modes.

Finally, add a fourth column to the `sr-only` table at `:354-372` — header `Time`, cell `p.t ? new Date(p.t * 1000).toLocaleString() : '—'` — and update the `<caption>` from "per trade" to "over time". The accessible rendering must stay equivalent to the visual one.

- [ ] **Step 6: Rewrite the component's header comment**

`:8-52` currently says "The x-axis is trade SEQUENCE, not time, which is what lets the whole thing avoid fetching a timestamp for every block". Replace with the truth: timestamps come from the indexer, the browser never fetches block headers, the axis is time when timestamps are present, and sequence spacing survives as the fallback for the RPC path. **Keep** the two rendering-bug postmortems at `:20-38` and the untraded-market explanation at `:39-51` — they document live behaviour that this change does not alter.

- [ ] **Step 7: Verify visually, in both modes**

`npm run dev`, open a market with several trades in `api` mode: confirm date labels, uneven spacing, round dots, and a right-edge live dot. Then switch to `rpc` mode and confirm the chart still renders with even spacing and no labels. Then narrow the browser to a phone width and confirm the labels do not collide.

- [ ] **Step 8: Commit**

```bash
git add frontend/lib/chartScale.ts frontend/components/PriceChart.tsx contracts/test/ChartScale.test.ts
git commit -m "feat(chart): real time x-axis with sequence fallback for the RPC path"
```

---

## Phase 4 — Deploy, document, measure

### Task 14: Cron, documentation, and the deployment runbook

**Files:**
- Create: `vercel.json` (repo root — note Vercel's Root Directory is `frontend`, so verify whether it must live at `frontend/vercel.json`; test with a preview deploy before trusting either)
- Create: `docs/DEPLOYMENT-INDEXER.md`
- Modify: `DEPENDENCIES.md`, `TODO.md`

- [ ] **Step 1: Add the daily cron**

```json
{
  "crons": [
    { "path": "/api/indexer/tick", "schedule": "17 3 * * *" }
  ]
}
```

`17 3 * * *`, not `0 3 * * *`: an off-minute avoids the top-of-hour stampede every scheduler sees. **Daily is deliberate** — per-minute would keep Neon's compute awake continuously (~180 CU-hours/month against a 100 CU-hour free allowance) and suspend the database for the rest of the billing month. Hobby also rejects sub-daily expressions at deploy time. Traffic is the primary trigger; this is the floor.

- [ ] **Step 2: Write `DEPENDENCIES.md` entries**

**Match the file's formatting exactly: line 1 has ONE leading space, every other non-blank line has EXACTLY TWO leading spaces, and the file has no trailing newline** — append after `…by this change.`, adding a newline first. Verify with `grep -c '^  ' DEPENDENCIES.md` before and after.

Add a section `### Added in the chart indexer change: pg + @vercel/functions` with the four-point format for each package (why chosen · why secure · why over alternatives · 7-day compliance), using the verified dates: `pg@8.23.0` published 2026-08-08, `@vercel/functions@3.9.5` published 2026-08-20.

Then add `### Reversal: the "no database / no indexer" entry above is now superseded`, stating plainly what changed. The original rejection said `getLogs` was cheap because "one bounded sweep covers every market and both event types in ~6 requests" — true of the request *count*, false of the *outcome*, because the sweep is bounded by a 40-request budget across a 1.7M-block window it cannot finish. That is why the chart never reported `complete` and why `logCache` had to exist. The reasoning was sound; the premise was wrong. Also note that "Vercel serverless has no persistent disk" is still true and now irrelevant — persistence is Neon's, not the function's.

- [ ] **Step 3: Write `docs/DEPLOYMENT-INDEXER.md`**

Cover, in order, with exact commands:

1. **Provision Neon** via the Vercel Marketplace integration, so `DATABASE_URL` is injected into the project automatically. Note the free tier: 0.5 GB, 100 CU-hours/month, scale-to-zero after 5 min idle.
2. **Environment variables** — the full table from the spec's Security section, marking which are required (`DATABASE_URL`, `CRON_SECRET`) and which have defaults. Generate `CRON_SECRET` with `openssl rand -hex 32`. State explicitly that none of these except `NEXT_PUBLIC_CHART_SOURCE` may be `NEXT_PUBLIC_`.
3. **Run migrations**: `DATABASE_URL='…' npm run db:migrate` from `frontend/`. Idempotent; safe to re-run on every deploy.
4. **Initial backfill**: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/indexer/tick` repeatedly until `/api/indexer/status` reports `backfillComplete: true`. Each call is bounded and resumable, so a timeout costs one range, not the run. Include a copy-pasteable loop that polls status between calls.
5. **Determine the real chunk ceiling.** `INDEXER_CHUNK_BLOCKS` defaults to 250,000, inferred from the frontend constants and the documented 1,048,576 refusal but **never measured against Arc**. Watch the first backfill's request count; if `-32012` appears, the adaptive halving handles it and `accepted_chunk` records what worked. Read it back with `psql -c 'SELECT accepted_chunk FROM indexer_state'` and set the env var to that value so later runs skip the probe.
6. **Enable the frontend**: set `NEXT_PUBLIC_CHART_SOURCE=api` and redeploy (build-time inlined, so a redeploy is required).
7. **Monitoring**: `/api/indexer/status`; what each `status` value means; that `blocksBehind` up to `confirmations + 50` is healthy.
8. **Restart / resume**: the indexer is stateless — just call `tick` again. To force a re-index of a range: `DELETE FROM market_events WHERE chain_id=$1 AND block_number > $2` then `UPDATE indexer_state SET last_indexed_block=$2, last_indexed_block_hash=NULL`. Both inside one transaction.
9. **Clearing a stuck lease**: `UPDATE indexer_state SET lease_until = NULL WHERE chain_id = $1`. Note that a lease expires on its own within 2 minutes, so this is for impatience, not correctness.
10. **Rebuild from empty**: truncate the four tables and re-run migrations plus backfill. The chain is the source of truth, so nothing is lost — state the expected wall-clock.
11. **Rotating `DATABASE_URL`**: update the env var and redeploy; the pool is per-instance so no draining is needed.
12. **Rollback**: `git revert` the frontend commits, or set `NEXT_PUBLIC_CHART_SOURCE=rpc` for an instant revert to the old path with no deploy of code changes. Baseline `7c03dbc` is the full fallback.

- [ ] **Step 4: Record the performance comparison**

The spec requires a before/after measurement. Add a `## Measured results` section to `docs/DEPLOYMENT-INDEXER.md` with a table filled in from real numbers, not estimates: chart initial load (ms), `eth_getLogs` requests issued by the browser, API response time (p50/p95), SQL query time from `EXPLAIN ANALYZE`, points returned, and behaviour at 10 / 100 / 1000+ points. Capture the "before" from the `rpc` mode against the same market so the comparison is like-for-like. **If a number cannot be measured, write that it was not measured — do not estimate.**

- [ ] **Step 5: Update `TODO.md`**

Add a session entry at the top (the file is reverse-chronological, flush-left, unlike `DEPENDENCIES.md`): what was built, the verification results, the two new dependencies, and the items that remain open — the unmeasured Arc chunk ceiling, `waitUntil()` unproven until a real deploy, no frontend test runner, and `/profile` + `/leaderboard` still on the log sweep. Close out the "no backend exists" note.

- [ ] **Step 6: Final full verification**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
npm test
cd frontend && npx tsc --noEmit && npm run build
```

Expected: 102 passing, 0 type errors, build succeeds with 14 routes.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Mhm233-Lifebook/arc"
git add vercel.json docs/DEPLOYMENT-INDEXER.md DEPENDENCIES.md TODO.md
git commit -m "docs(indexer): daily cron, deployment runbook, dependency entries and reversal"
```

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks: architecture → 1/6/7/11; why-Neon and why-not-per-minute → 14 (cron) and the Global Constraints; what-is-indexed (6 events + timestamps) → 5/7; price correctness and the replay table → 3; schema and the three deviations → 2; forward-only single pointer and per-run caps → 7; traffic-triggered catch-up and the quarantined mechanism → 8/11; lease vs advisory lock → 6; range handling/retries/backoff → 4/5; finality and reorgs → 7 (+ e2e assertion N); reconciliation → **gap, see below**; API and downsampling → 10/11; status endpoint → 11; frontend change and the time axis → 12/13; security → Global Constraints + 1/6/11; local testing → 9; phasing → the phase headings; deployment → 14; dependency record → 1/14.

**One gap found and accepted, not silently dropped:** the spec's **periodic reconciliation** (calling `reserves()` on-chain and comparing with the replayed values, to catch stray ERC-1155 transfers into a pool) has no task. It is asserted *once* in Task 9 assertion B against the local chain, which proves the replay arithmetic, but there is no recurring production check. Adding it means an extra `eth_call` per market on the cron path plus a `degraded` transition. **Recommendation: ship Tasks 1–14, then add reconciliation as a small follow-up** once real Arc data exists to reconcile against — building it now would be tested only against a Hardhat node that cannot produce the anomaly it exists to detect. Flagging rather than quietly omitting.

**Placeholder scan.** No TBD/TODO, no "add appropriate error handling", no "similar to Task N". Every test step carries runnable code. Two places name a decision the implementer must make and record rather than leaving open: the `db:migrate` runner form (Task 1 Step 3) and `vercel.json`'s location given Root Directory = `frontend` (Task 14 Step 1) — both have a stated verification method.

**Type consistency.** `IndexedEvent`, `PoolState`, `ReplayedEvent`, `IndexRunOptions`, `IndexRunResult`, `ChartQueryArgs`, `ChartRow`, `IntervalName`, `ScalePoint`, `XScale` are each defined once and referenced with the same field names throughout. `yesProbBps` deliberately shares its name with `lib/pricing.ts:25-29` because it must be behaviourally identical; `execYesBps` is distinct from `lib/ledger.ts`'s `tradePriceBps`, which does not flip to the YES side and must not be unified with it. `collateral`/`shares` keep one meaning per event kind, tabulated in Task 5. Task 12 flags the single call-site edit in `app/market/[id]/page.tsx` that the "zero edits" claim would otherwise have hidden.

**Task count:** 14. **New tests:** 28 assertions across four files, plus 15 lettered end-to-end assertions.

---
