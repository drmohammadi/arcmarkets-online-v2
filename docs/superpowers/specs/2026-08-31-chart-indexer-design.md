# Chart Data Indexer — Design

**Date:** 2026-08-31 · revised 2026-09-01
**Status:** Approved; implementation plan next
**Baseline commit:** `7c03dbc` (working `eth_getLogs` chart, the rollback point)

### Revision 2026-09-01

Five owner decisions taken after the original draft. Each is reflected in the
body below; recorded here so the diff is legible.

1. **Background execution is `waitUntil()` from `@vercel/functions`, not
   `after()` from `next/server`.** `after()` requires Next 15.1+; this project is
   pinned to **Next 14.2.35**, and upgrading is a semver-major change that
   `TODO.md:399-409` deliberately keeps as isolated work. The mechanism is
   quarantined behind `lib/indexer/background.ts` so it can be swapped later
   without touching the indexer or API design.
2. **Cron is daily**, flatly — not "hourly on Pro, daily on Hobby". Traffic is
   the primary trigger; cron is only the floor for when nobody visits.
3. **A real timestamp-based x-axis is now IN scope** (Polymarket-style). This
   was previously a non-goal. `PriceChart.tsx` therefore *does* change, and the
   standing `CLAUDE.md` rule forbidding a time axis is rewritten rather than
   worked around.
4. **Two new dependencies, both version-verified:** `pg@8.23.0` (published
   2026-08-08) and `@vercel/functions@3.9.5` (published 2026-08-20). Against a
   2026-09-01 clock these are 24 and 12 days old, so both clear the project's
   7-day release-age floor with margin.
5. **The git baseline is preserved.** `7c03dbc` and `60151a9` are not rewritten,
   amended, or force-pushed.

## Problem

`frontend/hooks/useTradeHistory.ts` builds the price chart by scanning
`eth_getLogs` from the browser. The floor is the factory's deploy block
(55,632,013); the chain head is past 57,300,000. Every cold load therefore
crawls ~1.67M blocks backward against an RPC that caps ranges at 1,048,576
blocks (`-32012`) and rate-limits aggressively.

The window, not the call count, is the cost. Each tab re-derives the accepted
chunk size by trial and error, halves on refusal, absorbs 429s, and stops at a
40-request budget — per pool. `lib/logCache.ts` exists only to avoid re-paying
that sweep. The chart is slow, unreliable, and permanently reports
"Older trades may still be loading."

## Architecture

```
Arc L1 → RPC → Vercel Route Handler (indexer) → Neon Postgres
                                                     ↓
                        Vercel Route Handler (chart API) → Frontend → PriceChart
```

RPC remains the source of truth. Postgres is a read-optimized projection.

| Layer | Choice |
|---|---|
| Managed Postgres | Neon free tier |
| Indexer runtime | Next.js Route Handler in the existing `frontend/` app |
| Chart API | Next.js Route Handler, same app |
| Scheduling | Traffic-triggered `waitUntil()` + daily Vercel Cron as a floor |
| Concurrency control | Postgres lease row |
| New npm dependencies | `pg@8.23.0`, `@vercel/functions@3.9.5` |

No VPS, no Docker, no Kubernetes, no Redis, no queue service, no second deploy
target, no ORM.

### Why Neon over Supabase

Supabase's free tier **pauses projects after 1 week of inactivity**, which would
silently stop the indexer — precisely the "database quietly stops representing
the chain" failure this design must prevent. Neon scales compute to zero after
5 minutes idle and wakes on demand, with no pause-and-delete behaviour.

Vercel Postgres no longer exists; it was migrated to Neon in December 2024, so
Neon is also the path of least resistance for credential injection.

### Why per-minute polling is wrong here

Neon's free tier allows 100 CU-hours/month and **suspends compute for the rest
of the billing month** when that is exceeded. Neon stays awake ~5 minutes after
any activity, so a cron every minute keeps compute effectively always on —
roughly 180 CU-hours at the 0.25 CU floor. That would kill the database.

Scheduling is therefore inverted from the obvious design:

- **Traffic-triggered catch-up is primary.** Neon is awake only while the site
  is in use, which is exactly when freshness matters.
- **Cron is a daily floor.** Not hourly, not per-minute: daily. Its only job is
  to advance the checkpoint on a site nobody visited. Vercel Hobby caps cron at
  once per day and rejects finer expressions at deploy time, so a daily entry
  is also the one schedule that is valid on every plan without change.

This costs nothing in perceived freshness. The chart appends the **live pool
price** as its final point (`currentBps`, from `yesProbBps` via `useMarket`).
That point comes from RPC and is always current, so indexer lag affects only
the history, never the right edge of the line.

