# TODO — Arc Prediction Market

Progress snapshot. Read `CLAUDE.md` first for architecture and gotchas.

## ✅ Latest session — the chart indexer: Postgres index, chart API, time axis (2026-09-02)

**The project now has a server side.** It lives inside `frontend/` — no separate service,
no Docker, no VPS. See `docs/DEPLOYMENT-INDEXER.md` for the runbook and
`docs/superpowers/specs/2026-08-31-chart-indexer-design.md` for the design.

### What was built
- [x] **Neon Postgres index** (`frontend/db/migrations/001_init.sql`): `indexer_state`
      (checkpoint + lease), `blocks` (timestamp cache **and** reorg witness, only
      event-bearing blocks), `markets`, `market_events` (raw args *and* replayed reserves
      *and* derived prices, append-only, keyed `(chain_id, block_number, log_index)`).
      **RPC stays the source of truth**; Postgres is a read-optimized projection of it.
- [x] **The indexer** (`lib/indexer/**`): forward-only from one checkpoint, capped per run,
      one transaction per range, serialized by a Postgres lease row, idempotent through
      `ON CONFLICT DO NOTHING`. Reserves are replayed **exactly** from the four FPMM events
      with **no RPC reads at all**; one `getBlock` per distinct event-bearing block, ever.
- [x] **Three route handlers**: `/api/markets/[questionId]/chart` (history out of Postgres,
      never blocks on indexing, degrades to a 200 with `degraded: true`),
      `/api/indexer/tick` (cron entry, Bearer `CRON_SECRET`, constant-time compare over
      SHA-256 digests), `/api/indexer/status` (unauthenticated health).
- [x] **`useTradeHistory` reads the API** and no longer sweeps logs on the primary path.
      Same return shape; `TradePoint` gains an optional `t` (unix seconds).
      `NEXT_PUBLIC_CHART_SOURCE` selects `api` (default) / `rpc` / `auto`.
- [x] **The x-axis is REAL TIME** (`lib/chartScale.ts`, zero imports so the contracts-side
      mocha suite can reach it). Sequence spacing survives as the **degenerate case of the
      same renderer** — it is what the RPC fallback draws, since that path has no
      timestamps and must not fetch any. X tick labels use `Intl.DateTimeFormat`; the
      `sr-only` table gained a Time column.
- [x] **The RPC log sweep is kept permanently**, not as scaffolding. Neon's free tier
      suspends on quota, so `auto` falls back to it on a non-OK response, a throw, or
      `meta.degraded`. `lib/logScan.ts`, `lib/logCache.ts` and `lib/rpcQueue.ts` are
      untouched.
- [x] **Daily cron** (`frontend/vercel.json`, `17 3 * * *`). Per-minute would keep Neon's
      compute awake continuously — ~180 CU-hours/month against a 100 CU-hour allowance —
      and suspend the database for the rest of the billing month. Traffic is the primary
      trigger; cron is the floor. Indexer lag never blocks the current price, which is why
      daily is enough.

### Verification (this session)
- [x] `npm test` → **203 passing / 24 pending** (was 197/24; +6 `ChartScale` assertions,
      zero regressions)
- [x] `cd frontend && npx tsc --noEmit` → **0 errors**
- [x] `npm run build` → **success, 14 routes**
- [x] `npx hardhat run scripts/e2e-indexer.ts` (earlier task in this change) — deploys
      locally, emits every indexed event including a price-moving second `addLiquidity`
      onto an unbalanced pool, indexes it, and asserts the **replayed reserves equal
      on-chain `reserves()` exactly**. That is the decisive test; re-run it after any
      change to the indexer or the replay arithmetic.

### Dependencies added (both recorded in `DEPENDENCIES.md`)
- [x] **`pg` 8.23.0** (published 2026-08-08) — parameterized SQL, no native addon, works
      identically against a local Postgres and a Neon branch, which is what makes the e2e
      proof possible without a testnet.
- [x] **`@vercel/functions` 3.9.5** (published 2026-08-20) — `waitUntil()`, the only
      supported way to let a response return while indexing continues. `after()` needs Next
      15.1+ and we are pinned to 14.2.35. Confined to `lib/indexer/background.ts`, so the
      whole dependency can be removed by replacing one file. It costs 23 transitive
      packages, itemised in `DEPENDENCIES.md`.
- [x] **The "no database / no indexer" rows in `DEPENDENCIES.md` are explicitly reversed**,
      not silently contradicted. The old rejection's reasoning was sound; its premise was
      wrong — "~6 requests per sweep" is true of the request *count* and false of the
      *outcome*, because 40 requests per load cannot finish a 1.7M-block window.

### Open follow-ups
- [ ] **Chunk the `eth_getLogs` address array** before the market count reaches the low
      hundreds. A provider refusal for *too many addresses* currently fails the run instead
      of subdividing — the adaptive halving only narrows the block range.
- [ ] **Add a `checksum` column to `market_events`** so replay drift outlives one tick.
      Today the signal lands in `last_error`, which the next successful commit clears, so
      `degraded` is transient and a cleared error is not evidence the drift was resolved.
      Procedure for catching it meanwhile: `docs/DEPLOYMENT-INDEXER.md` §9.5.
- [ ] **Fix the bare `msg.includes('429')` at `frontend/lib/rpcQueue.ts:87`.** The
      indexer's copy of that check is fixed; the browser's is not, so a block number
      containing "429" is misread as a rate limit. Left alone deliberately this session —
      `rpcQueue.ts` was out of scope.
