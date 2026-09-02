 # Dependency Justification

  Every dependency is documented here per the project's final requirement:
  **why chosen · why secure · why better than alternatives · "older than 7 days" compliance.**

  ## Structural enforcement (verified 2026-08-07)

  The `.npmrc` files enforce security mechanically, so the rules can't be forgotten.
  **Each row below was verified empirically with `npm config get <key>` on npm 12.0.1**,
  not assumed from the file's contents:

  | Setting | Effect | Verified | Requirement it satisfies |
  |---|---|---|---|
  | `ignore-scripts=true` | No dependency install/postinstall scripts run | ✅ returns `true` | Blocks the most common supply-chain attack |
  | `save-exact=true` | Exact version pins, no `^`/`~` | ✅ returns `true` | Reproducible, no silent drift into a new release |
  | `audit=true` | `npm audit` runs on install | ✅ honored by npm | Surfaces known CVEs |
  | `min-release-age=7` | *(intended)* refuse recently-published versions | ❌ **returns `null` — npm ignores this key** | **NOT enforced — see below** |

  ### ⚠️ Two corrections to earlier versions of this document

  **1. The root config file was named `npmrc`, not `.npmrc`.**
  Because it lacked the leading dot, npm never read it. For the entire period before
  2026-08-07, `ignore-scripts` and `save-exact` were both silently `false` at the repo
  root despite this document claiming they were enforced. The file has been renamed to
  `.npmrc` and the settings confirmed active. `contracts/.npmrc` was always correct.

  **2. `min-release-age` is not an npm setting.**
  The earlier caveat in this file asked for the *unit* to be confirmed. The actual finding
  is stronger: the key does not exist in npm at all. `npm config get min-release-age`
  returns `null`, so npm silently ignores the line. It is a **pnpm** feature, spelled
  `minimumReleaseAge` (in ms) — see https://pnpm.io/settings#minimumreleaseage.

  **Therefore the 7-day floor is a PROCESS control, not a mechanical one.** It is enforced
  by: (a) pinning exact versions that are already many months old, (b) checking
  `npm view <pkg>@<version> time` before adding any dependency, and (c) this document.
  The line is retained in `.npmrc` as documentation of intent and as a no-op that becomes
  live if the project migrates to pnpm. **Do not rely on it as a gate.**

  All versions below are chosen to be **many months old**, so they pass a 7-day floor with
  huge margin.

  ## Contracts workspace

  ### hardhat `2.22.17`
  - **Why chosen:** npm-native Ethereum dev framework; compiles Solidity, runs a local EVM node,
    runs TS tests. Works on this Windows machine with zero extra toolchain.
  - **Why secure:** widely used, actively maintained by Nomic Foundation; large audited user base;
    no native binaries to trust beyond the solc download it manages.
  - **Better than alternatives:** **Foundry** is excellent but isn't installed here and its
    `foundryup` flow is painful on Windows; **Truffle** is deprecated. Hardhat is the pragmatic
    choice that runs *now*.
  - **7-day:** 2.22.x has been out for many months. Passes with margin.

  ### @nomicfoundation/hardhat-toolbox `5.0.0`
  - **Why chosen:** bundles the standard test/deploy stack (ethers v6, chai matchers, network
    helpers, gas reporter, typechain, coverage hooks) as one vetted, version-aligned set.
  - **Why secure:** first-party Nomic package; pins mutually compatible sub-deps, reducing the
    chance of a rogue transitive mismatch.
  - **Better than alternatives:** hand-assembling these packages invites version skew and more
    individually-tracked supply-chain surface. One curated bundle is smaller attack surface to reason about.
  - **7-day:** 5.0.0 is many months old. Passes.

  ### @openzeppelin/contracts `5.1.0`
  - **Why chosen:** the reference implementations for ERC-20, ERC-1155, AccessControl,
    ReentrancyGuard, Pausable, SafeERC20, Clones — exactly the primitives this market needs.
  - **Why secure:** the most-audited, most-battle-tested contract library in the ecosystem;
    writing these primitives by hand would be strictly more dangerous.
  - **Better than alternatives:** **Solmate/solady** are gas-optimized but less defensively
    documented and higher-footgun; for a security-first build OZ is the right default.
  - **7-day:** 5.1.0 has been out for months. Passes. (Solidity `^0.8.20` required — fine.)

  ### solidity-coverage `0.8.14`
  - **Why chosen:** measures test coverage of Solidity — needed to prove the test suite is thorough.
  - **Why secure:** long-standing Hardhat-ecosystem tool; **dev-only**, never in the deployed artifact.
  - **Better than alternatives:** the de-facto standard; Foundry's built-in coverage isn't available
    without Foundry.
  - **7-day:** 0.8.x is years-stable. Passes.

  ### dotenv `16.4.7`
  - **Why chosen:** load the deployer key / RPC URLs from `.env` instead of hardcoding secrets.
  - **Why secure:** tiny, no network access, no transitive deps; reads a local file only.
  - **Better than alternatives:** rolling your own `.env` parser is needless risk; dotenv is the standard.
  - **7-day:** 16.4.x is many months old. Passes.

  ### typescript `5.7.2`
  - **Why chosen:** typed deploy scripts and tests catch errors before they hit a live network.
  - **Why secure:** Microsoft-maintained, ubiquitous, dev-only.
  - **Better than alternatives:** plain JS loses the safety that matters most when moving real value.
  - **7-day:** 5.7.x is months old. Passes.

  ## Frontend workspace

  Runtime: `next` 14.2.35 · `react` / `react-dom` 18.3.1 · `wagmi` 2.12.17 · `viem` 2.21.37 ·
  `@rainbow-me/rainbowkit` 2.1.7 · `@tanstack/react-query` 5.59.16.
  Dev: `typescript` 5.7.2 · `tailwindcss` 3.4.14 · `postcss` 8.4.47 · `autoprefixer` 10.4.20 ·
  `@types/*`.

  > `next` was 14.2.15 in an earlier revision of this document while `package.json` already
  > pinned **14.2.35**. The upgrade (critical middleware authorization bypass, `<14.2.25`) was
  > made and recorded in TODO.md but this line was not updated — a stale version number on the
  > page that exists to be the source of truth about dependency security. Corrected above.

  - **wagmi + viem over ethers-in-React:** type-safe hooks; viem models a custom chain (Arc
    5042002, 6-decimal native) cleanly and has a smaller, modern, well-audited core. viem's
    `parseAbi`/`parseAbiItem` give compile-time-checked ABIs, which caught real arg-shape
    mistakes while building the price-history replay.
  - **RainbowKit over a hand-rolled connector UI:** wallet connection is high-risk,
    high-detail surface (deep links, mobile, chain switching). Reimplementing it would be
    strictly more dangerous than using the maintained standard.
  - **Tailwind over a component library (MUI/Chakra/shadcn):** zero runtime JS, no component
    API to keep in sync, and it ships only the classes actually used. A component library
    would add a large runtime dependency for widgets this app mostly doesn't need.
  - **7-day:** every version above is many months old. Passes with margin.

  ### Removed: `zod` 3.23.8
  Previously listed as planned for "runtime validation of on-chain strings." It was installed
  but **never imported anywhere in the app**. Validation is instead done by narrow,
  purpose-built, dependency-free functions in `lib/sanitize.ts` (`sanitizeText`, `safeAddress`)
  and `lib/format.ts` (`parseUsdc`), which are directly auditable and total (never throw).
  Removed rather than left installed, per the project's no-unnecessary-dependencies rule.

  **Update (2026-09-01): `zod` is back in the lockfile — transitively, at `4.1.11`.** It arrives
  as a dependency of `@vercel/functions` 3.9.5 (see that entry below). It is **not** a direct
  dependency, appears in **no `package.json` of ours**, and is **never imported by our code** —
  validation is still the dependency-free functions named above. So this is not a reversal of
  the decision to stop using zod directly, but it is recorded here because this document must
  not contain a statement that `package-lock.json` contradicts.

  ### Deliberately NOT added

  These were considered while building the UI and rejected in favour of ~50–150 lines of
  local, auditable code. Each would have been a new supply-chain entry for a small win:

  | Candidate | Would have been used for | Why rejected |
  |---|---|---|
  | `recharts` / `chart.js` / `visx` / `d3` | the probability chart | The chart needs one step-interpolated line, an area fill, and a hover crosshair. That's ~60 lines of SVG path math in `components/PriceChart.tsx`. `recharts` alone pulls in much of `d3`. |
  | `date-fns` / `dayjs` | resolution dates + countdowns | `Intl.DateTimeFormat` (built in) covers formatting; countdowns are bigint subtraction. See `lib/time.ts`. |
  | `clsx` / `classnames` | conditional class names | Template literals and ternaries are sufficient at this size. |
  | `next-themes` | dark mode | ~25 lines: one inline pre-paint script in `app/layout.tsx` plus a toggle in `Header.tsx`. |
  | `embla-carousel` / `swiper` | featured slider | Native CSS scroll-snap does this with better a11y and touch behaviour for free. See `components/FeaturedSlider.tsx`. |
  | `@tanstack/react-virtual` | long market lists | Not yet needed at realistic market counts. Revisit only if a deployment exceeds a few hundred markets. |
  | a database / ORM (`prisma`, `drizzle`) + a blob host | market descriptions and images | Considered when descriptions, image storage and chart snapshots were all specified as needing shared storage. Rejected once images became **URLs** rather than uploaded bytes: a URL and a description are both short strings, so a small owner-gated on-chain registry (`MarketMetadata.sol`) stores them with **no backend, no new dependency, and no new host to trust or keep up**. It also avoids the fact that the Vercel target has no persistent disk. |
  | `node:sqlite` + Next API routes | the same | Zero-dependency (built into Node 22+), but requires a long-lived server with a real filesystem. The deploy target is Vercel serverless, where `/tmp` is ephemeral, so this would have quietly lost data. |

  ### Added in the descriptions/images/faucet change: **nothing**

  That change added market descriptions, external image URLs, an on-chain metadata
  registry, a public faucet button and a rewritten chart accuracy model. It introduced
  **zero new npm packages** — validation reuses `lib/sanitize.ts` and `lib/links.ts`
  (`safeExternalUrl` already enforced an https-only allowlist), the chart remains
  hand-rolled SVG, and storage is on-chain. The 7-day release-age floor is therefore
  satisfied vacuously for this change.

  ### Added in the profiles/comments/leaderboard change: **nothing**

  That change added quick-trade YES/NO buttons on cards, in-page multi-outcome switching,
  a potential-profit readout, on-chain usernames and comments (`contracts/src/Social.sol`),
  per-wallet profiles with trade history and PnL, and a leaderboard. It introduced
  **zero new npm packages**, so the 7-day release-age floor is again satisfied vacuously
  and the attack surface is unchanged.

  What each temptation was replaced with:

  | Candidate | Would have been used for | Why rejected |
  |---|---|---|
  | `date-fns` / `dayjs` / `timeago.js` | "5m ago" on comments | `Intl.RelativeTimeFormat` is native and locale-aware. See `formatRelativeTime` in `lib/time.ts`. |
  | `decimal.js` / `big.js` / `bn.js` | PnL arithmetic | Native `bigint` is exact for 6-decimal integer USDC and is already the convention everywhere else. A decimal library would have introduced a second numeric model alongside it — see the arithmetic rules at the top of `lib/ledger.ts`. |
  | a subgraph / indexer (The Graph, Ponder) | trade history + leaderboard | Would be the "right" answer at scale, but it is an external service to run and trust. `getLogs` accepts an address ARRAY and an events ARRAY, so one bounded sweep covers every market and both event types in ~6 requests regardless of market count. See `hooks/useTradeLedger.ts`. |
  | a database / backend for comments | comments, usernames | Same rejection as the metadata registry above: Vercel serverless has no persistent disk. Both now live on-chain in `Social.sol`, which also makes them genuinely shared between visitors rather than per-browser. |

  **Audit note.** Because no package was added, removed or upgraded, `npm audit`'s result
  is unchanged from the previous entry — no new advisories were introduced by this change.

  ### Added in the chart-indexer change: `pg`, `@vercel/functions`, `@types/pg`

  This change adds a server-side blockchain indexer, a Postgres trade index and a chart API.
  It is the **first change to add a runtime dependency to the frontend since the initial
  build**, and it deliberately reverses two "Deliberately NOT added" rows above
  (`a database / ORM` and `a subgraph / indexer`). The reversal is recorded rather than
  quietly overwritten, because the reason those rows existed is still half-true.

  **What changed since that rejection.** The rejection rested on "Vercel serverless has no
  persistent disk," which argues against a database *on the deploy target*. It does not argue
  against a **managed Postgres reached over the network**, which is what this uses. The
  pressure that forced the change is in CLAUDE.md: Arc testnet's head is 1.7M blocks past the
  factory's deploy block, `eth_getLogs` refuses ranges at 1,048,576 blocks, and the public RPC
  rate-limits hard — so a browser-side sweep can only ever be a *growing window* over the
  history, never the whole of it. Indexing once on the server and serving the result is the
  fix. The ORM half of the rejection still stands: no Prisma, no Drizzle.

  ### pg `8.23.0`
  - **Why chosen:** the reference Postgres client for Node. Plain SQL, no schema DSL, no
    codegen step, no build-time coupling — the migration is a `.sql`-shaped string and the
    queries are parameterized text, which is directly auditable in review.
  - **Why secure:** maintained since 2010 with an enormous user base; pure JavaScript with no
    native addon to compile or trust (`pg-native` is optional and NOT installed). It supports
    `$1`-style **parameterized queries**, which is how this project satisfies its own
    "parameterized queries by default" rule — no string-concatenated SQL anywhere.
    `npm audit` reports **no advisory against `pg` or any of its transitive packages**; all 25
    pre-existing advisories in this repo belong to the hardhat/walletconnect trees, and the
    count is identical before and after this install.
  - **Better than alternatives:** **`postgres` (porsager)** is smaller and faster but its
    tagged-template API makes it visually hard to tell a parameterized query from an
    interpolated one during review — the wrong tradeoff for a repo whose standing rules are
    about auditability. **`prisma`/`drizzle`** add a schema language, a generate step and a
    much larger install for a schema of three tables. **`@vercel/postgres`** wraps `pg` but
    binds the code to one host; `pg` keeps the provider swappable.
  - **7-day:** published **2026-08-08**, verified with `npm view pg time --json` — 24 days old
    as of 2026-09-01. Passes.

  ### @vercel/functions `3.9.5`
  - **Why chosen:** provides `waitUntil()`, the only supported way to let a serverless response
    return while indexing work continues. Without it the choice is to hold a visitor's request
    open for the whole sweep or to have the runtime kill the work mid-write.
  - **Why secure:** **the surface is not small, and an earlier version of this entry claimed it
    was.** Installing it added **24 lockfile entries — itself plus 23 transitive packages**:
    `@vercel/cli-config@0.2.4`, `@vercel/cli-exec@1.0.1`, `@vercel/oidc@3.8.5`,
    `cross-spawn@7.0.6`, `execa@5.1.1`, `get-stream@6.0.1`, `human-signals@2.1.0`,
    `jose@5.10.0`, `merge-stream@2.0.0`, `mimic-fn@2.1.0`, `npm-run-path@4.0.1`, `obuf@1.1.2`,
    `onetime@5.1.2`, `os-paths@4.4.0`, `path-key@3.1.1`, `shebang-command@2.0.0`,
    `shebang-regex@3.0.0`, `signal-exit@3.0.7`, `strip-final-newline@2.0.0`, `which@2.0.2`,
    `xdg-app-paths@5.5.1`, `xdg-portable@7.3.0`, `zod@4.1.11`. Stated plainly: this puts a
    **subprocess-spawning toolchain** (`execa` + `cross-spawn` + `shebang-command`/
    `shebang-regex` + `which`) and a **full JWT/JOSE implementation** (`jose`) into production
    `dependencies` — not devDependencies — for the sake of one function call. By contrast the
    `pg` install added 21 entries, all of them recognizably the Postgres driver's own family.
    The counterweight, and the reason it stays: it is **first-party Vercel for the actual
    deploy target**, so it is versioned against the runtime rather than guessing at it;
    `waitUntil()` has **no zero-dependency equivalent on this Next version** (`after()` from
    `next/server` needs 15.1+, and `next` is pinned at 14.2.35); and the exposure is confined
    to a **single module**, `lib/indexer/background.ts` (added in a later task), which imports
    it and nothing else does — so the entire dependency can be removed by replacing one file.
    `npm audit` reports no advisory against it or any of those 23 packages, and the repo's
    advisory count is identical before and after the install.
  - **Better than alternatives:** a bare floating promise is exactly what `waitUntil` exists to
    replace — the sandbox may freeze immediately after the response, truncating the write. A
    long-lived worker (BullMQ, a container) means another service and another host to trust.
  - **7-day:** published **2026-08-20**, verified with `npm view @vercel/functions time --json`
    — 12 days old as of 2026-09-01. Passes.

  ### @types/pg `8.11.10` (devDependency)
  - **Why chosen:** `pg` ships no bundled types, and `frontend/tsconfig.json` is `strict: true`,
    so untyped query results would be `any` at exactly the boundary where numeric precision
    matters (Postgres `numeric`/`bigint` arrive as strings).
  - **Why secure:** DefinitelyTyped; types are erased at compile time and ship no runtime code,
    so it cannot execute anything in production.
  - **Better than alternatives:** hand-written ambient declarations would drift from `pg`.
  - **7-day:** published **2024-09-13** — about two years old. Passes with margin.
    Pinned at 8.11.10 rather than the current 8.23.1 because `@types/*` versions track the
    library's API surface, not its version number, and 8.11.10 already covers everything used
    here; the newer types are not required and are the less-proven pin.

  **Not added, despite the new backend:** no ORM, no query builder, no migration framework
  (`db/migrate.ts` is a plain script over `pg`), no validation library (the route handlers
  reuse the existing dependency-free validators), and no separate cron service (Vercel Cron is
  configuration, not a package). The `db:migrate` script runs through `npx tsx`, which is
  fetched on demand rather than installed, so it adds nothing to the dependency tree.

  ### Reversal: the "no database / no indexer" entry above is now superseded

  Two rows in **Deliberately NOT added** argued against exactly what this change
  builds: `a database / ORM (prisma, drizzle) + a blob host`, and
  `a subgraph / indexer (The Graph, Ponder)`. They are reversed here explicitly
  rather than left to be quietly contradicted by the code, because one half of each
  rejection is still correct and the half that was wrong is worth stating precisely.

  **What was wrong: the premise, not the reasoning.** The indexer row rejected an
  external service on the grounds that `getLogs` was cheap enough not to need one —
  "one bounded sweep covers every market and both event types in ~6 requests
  regardless of market count". That is **true of the request COUNT and false of the
  OUTCOME.** Six requests is what one sweep costs; it is not what covering the
  history costs. The sweep is bounded by a **40-request-per-load budget across a
  1.7M-block window** — Arc testnet's head is that far past the factory's deploy
  block — and a rate-limited public node halves the usable width whenever it
  refuses a range. So the sweep is a *growing window* over the history rather than
  the whole of it: it never reports `complete` on a cold load, which is exactly why
  `lib/logCache.ts` has to exist at all, carrying partial depth between visits. The
  arithmetic in that row was sound. Its premise — that request count and coverage
  are the same measurement — was not.

  **What is still true, and now irrelevant: "Vercel serverless has no persistent
  disk."** Both rejected rows leaned on it, and it remains a fact — `/tmp` is
  ephemeral, which is why the `node:sqlite` row above is still correctly rejected
  for that exact reason. It is irrelevant *here* because the persistence is
  **Neon's, not the function's**: the deploy target holds a connection, not a
  database. An argument against a database *on the deploy target* was never an
  argument against a managed Postgres reached over the network, and reading it as
  one is what delayed this change.

  **What is NOT reversed.** No ORM and no query builder: `prisma`/`drizzle` were
  rejected for adding a schema language, a generate step and a large install for a
  schema this small, and that still holds — `db/migrations/001_init.sql` is plain
  SQL and every statement is parameterized text in `lib/db/queries.ts`. No external
  indexing service either: The Graph and Ponder remain services to run and trust,
  while the indexer here is code in this repo (`lib/indexer/**`) reaching the
  database through the one dependency justified above. The on-chain registries
  (`MarketMetadata.sol`, `Social.sol`) stay exactly where they are — nothing about
  descriptions, images, usernames or comments moves into Postgres. `market_events`
  is a projection of chain bytes, not a system of record.

  **The package entries for this change are above** — `pg` 8.23.0,
  `@vercel/functions` 3.9.5 and `@types/pg` 8.11.10, each in the four-point format
  and each verified against the registry. This section adds no package; it records
  a decision being overturned.