## What is indexed, and why

| Source | Event | Why |
|---|---|---|
| `MarketFactory` | `MarketCreated` | Yields the FPMM address set to watch (pools are deployed via `new`, so addresses are not knowable in advance), `created_block`, and `fee` — which the `Market` struct does not store. Currently never queried by the app. |
| `MarketFactory` | `MarketResolved` | Marks a market terminal; ends its series honestly. |
| `FixedProductMarketMaker` | `Buy`, `Sell` | The trades. Primary price source. |
| `FixedProductMarketMaker` | `LiquidityAdded`, `LiquidityRemoved` | **`removeLiquidity` moves the price with no Buy/Sell emitted** (`FixedProductMarketMaker.sol:149-156` hands residual single-outcome tokens to the LP). Today's chart silently misses that move. |
| Block header | `timestamp`, `hash` | Timestamps make a time axis and time-bucketing possible at all; hashes are the reorg witness. Fetched once per block *containing events*, cached forever. |

**Not indexed:** `Social.sol` (usernames, comments) and `MarketMetadata`. Not
chart data, and both are cheap point reads with no scan involved.

## Price correctness

### The defect being fixed

Today every historical point is a **fee-inclusive average execution price** —
`investmentAmount / sharesOut` where `investmentAmount` is gross of fee
(`FixedProductMarketMaker.sol:170`), or `returnAmount / sharesIn` where
`returnAmount` is net (`:184`). The final `'now'` point is the pool's
**marginal price**, `yesProbBps(reserveYes, reserveNo)`.

Those are different quantities. Buys are biased up by roughly the fee and sells
down, so the last segment of every line carries a systematic jump that is not a
price move. With `MAX_FEE = 1000` that is up to ±10%.

### The decision

**The chart plots marginal implied probability**, `reserveNo / (reserveYes +
reserveNo)`, in basis points, for every point including the last.

This is the correct choice because it is the quantity the rest of the app
already means by "price": the trade panel quotes it, market cards display it,
and `lib/pricing.ts:25-29` defines it. Execution price is a property of an
individual fill — right for a cost basis, wrong for a probability line.

The discontinuity is fixed by correcting the *history*, not the live point.

### Reserves are exactly reconstructible from events alone

No RPC reads, no archive node, and no `fee` value are required. Derived from
`FixedProductMarketMaker.sol`:

| Event | Reserve effect | Source |
|---|---|---|
| `LiquidityAdded(_, collateral, shares)` | `yes += collateral; no += collateral` | `:103` splits the full amount into sets |
| `Buy(_, outcome, investmentAmount, sharesOut)` | `yes += inv; no += inv;` then `bought -= sharesOut` | `:212-215` splits *all* of `investmentAmount`, then transfers out |
| `Sell(_, outcome, returnAmount, sharesIn)` | `sold += sharesIn;` then `yes -= ret; no -= ret` | `:237-239` takes shares in, merges `returnAmount` full sets |
| `LiquidityRemoved(_, shares, collateral)` | `yes -= shares·yes/totalSupply; no -= shares·no/totalSupply` | `:134-135`; `totalSupply` replayed from LP `shares` in both liquidity events |

The fee needs no special handling — it is already baked into `sharesOut` and
`sharesIn` by `calcBuyAmount` / `calcSellAmount`.

Every formula above reads **pre-event** reserves and `totalSupply` and writes
post-event ones, so events must be applied in strict `(block_number, log_index)`
order. `total_supply` is replayed alongside: `+= shares` on `LiquidityAdded`,
`-= shares` on `LiquidityRemoved`.

`removeLiquidity` emits `collateral = min(yesOut, noOut)` (`:140`), which is a
**free checksum on every LP exit**: if the replayed `min` disagrees with the
emitted value, the replay has drifted and the indexer flags it immediately.

Two derived columns are stored per event:

- `yes_bps` — the marginal price **after** the event, i.e.
  `reserve_no · 10000 / (reserve_yes + reserve_no)`, integer-truncated exactly as
  `yesProbBps` does. This is what the chart plots.
- `exec_yes_bps` — the execution price of the fill, expressed on the YES side:
  `collateral · 10000 / shares`, then `10000 - that` when `outcome = 1`. NULL for
  liquidity events, which have no execution price. Stored for analysis and for
  parity checks against the old chart; **not plotted.**

All arithmetic is integer `BigInt` / `numeric(78,0)`, matching the contract
exactly. No floats anywhere in the price path.

## Schema

Migrations are plain numbered `.sql` files under `frontend/db/migrations/`,
applied by a small runner (`frontend/db/migrate.ts`) that records applied
filenames in a `schema_migrations` table. No ORM, no migration framework.