- [ ] **Strengthen `scripts/e2e-indexer.ts`**: assert every row's reserves at *its own*
      block via `blockTag` (not just the final state), assert `MarketCreated`'s non-key
      columns against the factory's `markets()` getter, and make the header-dedup assertion
      real by putting two events in one block.
- [ ] **`accepted_chunk` is still unmeasured against Arc.** The 250,000 default is inferred
      from the frontend constants and the documented 1,048,576 refusal. The first real
      backfill measures it; read it back and pin `INDEXER_CHUNK_BLOCKS` (runbook §5).
- [ ] **`waitUntil()` is unproven until a real deploy.** There is no Vercel runtime on a dev
      machine; locally `background.ts` awaits instead. First proof is the deploy, watched
      through `/api/indexer/status`.
- [ ] **`/profile` and `/leaderboard` still use the browser log sweep.** They have the same
      1.7M-block problem and the same fix applies, but bundling them would have made this
      change unreviewable.
- [ ] **No frontend test runner exists**, so the chart's pure logic (`lib/chartScale.ts`,
      `lib/chart/buckets.ts`, `lib/indexer/replay.ts`) is tested from the **contracts**
      workspace by relative import. That is why those modules have zero imports. Adding a
      runner is a dependency decision for the project owner.
- [ ] **Periodic reconciliation is not built.** Comparing replayed reserves against a live
      `reserves()` call on the cron path would catch drift the checksum cannot see (a stray
      ERC-1155 transfer into a pool). Asserted once locally in the e2e; deliberately
      deferred until real Arc data exists to reconcile against.
- [ ] **No browser verification this session.** Verified by typecheck, build and the test
      suite only, per the owner's request to cut long checks. Worth clicking: a market with
      several trades in `api` mode (date labels, uneven spacing, a right-edge live dot),
      then `rpc` mode (even spacing, no labels), then a phone width (labels must not
      collide).

## ✅ Previous session — chart, profile/leaderboard and outcome removal (2026-08-16)

Three reported bugs. **Two of them were the same bug**, which is the useful finding.

### Root cause: a fixed lookback was doing a growing window's job
- [x] **`LOOKBACK_BLOCKS = 9000 * 6` (54,000 blocks) was anchored to the chain HEAD, not to
      the market.** It bounded each load, which was the goal of the RPC-reduction pass — but
      it is a *cache-eviction policy* used as a *query bound*, so it discards exactly the old
      data a price history and a cost basis are made of. It degrades **silently and
      progressively**: correct on a fresh chain, then quietly empty once the chain outruns
      the window, with every page still rendering "no trades" as if that were the truth.
      That single constant produced all three of:
      - the chart drawing only the live price it appends itself (the "single blue dot"),
      - `/profile` telling wallets that had traded they had no trades,
      - `/leaderboard` reading as "nobody has ever traded".
- [x] **Replaced with `lib/logScan.ts`** — one shared sweep for `useTradeHistory` and
      `useTradeLedger`. Extends **forward** to the head and deepens **backward** under a
      per-load budget, persisting the covered range, so the window only ever GROWS and depth
      is paid for once per session rather than re-fetched as a sliding window.
      - **Adaptive chunking**: starts at a wide range and halves on refusal, and *keeps* the
        narrower size for the rest of the sweep. Halving per-chunk only would pay one wasted
        request per chunk against a strict endpoint.
      - Rate limiting is terminal (rpcQueue owns backoff); "too many results" is what gets
        subdivided. Those are different failures and only one of them is helped by waiting.
      - **`incomplete` (a request failed) is kept distinct from `budgetStopped` (deeper
        history simply not fetched yet).** Conflating them makes the UI warn about a working
        system.
      - Contiguity is the invariant: a failed chunk ends that direction rather than being
        skipped, because a range recorded as covered but containing a hole would make the
        next load resume past missing events and lose them for good.
      - A cached `toBlock` above the head is discarded (testnet reset / deep reorg).
- [x] **Chart now costs one `getLogs` per chunk, not two** — viem turns an events ARRAY into
      a topic0 OR-set, so asking for `Buy` and `Sell` separately was double the requests.
- [x] **Coverage is now reported, not assumed.** `lookbackBlocks` is the range actually
      covered and `complete` says whether history reaches the chain start. The old disclaimer
      printed a hardcoded figure, which stayed reassuringly precise while the window it
      described had stopped containing any trades at all.

### Chart rendering (two separate bugs, both in `PriceChart.tsx`)
- [x] **Only ONE point was ever drawn.** A circle was emitted for the last point alone, so
      intermediate trades existed in the path but had no markers. Every point now gets one.
- [x] **`preserveAspectRatio="none"` on a 100x100 viewBox stretched that circle into a
      blob.** Rendered into a ~900x200 box, x scaled ~9x and y ~2x, so `r={3}` painted as a
      ~54x12px ellipse. `vectorEffect="non-scaling-stroke"` compensates for the STROKE and
      does nothing for geometry — which is why it looked like "a single large blue dot".
      The viewBox is now the element's **actual pixel size** (measured with a
      `ResizeObserver`, no dependency), so the scale is exactly 1 and a circle is a circle.
      That is also what makes the radii trustworthy in real pixels.
      - Dots shrink as the series densifies (2.3px → 1.1px) so 200 points annotate the line
        instead of burying it. Every point is still drawn.
      - Continuous polyline through all points, live point ringed, **no candlesticks**.
      - `useLayoutEffect` (browser only) so the first paint is already at the real width.
      - `isLoading` is in the measure effect's deps: the measured container does not exist
        while the skeleton shows, so without it the observer would never attach and the plot
        would stay stuck at the fallback width forever.

