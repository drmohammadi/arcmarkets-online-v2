# CLAUDE.md — Arc Prediction Market

Guidance for Claude Code working in this repo. Read `TODO.md` for current status/next steps.

## What this is
Polymarket-style **binary (YES/NO) prediction market** on **Circle's Arc L1** (EVM). Monorepo:
`contracts/` (Hardhat + Solidity) and `frontend/` (Next.js 14 + wagmi + RainbowKit).

## Standing rules (from the project owner — always follow)
- **Sanitize all outputs.** Chain-derived strings (market question/category, addresses) go through
  `frontend/lib/sanitize.ts` before render. Never `dangerouslySetInnerHTML`.
- **Handle every error.** No unguarded throws in render paths; every `writeContract` has `onError`.
- **Modular, testable code.** Small units; reuse existing libs/hooks.
- **Per-dependency justification.** Before adding ANY dependency, document in `DEPENDENCIES.md`:
  why chosen · why secure · why over alternatives · **is the pinned version >7 days old**.
  If it fails any of these, pick a safer alternative. `.npmrc` enforces `min-release-age=7`,
  `ignore-scripts=true`, `save-exact=true`. Verify publish date on the registry before pinning.

## Architecture
- **5 contracts** in `contracts/src/`:
  - `MockUSDC.sol` — 6-decimal test ERC-20 (testnet only; real USDC on mainnet). Has a
    public `faucet()`: 1000 USDC per address per day, enforced on-chain.
  - `ConditionalTokens.sol` — ERC-1155 YES/NO shares; split/merge/report/redeem.
  - `FixedProductMarketMaker.sol` — constant-product AMM. **Never deployed directly** — the
    factory deploys one per market via `new`. Buy is parameterized by collateral-in, sell by
    collateral-out; ceilDiv rounding always favors the pool.
  - `MarketFactory.sol` — owns ConditionalTokens; creates + resolves markets (time-gated,
    resolver-gated, one-shot). Emits `MarketCreated` (frontend's index source).
  - `MarketMetadata.sol` — **additive registry**, owner-gated, keyed by `questionId`:
    description (≤2000 bytes), image URL (≤512), resolution source (≤256). Deliberately
    NOT linked to the factory, so it works for markets created before it existed.
  - `Social.sol` — **additive registry, PERMISSIONLESS writes** (this is the key
    difference from `MarketMetadata`). Globally unique usernames keyed by `msg.sender`
    (3–20 bytes, charset `a-z0-9_-`, uniqueness enforced on the lowercased form so
    homoglyph impersonation is impossible), plus an append-only comment thread per
    `questionId` (≤200 bytes, 30s per-author cooldown, soft delete by author or owner).
    Comments are STORED, not event-only, so the thread is exact rather than limited to a
    bounded log window. Every string it returns is attacker-controlled — sanitize on read.
- **Frontend**: `app/` pages (`/` list, `/market/[id]` trade, `/profile` + `/profile/[address]`,
  `/leaderboard`, `/admin`, `/about`, `/terms`, `/privacy`), `components/` (Header, Footer,
  Logo, ContentPage, MarketCard, FeaturedSlider, PriceChart, TradePanel, LiquidityForm,
  MarketMetadataForm, FaucetButton, Comments, ProfileView, PortfolioPanel, TradeTable,
  `ui.tsx` primitives), `hooks/`
  (useMarkets, useMarket, useMarketPools, useMarketPayouts, useTradeHistory,
  useTradeLedger, useTradeStats, useSocial, useMarketMetadata, useMarketImage,
  usePosition), `lib/` (chains, format, sanitize, wagmi, abis, contracts, links,
  metadataFields, logCache, logScan, rpcQueue, marketImages, hiddenMarkets, eventGroups,
  pricing, time, marketMeta, ledger, username).
- **There is no `/portfolio` page.** Its UI is `components/PortfolioPanel.tsx`, rendered inside
  `ProfileView` beneath the username — so it works for ANY wallet, not just the connected one,
  and there is one implementation rather than two. The route still exists as a server-side
  redirect to `/profile` so shared links don't 404. Holdings render ABOVE the ledger-derived
  PnL/volume tiles on purpose: they come from one `balanceOfBatch` and are exact regardless of
  how far the log sweep has reached, whereas the PnL figures are only as complete as that
  sweep. Don't reorder them without moving the coverage caveats too.
- **Branding is env-configurable.** `NEXT_PUBLIC_LOGO_URL` (https only) replaces the built-in
  monogram in the header and footer; `NEXT_PUBLIC_SITE_NAME` renames the site. Both fall back
  cleanly, and a logo that fails to load reverts to the monogram.
- **The testnet RPC is env-overridable, with the public node as an automatic fallback.**
  `NEXT_PUBLIC_ARC_TESTNET_RPC_URL` (https only) and `NEXT_PUBLIC_ARC_TESTNET_WS_URL` (wss
  only) are validated in `lib/chains.ts`; anything else — plaintext http, a URL with embedded
  credentials, garbage — falls back to `https://rpc.testnet.arc.io` rather than breaking. The
  chain's `rpcUrls.default.http` is an ORDERED preference list (override first, public second)
  and `lib/wagmi.tsx` turns it into a viem `fallback` transport with `rank: false`, so a
  private endpoint that is down or over quota degrades to the public one instead of taking the
  app with it. Don't re-rank by latency — that would send traffic to the rate-limited public
  node whenever it happened to answer faster.
  **Any key placed there is PUBLIC** (`NEXT_PUBLIC_*` is inlined into the browser bundle —
  verifiable with `grep -rl <host> frontend/.next/static/chunks/`). Protect it with a
  provider-side domain allowlist and a spend cap, not by hoping nobody looks.
- **Wallets: `projectId` must be a real 32-hex WalletConnect id.** `lib/wagmi.tsx` validates
  it and, when absent, offers ONLY injected + Coinbase — the two connectors that work without
  the relay. It used to fall back to the string `'demo'`, which is not a valid id, so on
  mobile every relay-backed wallet (MetaMask, Trust, Rainbow) appeared in the picker and did
  nothing when tapped. Never reinstate a placeholder id: it fails at connect time, not load
  time, which makes it very hard to diagnose.
- **Multi-outcome events are a UI convention, not a contract feature.** Markets named
  `"Event: Outcome"` are grouped by `parseQuestion` (splits on the **first** colon). The
  contracts are binary at every layer, so an N-outcome event is N separate binary markets
  and N `createMarket` transactions — plus **one** `setMetadataBatch` for all their details.
- **Descriptions + image URLs are on-chain** in `MarketMetadata`, so every visitor sees
  them. Images are **external https URLs**, not uploaded bytes — the chain cannot verify a
  URL still points at the same image, so render sites use `referrerPolicy="no-referrer"`,
  a fixed box with `object-fit: cover`, and an `onError` fallback to the monogram.
- **Legacy: uploaded images + hidden markets are `localStorage`**, keyed `chainId:questionId`.
  Per-browser, not shared. The uploaded-image read path is kept only so pre-existing
  uploads don't vanish; new images go on-chain. Hiding is still a display filter —
  `MarketFactory` has no delete, and hidden markets stay tradable by direct URL.

## Commands (run from repo root)
- `npm test` — contract tests (19 pre-existing + `MarketMetadata` suite)
- `npm run compile` — compile contracts
- `npm run node` — local Hardhat node (chain 31337)
- `npm run deploy:local` / `npm run deploy:testnet` — deploy + write addresses to
  `frontend/lib/deployments/index.json`
- `npm run deploy:metadata:testnet` — deploy **only** `MarketMetadata` and merge its
  address into an existing chain entry. **Use this on a chain that already has a live
  factory** — a full `deploy:testnet` would deploy a NEW factory and orphan every
  existing market, pool and position.
- `npm run discover:startblock:testnet` — backfill `startBlock` (the trade-log scan floor)
  for a chain whose factory is already deployed. `deploy.ts` records it automatically now;
  this is for entries that predate that. It binary-searches `eth_getCode` and **verifies the
  result against a second contract before writing**, because a pruned node answers `0x` for
  every block below its state horizon and would otherwise yield the horizon — a floor above
  the real deploy block, which hides trades silently. If it refuses, take the creation block
  from the explorer and set the field by hand.
- `npm run dev` — frontend dev server
- Full lifecycle proof (no wallet): `cd contracts && npx hardhat run scripts/e2e-local.ts`
- Frontend check: `cd frontend && npx tsc --noEmit && npm run build`

## Critical gotchas (these have bitten us)
- **USDC is 6 decimals, not 18.** Always use `lib/format.ts` (`parseUsdc`/`formatUsdc`).
  1 USDC = `1000000`. Arc's native gas token is also 6-decimal USDC.
- **Deploy order matters:** MockUSDC → ConditionalTokens → MarketFactory →
  **`ConditionalTokens.transferOwnership(factory)`** (skipping this makes `createMarket` revert).
- **Frontend needs real addresses** in `frontend/lib/deployments/index.json` keyed by chainId,
  else the UI shows "no markets". Arc testnet = `5042002`.
- **`marketMetadata` is optional in the deployment entry.** Every read path must degrade to
  "no description" rather than erroring when it is absent. But `/admin` **refuses to create
  markets** without it, because a market created then would have no way to store the
  required image — deploy the registry first.
- **BigInt literals:** use `BigInt(0)` not `0n` (tsconfig target compatibility).
- **ABIs** in `lib/abis.ts` are wrapped in viem's `parseAbi([...])` — keep that form.
- **Solidity/OZ pinning:** compiler 0.8.20 + OpenZeppelin 5.1.0. In Remix, pin OZ imports to
  `@openzeppelin/contracts@5.1.0/...`; do NOT add `@5.1.0` in the on-disk files (breaks Hardhat).
- **`/admin` is owner-gated:** connect the factory-owner wallet or it shows "access required".
  `MarketMetadata` has its **own** owner — if the two differ, metadata writes revert.
- **Validate question length in BYTES, not characters.** The contracts check
  `bytes(question).length <= 256`; a multi-byte string can pass a char check and still revert.
  Same for every `MarketMetadata` field — use `byteLength` from `lib/metadataFields.ts`.
- **The chart never reconstructs pool state.** `useTradeHistory` reads the price straight
  out of each `Buy`/`Sell` event's own args (`investmentAmount / sharesOut`, flipped for NO),
  so there is no reserve replay, no creation-block scan and no per-block `getBlock`. The
  earlier replay version was correct but so RPC-hungry it caused the 429s it then reported.
  Do not reintroduce a replay, a verification gate, or a time axis — the x-axis is trade
  SEQUENCE precisely so timestamps are never fetched. The last point is always the live
  contract price, so the chart still renders when zero logs load; failures set `degraded`,
  which labels the line instead of hiding it.
- **Log history is ANCHORED at the factory's deploy block, and is a GROWING window.**
  `lib/logScan.ts` owns the sweep for both `useTradeHistory` and `useTradeLedger`.
  Two rules, both load-bearing:
  1. **The floor is `deployments[chainId].startBlock`** (via `getStartBlock`), the block
     `MarketFactory` was deployed in. No Buy/Sell can predate it, so it is an exact bound.
     Arc testnet's head is past **57,300,000** while the factory sits at **55,632,013** —
     1.7M blocks back. Without the anchor the sweep crawled backward from the head hoping to
     hit the markets, reached ~640k blocks per load, and never got there: the chart drew one
     point and `/leaderboard` said "no trades in the scanned window" on a chain full of
     trades. **Never replace the floor with 0 or a head-relative guess.** A floor *above* the
     real deploy block is worse than none — it hides trades silently.
  2. **Do not "simplify" the window to `latest - N` blocks.** That is what broke the chart,
     `/profile` and `/leaderboard` simultaneously — a head-anchored window is a cache-eviction
     policy used as a query bound, so it discards precisely the old data a price history and a
     cost basis are made of. It fails *silently and progressively*: fine on a fresh chain,
     then quietly empty once the chain outruns it, with every page still rendering "no trades"
     as though that were the truth.
  Coverage is reported (`reachedFloor`, `lookbackBlocks`), never assumed. Note `incomplete`
  (a request failed) is deliberately distinct from `budgetStopped` (deeper history simply not
  fetched yet) — conflating them makes the UI warn about a working system.
- **`eth_getLogs` on Arc testnet has a RANGE CAP** (`-32012 requested range too large`;
  refused at 1,048,576 blocks). That is not a 429, so `rpcQueue` won't retry it — only asking
  for *less* helps, which is why `sweepLogs` halves on refusal. The accepted size is persisted
  per chain (`readChunkCeiling`), and is **monotonic**: a dense range refused for result
  *count* must not permanently throttle every later scan. Chunk sizes are ~120k (ledger) /
  ~250k (chart); the old 20k/45k made a 1.7M-block history cost more requests than the
  per-load cap allowed, so it could never finish.
- **The log cache is `localStorage`, deliberately** (`lib/logCache.ts`). It was
  `sessionStorage` to limit staleness after a testnet reset, but that made a multi-request
  scan re-pay its whole cost in every new tab, so depth was never retained and the pages
  stayed empty. The reset case is handled precisely instead: `sweepLogs` discards a cached
  range whose `toBlock` is above the current head. `CACHE_VERSION` is the escape hatch for
  shape changes — bump it, don't switch stores back.
- **Hiding a market must be filtered at EVERY browsable list.** `lib/hiddenMarkets.ts` is a
  presentation filter, so it only works where it is actually applied. It was applied on `/`
  but not on `/market/[id]`, so a removed outcome vanished from the home grid and still
  appeared in that event's Outcomes list. If you add a surface that lists markets, filter it
  through `useHiddenMarkets()`. The market's own page stays reachable by direct URL on
  purpose — `MarketFactory` has no delete, so shares may still be outstanding and holders
  must be able to redeem.
- **Config files here have twice been silently inert** (`.npmrc` missing its leading dot;
  `.gitignore` with leading whitespace on every line, which made every pattern match
  nothing). Never verify a config by reading it — ask the tool: `npm config get <key>`,
  `git check-ignore -v <path>`.
- **`lib/sanitize.ts` blocks characters by CODEPOINT NUMBER, not regex escapes.** Its
  invisible-character regexes were silently reduced to no-ops twice by reformatting that
  replaced `\uXXXX` escapes with the literal invisible characters. Numbers cannot be
  corrupted that way. Do not "simplify" it back into a character class.

## Network facts (verified)
- Arc **testnet**: chainId `5042002`, RPC `https://rpc.testnet.arc.io`,
  explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`.
- Arc **mainnet is NOT live yet** — config is env-gated and ready; can't deploy there today.

## Deploy target
- Frontend → Vercel with **Root Directory = `frontend`**. Never commit `contracts/.env`.