```sql
CREATE TABLE indexer_state (
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

-- Only blocks CONTAINING events. Timestamp cache and reorg witness.
CREATE TABLE blocks (
  chain_id     bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash   text   NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE markets (
  chain_id        bigint NOT NULL,
  question_id     bigint NOT NULL,
  fpmm            text   NOT NULL,
  condition_id    text   NOT NULL,
  question        text   NOT NULL,
  category        text   NOT NULL,
  resolution_time timestamptz NOT NULL,
  resolver        text   NOT NULL,
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

-- Join key from an FPMM log back to its market.
CREATE UNIQUE INDEX markets_fpmm_uk ON markets (chain_id, fpmm);
```

```sql
-- Raw event args AND the replayed reserves, append-only.
CREATE TABLE market_events (
  chain_id     bigint  NOT NULL,
  block_number bigint  NOT NULL,
  log_index    integer NOT NULL,
  tx_hash      text    NOT NULL,
  question_id  bigint  NOT NULL,
  fpmm         text    NOT NULL,
  kind         text    NOT NULL
    CHECK (kind IN ('buy','sell','liquidity_added','liquidity_removed')),
  actor        text    NOT NULL,
  outcome      smallint CHECK (outcome IN (0,1)),   -- NULL for liquidity events
  collateral   numeric(78,0) NOT NULL,
  shares       numeric(78,0) NOT NULL,
  reserve_yes  numeric(78,0) NOT NULL,   -- replayed, post-event
  reserve_no   numeric(78,0) NOT NULL,
  total_supply numeric(78,0) NOT NULL,   -- replayed LP supply
  yes_bps      integer NOT NULL,         -- marginal price, == yesProbBps(...)
  exec_yes_bps integer,                  -- execution price, YES side; NULL for liquidity
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- The only chart index.
CREATE INDEX market_events_chart
  ON market_events (chain_id, question_id, block_time);
```

Two indexes beyond primary keys, deliberately — writes must stay cheap.

### Three deviations from the requested schema

1. **`(chain_id, block_number, log_index)` as primary key rather than
   `UNIQUE (transaction_hash, log_index)`.** Equivalent for deduplication —
   `log_index` is unique within a block — but it is also the natural
   chronological sort key, so one index serves both idempotency and ordering.
   `tx_hash` is still stored for traceability.

2. **No `outcome_id` on the price series.** These markets are binary at every
   layer, so NO is *exactly* `10000 - yes_bps`. Storing both outcomes doubles
   rows for zero information. `?outcome=1` flips in the API.

3. **Raw events and replayed prices in one table, not separate
   `market_price_history` and `liquidity_events` tables.** `removeLiquidity`
   moves the price, so liquidity events belong *in* the price series. One table
   means no join on the hot path and one place to truncate on reorg.

Raw event fields are preserved in full, so nothing is lost by the merge.

## The indexer

One pure module, `frontend/lib/indexer/`, invoked from two route handlers. It
never runs in the browser.

### One forward pointer, one loop

`last_indexed_block` starts at `start_block - 1` and **only ever moves forward**.
There is no backward crawl and no second cursor. "Backfill" and "catch-up" are
the same loop at different distances from the head:

```
Run 1 → blocks A..B     Run 2 → B+1..C     Run 3 → C+1..D     …
```

`backfill_complete` is a derived flag, set the first time the pointer reaches
`safeHead`. It changes reporting, not behaviour.

This is why a user request can never cause a historical scan: **every run is
forward-only and capped**, so the worst a user-triggered run can do is advance
the pointer by its cap and stop. The caps differ by trigger:

| Trigger | Blocks per run | Requests per run |
|---|---|---|
| User traffic (`waitUntil()`) | `INDEXER_TRAFFIC_MAX_BLOCKS` (default 500,000) | 6 |
| Cron / manual | `INDEXER_CRON_MAX_BLOCKS` (default 4,000,000) | 40 |

A run that hits its cap commits its progress and exits; the next run continues.
Nothing is ever re-scanned, and no run is unbounded.

Expected cost of the whole historical range: ~14 `getLogs` requests — one
`getLogs` covers every pool and all four FPMM event types at once via the address
array plus events array — plus one `getBlock` per distinct event-bearing block.
So the full 1.67M-block history is a handful of cron runs, or a few dozen
traffic-triggered ones.

### Traffic-triggered catch-up

```
GET /api/markets/:id/chart
  → read checkpoint + serve rows from Postgres    (never blocks on indexing)
  → if now() - last_tick_at > INDEXER_STALE_SECONDS:
        scheduleBackgroundIndex({ maxBlocks: TRAFFIC_MAX_BLOCKS })
  → respond immediately
```