### Outcome removal (`/market/[id]`)
- [x] **A removed outcome still appeared in its event's Outcomes list.**
      `lib/hiddenMarkets.ts` is a presentation filter, so it only works where it is applied
      — and it was applied on `/` but **not** on the market page, which grouped the RAW
      market list. So a deletion visibly half-applied: gone from the home grid, still in the
      Outcomes list. Now filtered through the same `useHiddenMarkets()`, which re-reads on
      the change event, so removal takes effect immediately in-tab with no reload.
- [x] **The removed market's own page still works**, and says so. Everything it renders comes
      from `useMarket`, not from the group, so a direct link still shows price, position and
      Redeem. Deliberate: `MarketFactory` has no delete, so shares may still be outstanding
      and holders must be able to get their money out. A short notice states this rather than
      leaving the page looking inexplicably unlisted.

### Verification (this session)
- [x] `npx tsc --noEmit` → **0 errors**
- [x] `npm run build` → **success**, 11 routes
- [x] `npm test` → **74 passing** (unchanged; no contract was touched)
- [x] **`lib/logScan.ts` verified by execution, not just by types.** 52 assertions against a
      simulated chain, compiled with the repo's own `tsc` and run under node — including a
      regression assertion that the events it now finds are *provably* the ones the old
      54,000-block window would have missed. Covers: deep history found, chain ordering,
      boundary dedupe, warm reload costing exactly one request (and zero when already at the
      head), halving against a strict endpoint, rate-limit-is-terminal (no halving storm),
      contiguity on partial failure, budget-stop vs degraded, request cap, early exit,
      stale-cache rejection, event cap keeping the newest, and never throwing.
- [x] **Zero new dependencies.** No package added, removed or upgraded, so `npm audit` is
      unchanged and the 7-day release-age floor is satisfied vacuously.

### Not done / notes for next time
- [ ] **No browser verification.** Everything typechecks, builds, and the scan core is
      covered by executed assertions, but the RPC (`rpc.testnet.arc.io`) is unreachable from
      this environment — Cloudflare returns error 1009 (region blocked) — so nothing was
      exercised against the live chain. **The highest-value next step**, in this order:
      1. Open a market with trade history: the line must show many small dots joined
         continuously, not one blob. Resize the window — dots must stay ROUND.
      2. `/leaderboard` and `/profile`: real volumes and rankings, not an empty state.
         Check a total against a hand-computed figure from two known trades.
      3. Hide an outcome from `/admin`, then open a sibling outcome's market page: the hidden
         one must be gone from the Outcomes list. Then open the hidden one's own URL and
         confirm it still loads, warns, and can still redeem.
      4. Watch the network panel on a cold market page, then reload: the second load should
         be roughly one request, not a rescan.
- [ ] **`lib/logScan.ts` budget may need tuning against the real chain.** `MAX_NEW_BLOCKS`
      (1.2M) and the start chunks (45k chart / 20k ledger) are chosen blind, because Arc's
      per-request block-range limit could not be probed from here. If a cold load feels slow,
      lower the start chunk; if history is still shallow after a visit or two, raise
      `MAX_NEW_BLOCKS`. The design self-tunes downward on refusal but never upward.
- [ ] **No frontend test runner exists**, so the scan core's assertions live outside the repo
      rather than in CI. Adding one is a dependency decision for the project owner
      (`DEPENDENCIES.md` rules apply); vitest would be the obvious candidate.
- [ ] `npx hardhat run scripts/e2e-local.ts` — not re-run; no contract changed this session.
- [ ] ESLint has never been configured here — `npm run lint` drops into Next's interactive
      setup prompt and exits non-zero. Pre-existing, and left alone rather than picking a
      config on the owner's behalf.

## ✅ Previous session — profiles, comments, leaderboard, card buttons

### Verification (this session)
- [x] `npm run compile` → `Social.sol` compiles under 0.8.20 (evm target: paris)
- [x] `npm test` → **68 passing** (33 pre-existing + 35 new `Social` cases)
- [x] `cd frontend && npx tsc --noEmit` → **0 errors**
- [x] `cd frontend && npm run build` → **success**, 11 routes generated
      (8 pre-existing + `/leaderboard`, `/profile`, `/profile/[address]`)
- [ ] `npx hardhat run scripts/e2e-local.ts` — not re-run. Contracts changed only by
      addition; `Social` is not part of the trade/redeem lifecycle.
- [ ] **Still no browser verification.** Everything typechecks, builds and is covered by
      contract tests, but none of the new UI has been opened in a browser. This now
      covers considerably more surface than before — see the walkthrough in "Still open".

> No packages were added, removed or upgraded, so `npm audit` is unchanged from the
> previous session and the 7-day release-age floor is satisfied vacuously.

### Fixed during verification
- [x] **`Address | null` reached `writeContract` in two components.** `Comments.tsx` and
      `ProfileView.tsx` both early-return when the registry is absent, but their submit
      handlers are **hoisted function declarations**, so TypeScript analyses them without
      that narrowing. `tsc` caught `Comments`; it did NOT catch `ProfileView`, because
      there the same bug was hidden behind an `as \`0x${string}\`` cast. Both now re-check
      `if (!registry) return` locally. The cast would have silenced the compiler while
      leaving a real null able to reach the signer.

