# Deploying the chart indexer

Runbook for the server side added by the chart-indexer change: the Neon Postgres
index, the three route handlers (`/api/indexer/tick`, `/api/indexer/status`,
`/api/markets/[questionId]/chart`), the daily cron, and every recovery procedure
the code tells an operator to perform.

**Read this first:** RPC is the source of truth and Postgres is only a
read-optimized projection of it. Nothing here can lose data that the chain still
holds — every recovery below is "delete rows and re-index", never "reconstruct by
hand". That is what makes the destructive steps safe to run.

**Where the cron config lives:** `frontend/vercel.json`, not the repo root. See
[The daily cron](#7-the-daily-cron).

---

## 1. Provision Neon

Use the **Vercel Marketplace integration** rather than a standalone Neon account:

1. Vercel dashboard → your project → **Storage** → **Create Database** → **Neon**.
2. Pick the region closest to the project's function region.
3. Accept the default of connecting it to **Production, Preview and Development**.

The integration injects `DATABASE_URL` (plus `DATABASE_URL_UNPOOLED`,
`PGHOST` and friends) into the project's environment automatically, so it never
has to be pasted anywhere. `lib/db/pool.ts` reads `DATABASE_URL` only.

Free-tier limits that shape every decision below:

| Limit | Value | Consequence |
|---|---|---|
| Storage | 0.5 GB | A non-issue: a few thousand events is well under a megabyte. |
| Compute | 100 CU-hours/month | The reason cron is **daily**. Exceeding it suspends the database for the rest of the billing month. |
| Idle suspend | after 5 min | The first request afterwards pays a cold start; `ensurePoolReachable` retries through it. |

## 2. Environment variables

Set these in Vercel → Settings → Environment Variables. **Only
`NEXT_PUBLIC_CHART_SOURCE` may carry the `NEXT_PUBLIC_` prefix** — anything so
prefixed is inlined into the browser bundle, so a credential with that name is a
published credential.

| Variable | Exposure | Required | Default | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | server only | **yes** | — | Neon connection string. Injected by the integration in step 1. |
| `CRON_SECRET` | server only | **yes** | — | Bearer token for `/api/indexer/tick`. Absent ⇒ the route answers **503 and never runs**, so a missing secret cannot make the endpoint public. |
| `INDEXER_RPC_URL` | server only | no | `https://rpc.testnet.arc.io` | RPC for the indexer. **https only, no embedded credentials** — anything else falls back to the public node. This is the one place a private key-bearing RPC URL can live safely; `NEXT_PUBLIC_ARC_TESTNET_RPC_URL` never could. |
| `INDEXER_CHAIN_ID` | server only | no | `5042002` | Which `lib/deployments/index.json` entry to index. |
| `INDEXER_CONFIRMATIONS` | server only | no | `12` | Blocks held back from the head, so the reorg-prone tip is never stored. |
| `INDEXER_CHUNK_BLOCKS` | server only | no | `250000` | Initial `eth_getLogs` width. Narrowed automatically on refusal; superseded per chain by `indexer_state.accepted_chunk`. |
| `INDEXER_STALE_SECONDS` | server only | no | `120` | Age of `last_tick_at` that lets a chart request schedule a background catch-up. |
| `INDEXER_TRAFFIC_MAX_BLOCKS` | server only | no | `500000` | Per-run block cap on the traffic path. |
| `INDEXER_CRON_MAX_BLOCKS` | server only | no | `4000000` | Per-run block cap for cron and manual runs. |
| `NEXT_PUBLIC_CHART_SOURCE` | **public** | no | `api` | `api` \| `rpc` \| `auto`. Carries no secret. |

Generate the cron secret with:

```bash
openssl rand -hex 32
```

Set it for **Production and Preview**. A preview deployment without it returns 503
from the tick route, which looks like a broken deploy rather than a missing
variable.

## 3. Run the migrations

From `frontend/`, against the same database the deployment uses:

```bash
cd frontend
DATABASE_URL='postgresql://…' npm run db:migrate
```

Idempotent: every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS`, and applied filenames are recorded in `schema_migrations`. Safe to re-run
on every deploy, and safe to run against a database that already holds data.

Confirm the four tables exist:

```bash
psql "$DATABASE_URL" -c '\dt'
# expected: blocks, indexer_state, market_events, markets, schema_migrations
```

## 4. Initial backfill

Each tick is **bounded and resumable**: it indexes at most
`INDEXER_CRON_MAX_BLOCKS`, commits one transaction per range, and moves the
checkpoint only for blocks it actually stored. A timeout therefore costs one
range, not the run — so the backfill is "call it until it says it is done".

```bash
export APP='https://your-app.vercel.app'
export CRON_SECRET='…'                     # the value from step 2

curl -s -H "Authorization: Bearer $CRON_SECRET" "$APP/api/indexer/tick" | jq .
```

The response is the whole `IndexRunResult`: `ranBlocks`, `fromBlock`, `toBlock`,
`eventsInserted`, `requests`, `backfillComplete`, `budgetStopped`,
`checksumFailures`, `noProgress`, `skippedBecauseLeased`, `error`. A run that
stopped at a cap reports `budgetStopped: true` with `error: null` — that is
healthy, not a failure.

Copy-pasteable poll loop:

```bash
while :; do
  curl -s -H "Authorization: Bearer $CRON_SECRET" "$APP/api/indexer/tick" \
    | jq -c '{toBlock, eventsInserted, requests, budgetStopped, noProgress, error}'
  sleep 5
  done_yet=$(curl -s "$APP/api/indexer/status" | jq -r '.backfillComplete')
  curl -s "$APP/api/indexer/status" \
    | jq -c '{status, latestIndexedBlock, latestBlockchainBlock, blocksBehind, lastError}'
  [ "$done_yet" = "true" ] && break
  sleep 5
done
```

Stop and investigate if a tick returns `noProgress: true` twice in a row: that
means there was a range to cover and the checkpoint did not move. `error` says why
when a request failed; when `error` is null and `budgetStopped` is true, the sweep
could not cover one contiguous range within its request budget — lower
`INDEXER_CHUNK_BLOCKS` (see step 5) and try again.

## 5. Pin the real chunk ceiling

`INDEXER_CHUNK_BLOCKS` defaults to 250,000. That number is **inferred** from the
frontend's own constants and Arc's documented refusal at 1,048,576 blocks — it has
never been measured against Arc. The first backfill measures it for you: on a
`-32012 requested range too large` the sweep halves and keeps the narrower width,
and the largest width that was actually served is persisted.

```bash
psql "$DATABASE_URL" -c 'SELECT chain_id, accepted_chunk FROM indexer_state'
```

Set `INDEXER_CHUNK_BLOCKS` to that value and redeploy, so later runs open at the
width the endpoint accepts instead of re-paying the halving probe. `accepted_chunk`
only ever RISES (a dense range refused for result *count* must not throttle every
later scan permanently), so it is a ceiling, not a scar.

`/api/indexer/status` reports the same value as `acceptedChunk` if you would
rather not open a SQL session.

## 6. Enable the frontend

```
NEXT_PUBLIC_CHART_SOURCE=api
```

**A redeploy is required.** `NEXT_PUBLIC_*` values are inlined into the client
bundle at build time, so changing the variable without rebuilding changes nothing:
the old value is already compiled into the JavaScript users download. Trigger a
redeploy from the dashboard, or push a commit.

`api` is also the built-in default, so an unset variable behaves identically. Set
it explicitly anyway — an operator reading the dashboard should not have to know
the default to know which path is live.

`auto` is the belt-and-braces setting: the API first, the RPC log sweep if it
fails. It is the right choice while the index is still backfilling, because a
market with no indexed history yet still draws a line.

## 7. The daily cron

`frontend/vercel.json`:

```json
{
  "crons": [
    { "path": "/api/indexer/tick", "schedule": "17 3 * * *" }
  ]
}
```

### Why `frontend/vercel.json` and not the repo root

This project's Vercel **Root Directory is `frontend`**. Vercel resolves
`vercel.json` relative to the Root Directory, not to the git repository root: with
a Root Directory configured, a `vercel.json` sitting beside `contracts/` at the top
of the repo is outside the deployment's file scope and is **silently ignored** — no
warning, no cron, and a status endpoint that looks fine because traffic-triggered
catch-up still runs. Putting it in `frontend/` also keeps it beside the
`app/api/indexer/tick/route.ts` it configures.

**Confirm rather than trust this.** After a **production** deploy (crons do not run
on preview deployments):

1. Vercel dashboard → the project → **Settings → Cron Jobs**. The job must be
   listed as `/api/indexer/tick` at `17 3 * * *`. An empty list means the file is
   not being read — move it to the repo root and redeploy.
2. The deployment's build output names the crons it registered.
3. After the first scheduled run, the function's runtime logs show a `GET
   /api/indexer/tick` returning 200, and `/api/indexer/status` shows a `lastTickAt`
   within the last day.

### Why daily, and why `17 3` rather than `0 3`

**Daily is deliberate, not a limitation.** A per-minute cron would keep Neon's
compute continuously awake: roughly 180 CU-hours/month against a 100 CU-hour free
allowance, which exhausts the tier and **suspends the database for the rest of the
billing month**. Vercel Hobby also rejects sub-daily expressions at deploy time.

Daily is sufficient because **indexer lag never blocks the current price**: the
chart's final point is read live from the pool via RPC, so a stale index degrades
*history* only. Traffic is the primary trigger — a chart request whose
`last_tick_at` is older than `INDEXER_STALE_SECONDS` schedules a bounded catch-up
through `waitUntil()` — and this cron is the floor under that, for the case where
nobody visits.

The off-minute avoids the top-of-hour stampede every scheduler sees, where a
platform's own queueing adds minutes of jitter to jobs scheduled at `:00`.

## 8. Monitoring

```bash
curl -s "$APP/api/indexer/status" | jq .
```

No authentication, deliberately: it returns block numbers and a checkpoint, and a
health endpoint that needs a credential is one nobody checks.

| `status` | Meaning | Action |
|---|---|---|
| `healthy` | Backfill complete, no error, a tick within 48h, and the gap is within slack. | None. |
| `syncing` | Backfill incomplete, or further behind than the slack allows, or never indexed at all. | None during a backfill. If it persists for days, run a manual tick and read `error`. |
| `degraded` | `last_error` is set. That carries genuine failures **and** the notes for a reorg, replay checksum drift, and a run that covered zero blocks. | Read `lastError`, then the matching recovery procedure below. |
| `stalled` | Nothing has ticked for 48 hours — two cron intervals, so one missed run is not an alarm. | Check the cron is registered (§7), then run a manual tick. |

Precedence is **worst-first**, because these conditions overlap constantly and the
one an operator needs to see is the most serious.

Other fields worth knowing:

- `blocksBehind` up to `confirmations + 50` is **healthy**. The indexer
  deliberately leaves `INDEXER_CONFIRMATIONS` (12) blocks unindexed at the head, so
  a perfectly caught-up chain is always at least that far back; the extra 50
  absorbs blocks produced between the status read and the last run.
- `leaseHeld` / `leaseOwner` — an expired lease row reports `leaseHeld: false`,
  because expiry by itself is the whole reason this is a lease rather than a lock.
  `leaseOwner` names the *kind* of run holding it, which distinguishes "cron is
  mid-backfill" from "every visitor is triggering a catch-up".
- `latestBlockchainBlock: null` means the RPC head could not be read. It does not
  by itself make the index unhealthy.
- `lastError` is **server-generated text that can quote a Postgres or RPC
  message**. Anything that renders it must sanitize it (`lib/sanitize.ts`), exactly
  as `markets.question` must be — storing a string in Postgres does not launder it,
  and neither does returning it from a route handler.

## 9. Recovery procedures

Two conventions apply to every SQL block below.

**Every statement is parameterized.** `psql`'s `-v` / `:'var'` substitution is
client-side text interpolation, not a bind parameter, so these use
`PREPARE`/`EXECUTE` — which is how a bind parameter is expressed in an interactive
session. The chain id and block number appear exactly once each, as arguments.

**Never `TRUNCATE`.** This database may be shared with other data, `TRUNCATE` takes
an `ACCESS EXCLUSIVE` lock, and it cannot be scoped by `chain_id` — which is the
one predicate that keeps a recovery from touching a chain it was not aimed at.
Every statement here is scoped by `chain_id`.

Open a session with:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

### 9.0 The building block: cut to a block

Three of the procedures below are the same operation with a different cut point:
**delete everything above block N and point the checkpoint at N.** It is exactly
what the indexer's own reorg path does (`truncateAbove` + `resetCheckpoint` in
`lib/db/queries.ts`), by hand.

```sql
BEGIN;

PREPARE cut_events   (bigint, bigint) AS
  DELETE FROM market_events WHERE chain_id = $1 AND block_number  > $2;
PREPARE cut_blocks   (bigint, bigint) AS
  DELETE FROM blocks        WHERE chain_id = $1 AND block_number  > $2;
PREPARE cut_markets  (bigint, bigint) AS
  DELETE FROM markets       WHERE chain_id = $1 AND created_block > $2;
-- Easy to forget, and the reason a resolved market would otherwise stay resolved
-- forever: a reorg can unmake a RESOLUTION as well as an event, and `markets` rows
-- are keyed by question id rather than by block.
PREPARE cut_resolved (bigint, bigint) AS
  UPDATE markets
     SET resolved = false, resolved_block = NULL, payout_yes = NULL,
         payout_no = NULL, updated_at = now()
   WHERE chain_id = $1 AND resolved_block > $2;
-- `last_indexed_block_hash = NULL` skips the reorg probe on the next run: the cut
-- point is being asserted as sound by hand, so there is nothing left to prove.
-- `backfill_complete = false` because blocks the indexer had covered were just
-- deleted, and `true` would tell the status endpoint the history is whole while a
-- hole is being refilled.
PREPARE cut_state    (bigint, bigint) AS
  UPDATE indexer_state
     SET last_indexed_block = $2, last_indexed_block_hash = NULL,
         backfill_complete = false, last_error = NULL, updated_at = now()
   WHERE chain_id = $1;

EXECUTE cut_events   (5042002, 55632012);
EXECUTE cut_blocks   (5042002, 55632012);
EXECUTE cut_markets  (5042002, 55632012);
EXECUTE cut_resolved (5042002, 55632012);
EXECUTE cut_state    (5042002, 55632012);

COMMIT;
```

**One transaction, always.** A checkpoint that survives while the rows above it do
not — or the reverse — is a permanent hole: the next run starts above blocks that
were never stored, and nothing ever re-reads them.

Then run one tick and watch it move forward:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "$APP/api/indexer/tick" | jq .
```

### 9.1 Clear one chain's indexed rows

**Symptom.** Every tick fails with:

```
indexer_state for chain 5042002 was built for factory 0xaaa…, not 0xbbb… —
clear this chain's indexed rows deliberately before re-pointing it
```

**Cause.** The factory in `lib/deployments/index.json` no longer matches the one
this chain was indexed for — a redeploy, or a testnet reset followed by a fresh
deployment. The factory is checked and never overwritten on purpose: quietly
re-pointing the row would blend two contract histories into one chart, with wrong
prices and no other symptom.

**Procedure.** Every indexed row for that chain describes a chain state that no
longer exists, so all of it goes. Nothing is lost that the chain still holds.

```sql
BEGIN;

PREPARE wipe_events  (bigint) AS DELETE FROM market_events WHERE chain_id = $1;
PREPARE wipe_blocks  (bigint) AS DELETE FROM blocks        WHERE chain_id = $1;
PREPARE wipe_markets (bigint) AS DELETE FROM markets       WHERE chain_id = $1;
-- Last, and it must be deleted rather than updated: the row carries the old
-- factory address, and `ensureIndexerState` bootstraps a correct one on the next
-- run from `lib/deployments/index.json`.
PREPARE wipe_state   (bigint) AS DELETE FROM indexer_state WHERE chain_id = $1;

EXECUTE wipe_events  (5042002);
EXECUTE wipe_blocks  (5042002);
EXECUTE wipe_markets (5042002);
EXECUTE wipe_state   (5042002);

COMMIT;
```

Then re-run the backfill (§4). Other chains' rows are untouched — every statement
is scoped by `chain_id`, which is also why `TRUNCATE` is not an option here.

This same block is **"rebuild from empty"**: run it for each chain, re-run the
migrations (idempotent, §3) if you also dropped the schema, then backfill. Expect a
handful of ticks rather than hours — the whole 1.7M-block Arc testnet range is ~7
`eth_getLogs` calls at a 250,000 width, and one cron tick is allowed 4M blocks and
300 seconds. Measure it rather than trusting that estimate: watch `toBlock` climb
and `blocksBehind` fall.

### 9.2 Recover from `too-deep`

**Symptom.** `status: degraded`, and `lastError` reads:

```
reorg probe on chain 5042002 examined 256 stored blocks below 57312044 and found
the chain disagreeing deeper than 256 blocks. Nothing was truncated; re-index this
chain deliberately.
```

**Cause.** The checkpoint block's hash stopped matching the chain, and the probe
could not prove where the fork began — either the disagreement runs deeper than
`MAX_REORG_WALKBACK` (256 blocks) or the probe examined its whole budget of stored
witnesses without finding one that still matches. It **truncates nothing** in that
case, which is the right call (a valid ancestor may sit just past the bound, and
deleting a history because a walk was cut short is not a trade to make) — but it
also means the run re-probes and fails on every tick, forever, with no operator
lever. This is that lever.

**Procedure.** Choose a cut point that is unambiguously below the fork, verify it
against the chain, then apply §9.0.

1. Read the checkpoint and the stored witnesses just below it:

   ```sql
   PREPARE peek (bigint) AS
     SELECT last_indexed_block, start_block FROM indexer_state WHERE chain_id = $1;
   EXECUTE peek (5042002);

   PREPARE witnesses (bigint, bigint) AS
     SELECT block_number, block_hash FROM blocks
      WHERE chain_id = $1 AND block_number <= $2
      ORDER BY block_number DESC LIMIT 20;
   EXECUTE witnesses (5042002, 57312044);
   ```

2. Pick a candidate well below the deepest disagreement — 5,000 blocks below the
   checkpoint is a reasonable first try, and the anchor (`start_block - 1`, a full
   re-index) is the guaranteed-correct fallback. Confirm the chain still agrees
   with a stored hash at or below it:

   ```bash
   CUT=57307044   # e.g. the checkpoint minus 5,000
   curl -s -X POST "$INDEXER_RPC_URL" -H 'content-type: application/json' \
     --data "$(printf '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x%x",false]}' "$CUT")" \
     | jq -r .result.hash
   ```

   Compare it with `blocks.block_hash` for that block number. **They must match.**
   If no stored block sits at or below the candidate, go lower — down to the anchor
   if necessary. A cut above the fork leaves invalid rows behind, and unlike a cut
   that is too deep, that failure is silent.

3. Apply §9.0 with that block as `N`, then tick. `last_indexed_block_hash = NULL`
   means the next run does **not** re-probe: it indexes forward from the cut. That
   is exactly why step 2 is not optional.

### 9.3 Recover from a chain reset

**Symptom.** `/api/indexer/status` shows `latestBlockchainBlock` **below**
`latestIndexedBlock`, and `lastError` is a `BlockNotFoundError` — the reorg check
asked for the checkpoint block's header and the chain has no such block. Every tick
fails the same way; the indexer is wedged.

**Cause.** The chain was reset (a testnet wipe) or rolled back below the stored
checkpoint. `CLAUDE.md` names testnet resets as a real scenario, and
`lib/logScan.ts` already handles the browser half automatically by discarding a
cached range whose `toBlock` is above the current head. The indexer has no
equivalent automatic discard — deleting indexed history because one head read came
back low would be the wrong default — so it is an operator decision.

**Procedure.** First establish which kind of reset it was:

```bash
curl -s -X POST "$INDEXER_RPC_URL" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result
psql "$DATABASE_URL" -c 'SELECT chain_id, start_block, last_indexed_block FROM indexer_state'
```

- **The factory was redeployed** (the usual case after a testnet reset, and
  `lib/deployments/index.json` has a new address): use **§9.1**. Nothing indexed
  refers to a contract that exists any more.
- **The same factory is still live at the same address and start block**, and only
  the head moved backwards: apply **§9.0** with `N = start_block - 1` for a clean
  full re-index. A shallower cut is only sound if the new head is above it, and
  proving that costs more than re-indexing 1.7M blocks does.

Do not simply lower `last_indexed_block` and leave the rows: the deleted blocks'
events would still be present, and the replay would fold them a second time onto a
tail that already includes them — wrong reserves for every later event in that
pool, with no error anywhere.

### 9.4 Force a re-index of a block range

**When.** A market's chart looks wrong, a `MarketCreated` was missed, or you want
to re-derive reserves after fixing replay arithmetic.

**Procedure.** Apply **§9.0** with `N` = the block immediately **below** the range
you want redone, then tick until `backfillComplete` is true again.

The indexer is **forward-only with one cursor**, so there is no way to re-index a
range in the middle without also redoing everything above it. That is a deliberate
property, not a gap: a second cursor would let the checkpoint claim a range it had
not covered contiguously. Re-indexing is cheap — it is bounded, resumable and
idempotent (`ON CONFLICT DO NOTHING` on `(chain_id, block_number, log_index)`), so
the cost of an over-deep cut is time, never correctness.

### 9.5 Detect replay drift

**What the signal is.** `replay()` recomputes each liquidity event's own reported
value from pre-event state, so a mismatch is real evidence that the stored reserves
have drifted — a missed event, a missed reorg, or a wrong start state. Every
mismatch produces:

- `checksumFailures > 0` in the **tick response body**;
- a `console.error` line per event, `[indexer] replay checksum mismatch: chain=… question=… fpmm=… block=… logIndex=… kind=…`;
- a note in `last_error` (`replay checksum mismatch on N event(s): …`, capped at 12
  listed events), which makes `/api/indexer/status` report `degraded`.

**Why it is easy to miss.** `last_error` is cleared by the next successful commit,
so the `degraded` status lasts until the next tick and no longer. There is no
`checksum` column, so **a cleared `last_error` is not evidence the drift was
resolved** — it is evidence that a later range committed.

**How to catch it anyway**, in order of reliability:

1. **Run the tick yourself and read the response.** It is the only place the count
   is returned rather than inferred, and it does not depend on log retention:

   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" "$APP/api/indexer/tick" \
     | jq '{checksumFailures, eventsInserted, toBlock, error}'
   ```

2. **Search the runtime logs** for `replay checksum mismatch` (Vercel → the
   deployment → Logs). That is the permanent per-event record, subject to the
   plan's log retention. A log drain makes it durable if this matters.

3. **Reconcile against the chain**, which catches drift the checksum cannot see —
   including a stray ERC-1155 transfer into a pool, which changes real reserves with
   no event to replay. Read the newest stored state for a market:

   ```sql
   PREPARE tail (bigint, bigint) AS
     SELECT block_number, log_index, kind, reserve_yes, reserve_no, yes_bps
       FROM market_events
      WHERE chain_id = $1 AND question_id = $2
      ORDER BY block_number DESC, log_index DESC
      LIMIT 1;
   EXECUTE tail (5042002, 1);
   ```

   Then read the pool's live reserves and compare:

   ```bash
   cd contracts && npx hardhat console --network arcTestnet
   > const p = await ethers.getContractAt('FixedProductMarketMaker', '<fpmm>');
   > (await p.reserves()).map(String)
   ```

   They agree exactly when the replay is sound — that is the decisive assertion in
   `contracts/scripts/e2e-indexer.ts`, which is also the fastest way to prove the
   arithmetic locally after any change to it.

**The durable fix is a `checksum` column** on `market_events`, written from
`ReplayedEvent.checksumOk`, so drift is queryable forever instead of living in a
field the next tick clears. It is on the follow-up list in `TODO.md` and was left
out of this change deliberately: adding it means a migration and a change to the
insert path, and neither belongs in the change that established the baseline.

### 9.6 Clear a stuck lease

```sql
PREPARE clear_lease (bigint) AS
  UPDATE indexer_state SET lease_until = NULL, lease_owner = NULL, updated_at = now()
   WHERE chain_id = $1;
EXECUTE clear_lease (5042002);
```

**This is for impatience, not for correctness.** A lease expires on its own —
120 seconds on the traffic path, 300 on cron — and `acquireLease` treats an expired
row as free. `/api/indexer/status` already reports an expired row as
`leaseHeld: false`. Clearing it only helps when a function was killed mid-run and
you do not want to wait out the remainder.

### 9.7 Restart or resume

There is nothing to restart: the indexer is stateless between runs and every run
resumes from `last_indexed_block`. Call `tick` again (§4). A failed run committed
nothing, so the next one re-sweeps the same range — wasted work, never lost data.

### 9.8 Rotate `DATABASE_URL`

1. Rotate the credential in Neon (or re-run the Marketplace integration, which
   updates the injected variable).
2. Confirm the new value in Vercel → Settings → Environment Variables.
3. Redeploy.

**No draining is needed.** The `pg` pool is per function instance, created lazily
and never shared across deployments, so old instances take their connections with
them as they are recycled. Neon's own connection limit is the only thing to watch,
and the pool is capped at 3 clients precisely so a burst of instances cannot exhaust
it.

Never paste the connection string into a shell that logs history, a commit, or an
issue: it contains the password. `frontend/.env.local` is gitignored and stays that
way.

## 10. Rollback

In increasing order of severity:

1. **Instant, no code deploy: `NEXT_PUBLIC_CHART_SOURCE=rpc`.** The chart returns
   to the browser log sweep, which is still fully present and still the path
   `/profile` and `/leaderboard` use. A **redeploy is required** for the new value
   to be inlined into the bundle — that is the one cost of the flip, and it is a
   rebuild rather than a code change.
2. **`git revert` the frontend commits.** The indexer's route handlers and
   `lib/indexer/**` are additive: nothing else imports them, so reverting the three
   commits of this change leaves the app exactly as it was, and the database simply
   stops being written to.
3. **Baseline `7c03dbc`** ("Snapshot working state before chart indexer migration")
   is the full fallback if a revert conflicts.

Neon can be left provisioned through any of these. It costs nothing while idle, and
`/api/indexer/status` keeps working, so the index can be re-enabled by flipping the
variable back.

## 11. Measured results

The spec requires a before/after measurement. **None of it has been measured yet,
and nothing below is estimated.** Two hard blockers, both environmental:

- Arc testnet RPC is unreachable from the development environment (Cloudflare error
  1009, region-blocked), so neither path can be exercised against real data here.
- No Neon project exists yet, so there is no database to time a query against and
  no deployment to measure a cold start on.

Fill this table in after step 4, comparing the same market in `api` mode and in
`rpc` mode so the two columns are like-for-like:

| Metric | Before (`rpc`) | After (`api`) | How to measure |
|---|---|---|---|
| Chart initial load, cold | not measured | not measured | Devtools → Performance, first paint of the line on a market page, cache cleared. |
| Chart initial load, warm | not measured | not measured | Same, second load. |
| `eth_getLogs` issued by the browser | not measured | not measured | Devtools → Network, filter the RPC host. **Expected after: zero for the chart.** Calls for `markets`, `reserves` and balances are live state and are correct. |
| Chart API response, p50 / p95 | n/a | not measured | Vercel → the function's Observability tab, or 20 `curl -w '%{time_total}'` runs. |
| SQL time for `selectChartRows` | n/a | not measured | `EXPLAIN ANALYZE` the statement from `lib/db/queries.ts` with the same bound parameters. |
| Points returned | not measured | not measured | `jq '.points \| length'` on the API response; the sweep's count from the chart caption. |
| Behaviour at 10 / 100 / 1000+ points | not measured | not measured | Buckets widen via `interval=auto` so the response stays ≤200 points; confirm the line stays legible and dot radius shrinks. |

Two numbers are known without measurement because they are structural rather than
observed, and they are the reason this change exists:

- The browser sweep is capped at **40 requests per load** against a **1.7M-block**
  window on a rate-limited public node, so it is a *growing window* over history
  rather than the whole of it — it cannot report `complete` on a cold load.
- The indexer pays **one `getBlock` per event-bearing block, ever**, cached in
  `blocks` forever. The browser previously paid one per block per visitor, which is
  why a real time axis was impossible before and is affordable now.