Required behaviour, in the owner's words: the chart API responds immediately;
the user never waits for indexing; indexing runs server-side; the browser is
never responsible for triggering it; cron remains the periodic safety net;
concurrent users are serialized by the database lease; and **no user request can
ever cause an unbounded historical scan.** The last is structural rather than
defensive — see the per-run caps above.

### The background mechanism is quarantined

All background execution lives behind one module:

```ts
// frontend/lib/indexer/background.ts
export function scheduleBackgroundIndex(opts: IndexRunOptions): void
```

Internally it calls `waitUntil()` from **`@vercel/functions`**, which keeps the
serverless invocation alive past the response until the promise settles.

`waitUntil()` rather than `after()` from `next/server` for a hard reason:
`after()` requires **Next 15.1+**, and this project is pinned to **Next
14.2.35**. Upgrading Next is semver-major, drags wagmi/viem with it, and
`TODO.md:399-409` explicitly wants that kept as isolated work. `@vercel/functions`
adds the capability without touching the framework version.

The module is the *only* place that knows how background work is started.
Everything else calls `scheduleBackgroundIndex`. Swapping to `after()` after a
future Next upgrade — or to Vercel Queues, or to a plain `void` promise in local
development — is a one-file change with no effect on the indexer or API design.

Two properties inherited from `waitUntil()` that the design depends on:

- **It shares the function's timeout budget** (Hobby and Pro both cap at 300s
  under Fluid compute; a timed-out function cancels pending work). The traffic
  caps above are therefore set far below that ceiling, so a traffic-triggered run
  finishes or exits cleanly rather than being killed mid-write.
- **It does not extend the response.** The client gets its JSON immediately;
  indexing continues after the bytes are flushed.

Locally there is no Vercel runtime, so `background.ts` falls back to awaiting the
promise directly. That makes the e2e test deterministic instead of racing a
fire-and-forget.

### Concurrency control: a lease row, not `pg_advisory_lock`

```sql
UPDATE indexer_state
   SET lease_until = now() + interval '2 minutes', lease_owner = $2
 WHERE chain_id = $1
   AND (lease_until IS NULL OR lease_until < now())
RETURNING last_indexed_block, last_indexed_block_hash, backfill_complete;
```

Zero rows returned means another run holds the lease; the caller exits
immediately, doing nothing.

A lease row is chosen over `pg_advisory_lock` for three reasons specific to
serverless plus a connection pooler:

- Session-level advisory locks require **session affinity**. Through a
  transaction-mode pooler, consecutive queries may land on different backend
  sessions, so the lock may be held by a session the job no longer has.
- A serverless function killed mid-run never releases a session lock; a lease
  **expires on its own**, so a crash cannot deadlock the indexer permanently.
- The lease is *visible* — `lease_until` and `lease_owner` are readable by the
  status endpoint, which makes a stuck indexer diagnosable rather than silent.

The requirement asked for "a database-based lock/advisory lock or another
reliable locking mechanism"; this is the latter, and it is strictly more robust
here. Idempotency does not depend on the lease: every insert is
`ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`, so even a
simultaneous double-run cannot duplicate a row.

### Range handling, retries, backoff

- Chunk size starts at `INDEXER_CHUNK_BLOCKS` (default 250,000) and is stored
  per chain in `accepted_chunk`, learned once rather than per browser tab.
- On `-32012 requested range too large`, halve and retry. Only asking for less
  helps; this is not a rate-limit condition.
- On HTTP 429 / `-32005`, exponential backoff (1s, 2s, 4s, 8s) with the same
  retry-only-on-rate-limit rule proven in `lib/rpcQueue.ts`. Non-rate-limit
  errors fail the run rather than being retried blindly.
- A run that exhausts its request budget records the checkpoint it reached and
  exits cleanly. Partial progress is always committed.
- Block timestamps are fetched **once per distinct block** and cached in
  `blocks`; a block already present is never re-fetched.

### Finality and reorgs

Indexing stops at `safeHead = head - INDEXER_CONFIRMATIONS` (default 12), so
the most recent blocks are never written and the common reorg case never
reaches the database.

Each run re-reads the header of `last_indexed_block` and compares it with
`last_indexed_block_hash`. On mismatch, walk back through `blocks` until a
stored hash matches the chain, then:

1. `DELETE FROM market_events WHERE chain_id = $1 AND block_number > $cut`
2. `DELETE FROM blocks WHERE chain_id = $1 AND block_number > $cut`
3. Reset the checkpoint to `$cut` and re-index forward.