### Added
- [x] **`contracts/src/Social.sol`** — additive registry with **permissionless** writes,
      the key difference from `MarketMetadata`. Globally unique usernames (3–20 bytes,
      `a-z0-9_-`, uniqueness on the lowercased form so homoglyphs cannot impersonate)
      and per-market comment threads (≤200 bytes, 30s per-author cooldown, soft delete
      by author or owner). Comments are **stored, not event-only**, so the thread is
      exact instead of being limited to a bounded log window.
      Plus `contracts/test/Social.test.ts` and `scripts/deploy-social.ts`.
- [x] **Trade ledger** — `lib/ledger.ts` (pure bigint average-cost accounting) and
      `hooks/useTradeLedger.ts`. The whole leaderboard is **~6 RPC requests regardless of
      market count**, because `getLogs` takes an address ARRAY and an events ARRAY, so one
      request covers every pool and both event types. A per-market loop would have been
      12N. Includes adaptive chunk halving for dense ranges, which a plain 429 retry
      cannot fix because "too many results" is not a rate-limit error.
- [x] **Profiles** (`/profile`, `/profile/[address]`), **leaderboard** (`/leaderboard`),
      `components/TradeTable.tsx`, `components/ProfileView.tsx`, `components/Comments.tsx`.
- [x] **Potential profit** in `TradePanel`, below the trade controls.
- [x] **YES/NO buttons on cards**; multi-outcome cards show the first two outcomes by
      exact name with their own buttons.
- [x] **In-page outcome switching** on the market page — chart, odds, position and trade
      panel all follow the selection, URL synced via `replaceState`.

### Fixed
- [x] **`formatUsdc` was wrong for every negative amount.** `padStart` on `"-1"` yields
      `"0000-1"`, which put the minus sign inside the FRACTION: `-1` rendered as
      `"0.0000-1"` and `-500000` as `"-.5"`. Latent until now because every caller passed
      a balance or a quote; PnL is the first signed money in the app. Now strips the sign
      before padding and re-applies it, with `formatUsdcSigned` for explicit +/- display.
      `formatUsdcCompact` had the same root cause plus never applying K/M to negatives.
- [x] **`lib/abis.ts` documented the removed chart replay.** Its comment still said the
      events were replayed "from the pool's creation block ... to reconstruct reserves",
      which is exactly the pattern `CLAUDE.md` forbids and that caused the 429s. Replaced
      with the price-from-event-args explanation and an explicit do-not-reintroduce note.

### Changed
- [x] **`logCache` v3 → v4.** `CachedEvent` gained an `address` field: the chart's
      per-pool entries knew their pool from the cache key, but the shared ledger stores
      many pools under one key, so each event must carry its own. v3 entries are
      discarded rather than read without it. `validate()` rebuilds events field by field,
      so the new field had to be threaded there too or it would be silently dropped.

### Still open
- [ ] **`npm run deploy:social:testnet`** — the one action needed before comments and
      usernames work at all. Until it runs, `getSocialAddress(chainId)` is null, so
      usernames fall back to the derived `arcXXXX` default and the comments section does
      not render. Both degrade quietly by design, exactly like `marketMetadata` before it.
      Note `Social` has its **own** owner (the deployer), used only for moderation —
      setting a name and posting are permissionless.
- [ ] **Browser walkthrough**, in this order:
      1. `/` — binary cards show priced Yes/No buttons; multi-outcome cards show the first
         two outcomes by name, each with its own buttons. Clicking preselects that side.
      2. A multi-outcome market — click through outcomes; chart, odds, position and trade
         panel must all follow, and the URL must update without stacking history entries.
      3. Type an amount — potential profit updates live and recomputes on outcome switch.
      4. Set a username, post a comment, then reload in a **different browser profile** to
         prove both are genuinely shared rather than per-browser.
      5. `/profile` and `/leaderboard` — check totals against a hand-computed figure from
         two known trades, and confirm the partial/incomplete labels appear when the log
         scan is truncated.
- [ ] **The ledger's window is bounded** (~54,000 blocks). Positions opened before it show
      as `basisIncomplete` and their PnL is withheld rather than guessed. If that proves
      too aggressive in practice, widen `LOOKBACK_BLOCKS` in `hooks/useTradeLedger.ts` —
      the scan is ~6 requests regardless of market count, so there is real headroom.

## ✅ Previous session — descriptions, image URLs, chart + approval fixes

### Verification (this session)
- [x] `npm test` → **33 passing** (19 pre-existing + 14 new `MarketMetadata` cases)
- [x] `npm run compile` → `MarketMetadata.sol` compiles under 0.8.20
- [x] `npx tsc --noEmit` → **0 errors**
- [x] `npm run build` → **success**, all 6 routes generated
- [ ] `npx hardhat run scripts/e2e-local.ts` — not re-run this session (contracts changed
      only by addition; the new registry is not part of the trade/redeem lifecycle)
- [ ] **Still no browser verification.** Everything below typechecks, builds and is covered
      by contract tests, but none of the new UI has been opened in a browser. See the
      walkthrough in "Still open".

> The `indexedDB is not defined` lines during build remain pre-existing WalletConnect SSR
> noise from RainbowKit, not an error. Build exits 0.