Because reserves are stored per row, the replay restarts from the surviving row
immediately below the cut. No full re-replay is needed.

### Reconciliation

Periodically (on the cron path, not the traffic path), for each market: call
`reserves()` on-chain and compare with the latest replayed `reserve_yes` /
`reserve_no`. This is an **exact equality check**, not a tolerance — the replay
is integer arithmetic mirroring the contract.

A mismatch means one of:

- the replay has a bug,
- a reorg was missed, or
- outcome tokens reached the pool without an event — possible, because the FPMM
  is an `ERC1155Holder` and can receive a direct transfer from anyone.

The last case is why reconciliation cannot be replaced by trusting the replay.
On mismatch the indexer records `last_error`, marks the market for re-index, and
the status endpoint reports `degraded`.

## API

Both handlers are Node-runtime route handlers in the existing app.

```
GET /api/markets/[questionId]/chart
      ?outcome=0|1            default 0 (YES)
      &from=24h|7d|30d|all    or a unix timestamp
      &to=<unix>              default now
      &interval=auto|1m|5m|15m|30m|1h|4h|1d
      &limit=<int>            default 300, hard max 2000
```

Response:

```json
{
  "points": [ { "t": 1756651200, "bps": 4200 } ],
  "meta": {
    "questionId": 3, "outcome": 0, "interval": "5m",
    "complete": true, "lastIndexedBlock": 57301912, "blocksBehind": 4
  }
}
```

**`bps` as an integer, not `price: 0.42`.** The entire frontend already speaks
basis points (`yesProbBps`, `TradePoint.bps`, `yesProbBps` → `PriceChart`), and
a float boundary would introduce drift into a value that is currently exact.
This is a deliberate deviation from the requested example payload.

### Downsampling

`interval=auto` picks the bucket from the requested span: ≤1 day → 5m,
≤7 days → 15m, ≤30 days → 1h, otherwise 1d, then widens further if the bucket
count would still exceed `limit`.

Bucketing takes the **last** price in each bucket, never the average — an
average of a probability path is not a price and would smooth away the extremes
that matter:

```sql
SELECT DISTINCT ON (bucket)
       to_timestamp(floor(extract(epoch FROM block_time) / $step) * $step) AS bucket,
       yes_bps, block_time
  FROM market_events
 WHERE chain_id = $1 AND question_id = $2
   AND block_time >= $3 AND block_time <= $4
 ORDER BY bucket, block_number DESC, log_index DESC;
```

Raw rows are never deleted or overwritten. Downsampling happens at read time
only, so the full-resolution history is always recoverable.

### Status endpoint

```
GET /api/indexer/status
{
  "latestBlockchainBlock": 57301916,
  "latestIndexedBlock": 57301904,
  "blocksBehind": 12,
  "status": "healthy",
  "backfillComplete": true,
  "lastTickAt": "2026-08-31T09:14:02Z",
  "leaseHeld": false,
  "lastError": null
}
```

`status` is `healthy` when `blocksBehind <= confirmations + slack` and there is
no recorded error; `syncing` during backfill; `degraded` on a reconciliation
mismatch or repeated RPC failure; `stalled` when the last successful tick is
older than a threshold.

## Frontend change

`useTradeHistory` keeps its **exact signature and return shape** —
`{ points: TradePoint[], isLoading, degraded, complete, refresh }`. Only its
internals change: one `fetch` to the chart API instead of a log sweep. So
`app/market/[id]/page.tsx` needs **zero edits**.

The live `'now'` point is still appended from `currentBps`, unchanged. `degraded`
now means "the API could not be reached or reports a problem"; `complete` maps
to `meta.complete`.

The hook requests `interval=auto&limit=200`, matching the existing
`MAX_POINTS = 200`, so the point count the chart receives is what it already
expects.

### Time-based x-axis (Polymarket-style)

`TradePoint` gains one **optional** field:

```ts
interface TradePoint { bps: number; kind: 'buy' | 'sell' | 'now'; t?: number }
```

`t` is unix **seconds**, from the indexed block timestamp. The `'now'` point
carries the client clock. `PriceChart.tsx` positions points by time:

```
x = PAD_LEFT + ((t - tMin) / (tMax - tMin)) * plotW
```

**`t` is optional for a load-bearing reason, not for convenience.** The RPC
fallback path has no timestamps — `CachedEvent` stores only `blockNumber` and
`logIndex` (`logCache.ts:60-68`), and fetching block headers from the browser is
exactly what this whole change exists to stop. So the chart must render both
shapes, and the axis mode is chosen from the data:

| Condition | Axis |
|---|---|
| Every point has `t`, and `tMax > tMin` | Time-proportional, with date labels |
| Any point lacks `t`, or all timestamps are equal | Even sequence spacing, as today |

Both modes share one code path: an x-scale function selected once per render.
Sequence spacing therefore stays as the **degenerate case** of the same
renderer, not as a second renderer to keep in sync.

Consequences that must be handled rather than discovered:

- **Uneven spacing is the point.** A market with a burst of trades then silence
  shows a cluster then a flat run. That is the honest shape and the reason for
  the change; dot radius already shrinks with count (`dotRadius`, `:94-99`), so
  clusters stay legible.
- **A long-idle market compresses its history** into the left edge. Accepted:
  the alternative is lying about when trades happened.
- **X tick labels use `Intl.DateTimeFormat`**, matching `lib/time.ts` and the
  standing decision in `DEPENDENCIES.md` to add no date library. Label
  granularity follows the span: time-of-day within a day, day+month within a
  year, otherwise month+year.
- **The `sr-only` table and `aria-label`** (`PriceChart.tsx:227-231`, `:354-372`)
  gain the timestamp, so the accessible rendering stays equivalent to the visual
  one rather than falling behind it.
- The 0–100% y-domain, gridlines, live-price marker, `ResizeObserver` sizing and
  caption logic are all untouched.

This deliberately overrides the standing rule in `CLAUDE.md` that the x-axis must
be trade sequence. That rule existed because a time axis implied per-block
`getBlock` calls from the browser; with timestamps indexed server-side the
premise is gone. `CLAUDE.md` is rewritten in this change so it no longer forbids
what the code does — the rule is replaced, not deleted, and the new one keeps the
part that still matters: **the browser must never call `getBlock` for chart
points.**

### Source selection and fallback

`NEXT_PUBLIC_CHART_SOURCE` selects `api` (default), `rpc`, or `auto`. In `auto`
the existing sweep runs only if the API call fails. **The RPC fallback is kept
permanently, not as transitional scaffolding** — Neon's free tier can suspend on
quota, and a chart that degrades to slow-but-working beats one that shows
nothing. This also satisfies the "compare SQL against the current RPC
implementation" phase: both paths remain runnable side by side.

### Explicitly unchanged

- `lib/logScan.ts`, `lib/logCache.ts`, `lib/rpcQueue.ts` — untouched; still used
  by the ledger and by the chart's fallback path.
- `useTradeLedger`, `useTradeStats`, `/profile`, `/leaderboard` — **out of
  scope**. They have the same 1.7M-block problem and the same fix applies later,
  but bundling them would make this change unreviewable.
- All contracts. No Solidity change is required; every field needed is already
  emitted.
- `lib/ledger.ts` keeps its own non-flipped execution-price definition for cost
  basis. That definition is correct for its purpose and must not be unified with
  the chart's.

## Security

| Variable | Exposure | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | server only | — | Neon connection string (required) |
| `INDEXER_RPC_URL` | server only | public Arc RPC | RPC for the indexer |
| `CRON_SECRET` | server only | — | Bearer token Vercel Cron sends; verified on the indexer route |
| `INDEXER_CHAIN_ID` | server only | `5042002` | Which deployment entry to index |
| `INDEXER_CONFIRMATIONS` | server only | `12` | Blocks held back from the head |
| `INDEXER_CHUNK_BLOCKS` | server only | `250000` | Initial `getLogs` range; narrowed on refusal |
| `INDEXER_STALE_SECONDS` | server only | `120` | Age of `last_tick_at` that triggers a traffic catch-up |
| `INDEXER_TRAFFIC_MAX_BLOCKS` | server only | `500000` | Per-run cap for traffic-triggered runs |
| `INDEXER_CRON_MAX_BLOCKS` | server only | `4000000` | Per-run cap for cron/manual runs |
| `NEXT_PUBLIC_CHART_SOURCE` | **public** | `api` | `api` \| `rpc` \| `auto` |

Only the last is `NEXT_PUBLIC_`, and it carries no secret. Every credential is
server-only, so nothing lands in the browser bundle. This is a genuine
improvement over the status quo: the RPC endpoint used for *indexing* is now
server-side and can hold a private key-bearing URL, which
`NEXT_PUBLIC_ARC_TESTNET_RPC_URL` never could.

Contract addresses and `startBlock` continue to come from
`frontend/lib/deployments/index.json`, not from env, matching existing practice.

The indexer route rejects any request without a valid `CRON_SECRET`. The
traffic-triggered path does not go through HTTP at all — it calls the indexer
module in-process via `scheduleBackgroundIndex()`, so there is no publicly
reachable trigger and the browser never learns that an indexer exists.

Two project standing rules carry into the new surface:

- **Every query is parameterized** (`$1`, `$2`, …). No string interpolation into
  SQL anywhere, including the `interval` and `limit` parameters — those are
  validated against an allowlist and coerced to integers before use.
- **Chain-derived strings stay untrusted.** `question` and `category` come from
  `MarketCreated` and are attacker-controlled. Storing them in Postgres does not
  launder them: any surface that renders them still passes them through
  `lib/sanitize.ts`. The database is a cache of on-chain bytes, not a validator.

## Local testing

Arc testnet RPC is unreachable from the development environment (Cloudflare
1009, region-blocked; `TODO.md:90-102`), so the whole pipeline must be provable
without it.

`contracts/scripts/e2e-indexer.ts` — a Hardhat script against a local node
(chain 31337):

1. Deploy the system (reuse `test/helpers.ts` `deploySystem()`).
2. Create several markets, including a `"Event: Outcome"` pair.
3. Emit every indexed event: `addLiquidity`, `buy` on both outcomes, `sell`,
   `removeLiquidity` (deliberately from an **unbalanced** pool, so residual
   single-outcome tokens move the price with no Buy/Sell), and `resolveMarket`.
4. Run the indexer module against `http://127.0.0.1:8545` and a test database.
5. Assert:
   - one row per emitted event, correct `kind`, `outcome`, `collateral`, `shares`
   - **replayed `reserve_yes`/`reserve_no` equal on-chain `reserves()` exactly,
     for every pool** — the decisive assertion
   - `yes_bps` equals `yesProbBps(reserves())` at the final state
   - the `removeLiquidity` checksum holds
   - the price series includes the `removeLiquidity` move
   - `block_time` on every event matches the block's on-chain timestamp, and each
     block header was fetched **once** regardless of how many events it carries
   - running the indexer **twice** changes no row count (idempotency)
   - two concurrent runs produce identical output to one run (lease)
   - a simulated reorg (re-run with a truncated checkpoint) converges
6. Query the chart API's query function directly and assert bucketing, `outcome=1`
   flipping to `10000 - yes_bps`, `limit` enforcement, and that every returned
   point carries a `t` that is non-decreasing across the series.

The test database is a Neon branch or any local Postgres reachable via
`DATABASE_URL`; `pg` speaks to both identically, which is why `pg` was chosen
over Neon's HTTP driver.

## Phasing

| Phase | Deliverable | Verification gate |
|---|---|---|
| 1 | Migrations, `pg` pool, indexer module, `background.ts`, local e2e | e2e passes; `tsc --noEmit`; `npm run build` |
| 2 | Chart API + status endpoint, still unused by the UI | API output compared against the live RPC sweep for the same market |
| 3 | `useTradeHistory` switched to the API behind `NEXT_PUBLIC_CHART_SOURCE`; `PriceChart` time axis | chart renders with real dates; sequence fallback still renders when `t` is absent |
| 4 | Neon provisioned, migrations applied, testnet backfill run, daily cron enabled | `/api/indexer/status` healthy; reconciliation clean |

The chart keeps working throughout: phases 1–2 add code the UI does not call,
and phase 3 is a single env-var flip with the old path still present. The axis
change ships in phase 3 alongside the data source, because a time axis is
meaningless until timestamps are actually available.

## Deployment (to be written out fully at the end of implementation)

Sequence: create the Neon project via the Vercel Marketplace integration → set
`INDEXER_RPC_URL`, `CRON_SECRET`, `NEXT_PUBLIC_CHART_SOURCE` → run migrations →
invoke backfill until `backfill_complete` → add the cron entry to `vercel.json`
→ watch `/api/indexer/status`.

Recovery procedures to document: resume after a failed backfill (idempotent, just
re-invoke), force a re-index of a block range, rebuild from empty, and rotate
`DATABASE_URL`.

## Dependency record

Two new runtime dependencies, both verified against the npm registry on
2026-09-01 and both recorded in `DEPENDENCIES.md` in the existing four-point
format (why chosen · why secure · why over alternatives · 7-day compliance):

| Package | Version | Published | Age at adoption | 7-day floor |
|---|---|---|---|---|
| `pg` | 8.23.0 | 2026-08-08 | 24 days | passes |
| `@vercel/functions` | 3.9.5 | 2026-08-20 | 12 days | passes |

**`pg` over `@neondatabase/serverless`.** Neon's driver speaks Neon's HTTP
protocol, which a local Postgres cannot answer. Local testability is a hard
requirement here, and `pg` addresses a local database, a Neon branch and Neon
production identically. It is also the oldest, most scrutinised Postgres client
in the ecosystem, with no native build step — which matters under
`ignore-scripts=true`.