### Fixed
- [x] **Approve → Buy needed a page refresh.** Two bugs in `components/TradePanel.tsx`:
      the allowance read never captured `refetch`, *and* the `txDone` effect treated every
      confirmed transaction as a trade — so approving cleared the amount input, which
      dropped `amount` to 0 and flipped the button to a disabled "Buy". Re-entering the
      amount brought "Approve" back because the allowance was still cached. Now a
      `pending` intent tags each transaction, approvals refetch the allowance and **keep**
      the typed amount, and a `settledHashRef` guard stops a latched `txDone` from
      settling the *next* transaction against the previous receipt.
- [x] **The price chart hid itself.** `usePriceHistory` compared replayed reserves to live
      ones with exact bigint equality and `PriceChart` hid the whole chart on any mismatch.
      A single missed log, a direct ERC-1155 transfer into the pool, or a *failed*
      `reserves()` read all tripped it — and `useMarket` returned `BigInt(0)` on a failed
      read, which never equals a real replay, so an RPC hiccup silently hid a correct chart.
      Now: `useMarket` exposes `reservesKnown`, the hook reports
      `accuracy: 'verified' | 'approximate' | 'unknown'`, and the chart **always renders**,
      labelled when imprecise. The headline price is read straight from the contract either way.
- [x] **`findCreationBlock` claimed "No trades yet" for markets with history.** On a
      non-rate-limit error it returned `latest`, so the scan covered zero blocks and found
      nothing. Now falls back to a bounded lookback, flags the result `partial`, and does
      not cache the failure.
- [x] **Chart was mouse-only.** Added touch scrubbing; the hover readout was unreachable
      on mobile.
- [x] **`lib/sanitize.ts` corruption, prevented structurally.** Its invisible-character
      regexes have been silently reduced to no-ops **twice** by reformatting that replaced
      `\uXXXX` escapes with the literal characters they denote — and it happened *again*
      while editing this session. Rewritten to block by **codepoint number** via a `Set`,
      which cannot be corrupted that way. Every executable line is now pure ASCII.
- [x] **`DEPENDENCIES.md` recorded `next` 14.2.15** while `package.json` pinned 14.2.35 —
      a stale version on the page that exists to be the source of truth for dependency
      security. Corrected.

### Added
- [x] **`contracts/src/MarketMetadata.sol`** — owner-gated registry keyed by `questionId`:
      description (≤2000 bytes), image URL (≤512), resolution source (≤256), plus a
      batch setter/getter capped at 50. **Additive**: the live `MarketFactory`
      (`0x5277…6037`) is not upgradeable and has no such fields, and redeploying it would
      abandon every existing market, pool and position. Deliberately *not* linked to the
      factory, which is what makes backfilling already-deployed markets possible.
- [x] **`scripts/deploy-metadata.ts`** + `npm run deploy:metadata:{local,testnet}` —
      deploys only the registry and merges one key into the deployment index. Refuses to
      run when no factory entry exists for the chain.
- [x] **Descriptions on the public market page**, rendered as real paragraphs via a new
      `sanitizeMultiline` (preserves paragraph breaks, still strips controls/bidi/zero-width)
      — as `<p>` text nodes, so the zero-exception "never `dangerouslySetInnerHTML`" rule holds.
- [x] **External image URLs instead of uploads**, validated by `safeImageUrl` on top of the
      existing https-only `safeExternalUrl`. Rendered with `object-fit: cover`,
      `referrerPolicy="no-referrer"`, lazy loading, and an `onError` fallback to the
      generated monogram.
- [x] **Admin: description, image URL, resolution source**, plus per-outcome image URLs.
      Creation now parses `questionId` from the `MarketCreated` receipt log (never assumes
      the counter) and writes all details in **one** `setMetadataBatch`.
- [x] **"Edit details" on every market row** — the backfill path for markets that predate
      the registry, including everything currently live on testnet.
- [x] **Faucet button in the header for ALL users** (`components/FaucetButton.tsx`), with
      an on-chain cooldown countdown. It was previously admin-only, which is precisely
      backwards — the people who need test funds cannot reach `/admin`.
- [x] **Zero new npm dependencies.**

### Known consequences to confirm
- [ ] **`/admin` now refuses to create markets until `MarketMetadata` is deployed** on that
      chain. Deliberate — images are required, and without the registry there is nowhere to
      put one — but it *is* a behaviour change, and the live testnet needs
      `npm run deploy:metadata:testnet` before any new market can be created.
- [ ] **The registry has its own owner.** If it is not the factory owner, metadata writes
      revert while the UI still shows the controls.
- [ ] Existing testnet markets show **no description** until backfilled.
- [ ] Setting metadata costs gas per market (one extra transaction per create).
- [ ] **Security trade-off accepted:** remote image URLs mean the viewer's browser fetches
      from a third-party host (disclosing its IP) and the host can swap the image after an
      admin approved it. The old upload path re-encoded through a canvas so only pixels
      survived. `no-referrer` + https-only + owner-only writes bound this; it cannot be
      eliminated client-side.
- [ ] `components/MarketImageUpload.tsx` is now **unused**. `lib/marketImages.ts` is still
      read so pre-existing uploads keep rendering. Delete both once you're satisfied nothing
      local is worth keeping.