**`@vercel/functions` over a Next upgrade.** The alternative to it is `after()`
from `next/server`, which needs Next 15.1+ against the pinned 14.2.35. That
upgrade is semver-major, pulls wagmi/viem along, and is already earmarked as
separate work. A first-party Vercel package that adds one function is a smaller
change than a framework major.

**No ORM, no migration framework, no Redis, no queue.** Migrations are numbered
`.sql` files with a small runner; the query surface is a handful of parameterized
statements.

`DEPENDENCIES.md:135-136` currently argues **against** a database and against
"a subgraph / indexer (The Graph, Ponder)". That entry must be **explicitly
reversed, not silently contradicted.** The reversal states what changed: the
rejection assumed `getLogs` was cheap because "one bounded sweep covers every
market and both event types in ~6 requests". That is true of the *request count*
and false of the *outcome* — the sweep is bounded by a 40-request budget across a
1.7M-block window it cannot finish, which is why the chart never reports
`complete` and why `logCache` exists. The reasoning was sound; its premise was
wrong.

Also to be corrected there: the "Vercel serverless has no persistent disk"
argument. Still true, and now irrelevant — persistence is Neon's, not the
function's.

## Risks and open items

- **Vercel Hobby prohibits commercial use.** "Hobby teams are restricted to
  non-commercial personal use only"; ToS §4 permits removal without notice. A
  play-money testnet demo is a genuinely gray case and Vercel's own guidance is
  to ask support. If this ever points at real USDC, Pro at $20/mo is the floor
  for licensing reasons, independent of any resource limit. This also decides
  cron granularity: Hobby is capped at once per day and rejects finer
  expressions at deploy time.
- **Neon free tier: 100 CU-hours/month, 0.5 GB.** Storage is a non-issue at a few
  thousand events. CU-hours are managed by the low-frequency cron decision above
  and should be watched after launch.
- **Cold-start latency** on the first request after Neon scales to zero. Bounded
  by the API being read-only and the fallback path existing.
- **Neon is owned by Databricks** (2025). Not a reason to switch — Vercel's own
  Postgres path routes there — but it is vendor concentration worth recording.
- **`accepted_chunk` is unverified against Arc's real limits.** The 250,000
  default is inferred from the existing frontend constants and the documented
  1,048,576 refusal, not measured. Phase 4 will establish the true ceiling.
- **The e2e test cannot exercise reorg behaviour realistically** on a Hardhat
  node; the test simulates it by truncating the checkpoint. Real reorg behaviour
  on Arc remains unverified, which is why `INDEXER_CONFIRMATIONS` is
  configurable and defaults conservatively.
- **No frontend test runner exists** (`TODO.md:108-110`), so the API query logic
  is tested from the Hardhat script rather than from a frontend test suite. That
  keeps dependency count at two but means the assertions live in the contracts
  workspace.
- **The time axis has no automated test**, for the same reason: `PriceChart` is a
  React component and there is no renderer to test it with. The x-scale selection
  is therefore factored into a **pure exported function** taking points and width
  and returning positions, so it can be asserted from the same Hardhat-run script
  as everything else. The SVG itself is verified by eye in phase 3.
- **`waitUntil()` is unverifiable locally.** There is no Vercel runtime on a dev
  machine, so the production background path cannot be exercised before deploy;
  locally `background.ts` awaits instead. The first real proof is phase 4, watched
  through `/api/indexer/status`. This is the main reason the mechanism is isolated
  in one small module: if it misbehaves in production, the blast radius is one
  file.

## Non-goals

- Migrating `/profile` and `/leaderboard` off the log sweep.
- Candles, volume bars, or OHLC. The chart is one line.
- Redis or any cache layer. Postgres with the right index is the first
  optimization; a cache would be added only against a measured need.
- Indexing `Social.sol` or `MarketMetadata`.
- Upgrading Next.js. `@vercel/functions` exists in this design precisely so the
  framework version does not have to move.

## Documentation to update in this change

Not optional extras — each is a file that currently contradicts the new design:

- **`CLAUDE.md`** — replace the trade-sequence x-axis rule (see the frontend
  section above). The replacement must still forbid browser `getBlock` calls for
  chart points and must still forbid a reserve *replay in the browser*, while
  stating that replay is exactly how the indexer derives price server-side.
  Also: add the indexer/API/Neon layer to the architecture description, and add
  the new server-only env vars.
- **`DEPENDENCIES.md`** — the two new entries plus the explicit reversal above.
- **`frontend/.env.example`** — document every new variable, keeping the file's
  existing convention of explaining *why* each exists and what happens when it is
  absent.
- **`TODO.md`** — session log entry, and close out the "no backend" note.