- [x] **`frontend/upload/` deleted** (removed manually by the project owner) — it was a
      leftover Vercel upload test, not part of the project. It had to go: `@/*` resolves to
      the *real* `frontend/`, so its stale `app/market/[id]/page.tsx` called the new
      `usePriceHistory`/`PriceChart` with the removed `verified` prop and would have failed
      `tsc --noEmit` and `npm run build`. The interim `tsconfig.json` exclude has been
      reverted. (An earlier `TODO.md` claimed this folder was already deleted; it was not,
      and it had drifted — its `lib/deployments/index.json` carried a deployer address the
      live one does not.)

## ✅ Latest session — images, carousel, admin rebuild (2026-08-07)

### Audit finding (fixed)
- [x] **`.gitignore` was inert — every pattern had leading whitespace**, plus a stray
      `gitignore` word on line 1 (the paste-corruption signature this file warns about).
      Git strips *trailing* whitespace from patterns but treats *leading* whitespace as
      part of the pattern, so `  node_modules/` matched a directory literally named
      `␣␣node_modules`. Net effect: **nothing was ignored** — `node_modules/`, `.env`,
      artifacts and coverage were all committable, despite CLAUDE.md's "never commit
      `contracts/.env`" rule. Rewritten flush-left and **verified with
      `git check-ignore`** (`.env`, `node_modules/`, `coverage.json`, `.next/`, `*.log`
      → ignored; `frontend/lib/*.ts` → still tracked). Added `frontend/tsconfig.tsbuildinfo`.
      *Same class as last session's missing-dot `.npmrc`: a config file that looked
      correct in review but was silently doing nothing.*

### Features built
- [x] **Market image upload** (`lib/marketImages.ts`, `components/MarketImageUpload.tsx`) —
      client-side only, no server and no storage dependency. Security model: the file is
      **decoded and re-encoded through a canvas**, so only pixels survive — any embedded
      EXIF, script payload or polyglot bytes are discarded rather than trusted. Enforces
      a type allowlist, a byte cap, and a decode timeout; the resulting data URL is
      re-validated against a strict `data:image/(png|jpeg|webp);base64,` prefix before it
      is ever put in `src`. Stored per `chainId:questionId` in `localStorage`.
- [x] **Featured carousel rebuilt** — larger cards, per-outcome prices for event groups,
      pool liquidity, scroll-snap rail with keyboard arrows and paging dots.
- [x] **Homepage reordered** — search/category toolbar moved **above** Featured. Filtering
      hides the Featured rail, so with the toolbar below it the controls jumped upward
      under the cursor mid-interaction; above the rail the toolbar never moves.
- [x] **Admin panel rebuilt** — restyled onto the design tokens (it was the one page still
      on raw `gray-*`/`red-*` utilities), plus:
      - **Multi-outcome creation UI** — add/remove/reorder/rename outcomes, then submits
        **one `createMarket` per outcome, sequentially**, awaiting each receipt so the
        factory's `questionId` counter and the wallet nonce stay consistent. Progress is
        surfaced ("Creating 2 of 3…") and **partial failure is reported honestly**
        ("Stopped after creating 2 of 3") rather than swallowed.
      - **Byte-length validation, not character length** — the contracts check
        `bytes(question).length`, so a multi-byte question could pass a 256-*char* check
        and still revert. Uses `TextEncoder`.
      - **Rejects a colon in the event title**, because `parseQuestion` splits on the
        first colon and would otherwise re-cut every generated question incorrectly.
      - **Per-market image upload** and **hide-from-list**, both inline in the market row.
- [x] **Hide, not delete** (`lib/hiddenMarkets.ts`) — `MarketFactory` has **no delete or
      archive function** and markets are enumerated `0..nextQuestionId`, so real deletion
      would mean redeploying the factory and abandoning every open position. Hiding is a
      presentation filter: the market, its pool and all positions stay on-chain and
      reachable by URL, so **holders can always still redeem**. Confirm-then-hide, with
      that tradeoff stated in the UI rather than only in code.
- [x] **Contract coverage run** — 19 passing; **87.23% stmts · 89.63% lines · 78.79% funcs
      · 52.33% branch**. `MockUSDC` 100%. Branch coverage is the weak axis: the untested
      paths are mostly revert guards (`ConditionalTokens` 159/160/170, `MarketFactory`
      125/136/137). Worth a dedicated negative-path test pass.
- [x] **`LICENSE` added** (MIT), which README already referenced.

### Verification (this session)
- [x] `npx tsc --noEmit` → **0 errors**
- [x] `npm run build` → **success**, all 6 routes generated
- [x] `npm test` → **19/19 passing**
- [x] `npx hardhat run scripts/e2e-local.ts` → **lifecycle passed**, conservation OK
- [x] `git check-ignore` → `.gitignore` patterns confirmed matching

## ✅ Earlier session — production UI rebuild (2026-08-07)

### Audit findings (all fixed)
- [x] **`npmrc` was missing its leading dot** → npm never read it. `ignore-scripts` and
      `save-exact` were silently `false` at the repo root the whole time, despite
      DEPENDENCIES.md claiming mechanical enforcement. Renamed to `.npmrc`, verified
      active (`npm config get` returns `true` for both).
- [x] **`min-release-age` is not an npm setting** — `npm config get` returns `null`.
      It's a pnpm feature (`minimumReleaseAge`). Corrected DEPENDENCIES.md: the 7-day
      floor is a PROCESS control, not a mechanical one. Key kept as documented no-op.
- [x] **`frontend/.npmrc` created** (long-standing TODO). Matters because Vercel
      installs with Root Directory = `frontend`, where the root `.npmrc` does not apply.
- [x] **`lib/sanitize.ts` was paste-corrupted** — the zero-width/replacement-char regexes
      contained *literal* invisible characters instead of `\uXXXX` escapes, breaking the
      invariant its own docstring states. Rewritten as pure-ASCII escapes; also added
      bidi-override stripping (`‪-‮`, `⁦-⁩`) for RTL spoofing.
- [x] **`/admin` had an unguarded `BigInt(NaN)` throw** — `parseInt(resolveDays)` on a
      cleared field threw inside a click handler. Now validates days, fee bps, and runs
      the resolver through `safeAddress()`.
- [x] **`frontend/upload/` was a byte-identical copy of the whole frontend** sitting
      inside the Vercel root dir (so it was type-checked and built, and would silently
      drift). Deleted after `diff -rq` confirmed zero differences.
- [x] **`zod` was installed but never imported** — removed. Validation is done by
      `lib/sanitize.ts` + `lib/format.ts`, which are total (never throw) and auditable.
- [x] **No viewport meta** — added `export const viewport` in `layout.tsx`. Without it
      mobile assumes a ~980px layout viewport and every breakpoint is wrong.

### Security: dependency audit
- [x] `npm audit` surfaced **1 critical** (Next.js middleware authorization bypass,
      `<14.2.25`). Upgraded `next` 14.2.15 → **14.2.35** (newest 14.2.x, published
      2025-12-11, 238 days old → passes the 7-day floor with margin). **Critical is now 0.**
- [ ] **Remaining: 67 advisories (0 critical, 12 high, 30 moderate, 25 low).** Not yet
      addressed because the fixes are semver-major and need their own verification pass:
      - Most remaining Next.js items need **Next 15** (`<15.5.x` ranges). Assessed as
        **not exploitable here**: no `middleware.ts`, no `"use server"` actions, no
        `next/image`, no i18n, no rewrites. They are DoS/SSRF/cache issues in features
        this app does not use.
      - `ws` (high) reaches us via `viem`. Fix needs `viem@2.55.11`, outside the range
        `wagmi@2.12.17` pins, so it implies a wagmi upgrade too. App code uses the HTTP
        transport (RainbowKit default), not the WebSocket one, so exposure is low.
      - **Recommendation:** do the Next 15 + wagmi/viem bump as a separate, isolated
        change with a full re-verify, not bundled with UI work.

### Features built
- [x] **Design system** — `tailwind.config.js` semantic tokens (surface/edge/content/
      brand/yes/no) bound to CSS variables in `globals.css`; `darkMode: 'class'`;
      light+dark parity by construction. Focus-visible rings, `prefers-reduced-motion`.
- [x] **Dark mode** with header toggle persisted to `localStorage`. No `next-themes`
      dependency. Pre-paint theme is applied by `public/theme-init.js` — a static,
      blocking, same-origin script rather than an inline one, so the repo's
      "never `dangerouslySetInnerHTML`" rule holds with **zero** exceptions (verified:
      no occurrences anywhere in `app/`, `components/`, `lib/`, `hooks/`). It is also
      CSP-safe without a nonce.
- [x] **Compact market cards** (~112px) in a responsive 1/2/3/4-column grid.
- [x] **Search** across event title, outcome labels, full question, and category.
- [x] **Categories** — 7 canonical buckets inferred from the free-form on-chain string
      with a question-text fallback; chips show live counts and hide when empty.
- [x] **Featured slider** — native CSS scroll-snap rail (no carousel dependency),
      ranked by pool liquidity, with keyboard-accessible arrow controls.
- [x] **Market icons** — deterministic FNV-1a monogram + accent, generated locally.
      No external image fetches, no new dependency, stable across clients.
- [x] **Multi-outcome events** — grouped via the `"Event: Outcome"` convention in the
      on-chain question string (`lib/eventGroups.ts`). **Zero contract changes.** Each
      outcome stays its own binary market with its own FPMM and its own YES/NO price,
      which is how Polymarket models multi-outcome. Conservative: a lone market
      containing a colon is NOT treated as an event (needs 2+ sharing a title).
- [x] **Real price/probability chart** — `hooks/usePriceHistory.ts` replays
      `Buy`/`Sell`/`LiquidityAdded`/`LiquidityRemoved` forward from the pool's creation
      block (found via the factory's `MarketCreated` log) to reconstruct reserves at
      every trade. Chose event replay over historical `eth_call` because archive state
      isn't guaranteed on public RPCs. **Self-verifying:** final replayed reserves are
      compared against live `reserves()`, and the chart is *hidden with an explanation*
      rather than shown if they diverge. Step interpolation, because AMM price is
      constant between trades and jumps at them.
- [x] **Chart is hand-rolled inline SVG** — no charting library (see DEPENDENCIES.md
      "Deliberately NOT added"). Includes an `sr-only` `<table>` of the series so screen
      readers get real numbers.
- [x] **Trade panel beside the chart** — two-column on desktop (sticky), stacked on
      mobile. Buy/sell, outcome toggle with live prices, quick amounts, **user-selectable
      slippage** (0.5/1/3%), explicit worst-case ("minimum received" / "maximum sold"),
      and contract custom errors mapped to plain language.
- [x] **Redesigned portfolio** — mark-to-market estimate, redeemable total, per-position
      rows. Estimate is labelled as an estimate.
- [x] **Header** — sticky, responsive, Admin link only rendered for the factory owner
      (UI convenience; page + contract still enforce).

### Verification (this session)
- [x] `npx tsc --noEmit` → **0 errors**
- [x] `npm run build` → **success**, all 6 routes generated
- [x] `npm test` → **19/19 contract tests passing**
- [x] `npx hardhat run scripts/e2e-local.ts` → **full lifecycle passed**, conservation OK
- [x] `.npmrc` settings re-verified active after rewrite

> The `indexedDB is not defined` lines during build are pre-existing WalletConnect SSR
> noise from RainbowKit, not an error. Build exits 0.

## ⏳ Still open

### Never done: real browser verification
- [ ] **No part of this UI has been opened in a browser.** It typechecks, builds, and the
      contract layer is proven by tests + E2E, but visual/interaction confirmation is
      outstanding. This is the highest-value next step.
- [ ] T1 `npm run node` · T2 `npm run deploy:local` · T3 `npm run dev`
- [ ] Connect wallet to chain 31337 and walk: browse → search → filter → open market →
      chart renders → buy → sell → resolve (admin) → redeem → portfolio updates
- [ ] **Approve → Buy without refreshing.** Enter an amount, Approve, confirm — the Buy
      button must become available with the amount **still filled in**. This is the exact
      regression that was reported; it is the single highest-value thing to click.
- [ ] **Chart no longer hides.** Open a market with trade history and confirm it renders.
      Then force a reserve mismatch (transfer an ERC-1155 share directly into the pool) and
      confirm the chart **still renders**, now badged "Approximate", with the headline price
      still matching the contract.
- [ ] **Chart on a phone** — the hover/scrub readout was mouse-only until this session.
- [ ] **Metadata is shared, unlike localStorage.** Create a market with a description,
      image URL and resolution source, then open it in a **second browser profile** and
      confirm all three still appear. That is the whole point of putting them on-chain.
- [ ] **Backfill** an existing market via "Edit details" on its admin row.
- [ ] **Image safety:** a `javascript:` or plain `http:` URL must be rejected by the form; a
      well-formed but dead URL must fall back to the monogram, not a broken-image glyph.
- [ ] **Faucet as a NON-owner wallet** — balance increases; claiming again shows the
      cooldown countdown rather than a raw revert dump.
- [ ] Confirm 6-decimal USDC display is correct everywhere
- [ ] **Verify the chart against a market with real trade history.** The replay math is
      derived from the contract source and self-checks against live reserves, but it has
      not yet run against a populated pool.
- [ ] Test multi-outcome grouping via `/admin` → "Multiple outcomes": title
      `US Election 2028`, outcomes `Democrat` / `Republican` / `Independent`. Confirm 3
      transactions fire in order and the 3 markets group into one event card.
- [ ] **Upload an image** to a market and confirm: it appears on the card, the detail page,
      the carousel and the portfolio row; that a non-image file is rejected; and that a
      file above the size cap is rejected.
- [ ] **Hide a market**, confirm it leaves the list and its event card count drops, then
      confirm the market is **still reachable by direct URL and still redeemable**.
- [ ] Confirm the reordered homepage: filtering to a category hides the Featured rail and
      the toolbar stays put.

### Dependency upgrades (isolated change, own verification)
- [ ] Next 15 + wagmi/viem bump to clear the remaining 12 high / 30 moderate advisories

### Polish
- [ ] Testnet deploy (needs a funded key + faucet USDC)
- [ ] Verify contracts on Arcscan if supported
- [ ] **Negative-path contract tests** — branch coverage is 52.33% while line coverage is
      89.63%. The gap is revert guards, which is exactly the code you least want untested.

## ⚠️ Notes / caveats
- **Arc mainnet is NOT live** — config is env-gated and ready; only testnet (5042002).
- **Contracts are binary at every layer** — `OUTCOME_COUNT = 2` is baked into the
  `conditionId` hash, `payouts` is `uint256[2]`, and the FPMM has immutable
  `yesPositionId`/`noPositionId`. A single N-outcome AMM would require redeploying all
  three contracts. The current grouping approach deliberately avoids that.
- **Market images and the hidden list are per-browser `localStorage`.** They are NOT
  shared between users and NOT on-chain — the contracts have no image field and no
  delete/archive function. Another visitor sees the generated monogram icon and the full
  market list. **A backend now exists** (Neon Postgres behind the route handlers in
  `frontend/app/api/**`), which closes out the older "there is no backend" caveat — but
  neither images nor the hidden list moved into it, deliberately: that database is a
  projection of chain bytes, and putting per-browser UI state in it would make it a system
  of record. Shared images are already solved on-chain by `MarketMetadata.sol` (external
  https URLs); the `localStorage` read path survives only so pre-existing uploads do not
  vanish.
- **Multi-outcome creation is N transactions, not one.** Each outcome is its own binary
  market, so a 4-outcome event needs 4 signatures. An interrupted run leaves the
  already-created outcomes on-chain; the UI reports how many succeeded.
- **Paste-corruption watch:** if a file looks off, check for literal invisible characters,
  a stray leading ```` ```lang ```` line, or **leading whitespace on every line**. This has
  now bitten this repo three times: the original `.sol` files, `lib/sanitize.ts`, and
  `.gitignore`. Config files fail *silently* — verify them by asking the tool
  (`npm config get`, `git check-ignore`), never by reading the file.
