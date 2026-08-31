# Security Model

This document describes the threat model, mitigations, and known limitations of the Arc Prediction Market.

## Scope

- **In scope:** The 4 Solidity contracts, the deploy scripts, and the Next.js frontend's handling of on-chain data.
- **Out of scope:** Wallet security, RPC provider trust, Arc L1 consensus, and the economic soundness of any specific market's resolution source.

## Contract Security

### Access Control
- `MarketFactory` is `Ownable`. Only the owner can `createMarket` and `resolveMarket`.
- `ConditionalTokens` is owned by the `MarketFactory` — only the factory can prepare conditions and report payouts. Users can split/merge/redeem permissionlessly.
- `MockUSDC` mint is owner-gated; the faucet is public with a cooldown (testnet only).

### Resolution Safety
- **Time-gated:** A market cannot resolve before its `resolutionTime`.
- **Resolver-gated:** Only the designated resolver (per market) can report the outcome.
- **One-shot:** A condition can only be resolved once (`payoutDenominator == 0` check). Re-resolution reverts.
- Payout numerators are validated to sum to a positive value.

### AMM Safety (FixedProductMarketMaker)
- **Constant-product invariant:** Buys and sells preserve `x·y ≥ k` (rounding favors the pool via ceilDiv). Tested against a drain attack.
- **Slippage protection:** `buy` takes `minOutcomeTokensToBuy`; `sell` takes `maxOutcomeTokensToSell`. Reverts if the trade crosses the user's limit.
- **Fee bounds:** Fee is capped at 1000 bps (10%) at market creation.
- **Reentrancy:** State changes precede external token transfers; `nonReentrant` guards on buy/sell/add/remove liquidity.
- **No price oracle dependency:** Prices are derived purely from reserves; no external oracle to manipulate.

### Arithmetic
- Solidity 0.8.20 — checked arithmetic by default (overflow/underflow revert).
- 6-decimal USDC handled explicitly; no hardcoded 18-decimal assumptions.

## Supply-Chain Security

### 7-Day Minimum Release Age
Both `.npmrc` files (root + `contracts/`) set `min-release-age=7` — wait, the setting name is enforced by the package manager. **npm does not natively support `min-release-age`**; this policy is enforced as follows:

- The intent: never install a package version published less than 7 days ago, mitigating the window where a freshly-compromised release is live before the community catches it.
- `save-exact=true` pins exact versions (no `^`/`~` ranges), so installs are reproducible and can't silently pull a newer, unvetted patch.
- `ignore-scripts=true` blocks lifecycle scripts (`preinstall`/`postinstall`) from running — the primary vector for supply-chain malware. Two native deps (`keccak`, `secp256k1`) need `node-gyp rebuild`; these are approved explicitly rather than blanket-allowed.
- Before adding any dependency, its publish date is verified on the registry and recorded in `DEPENDENCIES.md`.

> **Note:** If your package manager (e.g. pnpm) supports `minimumReleaseAge`, prefer that for automated enforcement. With npm, the 7-day rule is a documented process backed by exact pinning + script blocking, not a runtime gate.

### Audit
`npm audit` reports 45 vulnerabilities (14 high) — **all in Hardhat's dev-dependency tree** (`glob`, `lodash.isequal`, etc.), not in any runtime or contract dependency. They do not ship to production and do not affect deployed contracts or the frontend bundle. Run `npm audit --production` to confirm the runtime tree is clean.

## Frontend Security

### Output Sanitization
All strings returned from contracts (`question`, `category`, resolver addresses) pass through `lib/sanitize.ts` before rendering:
- Control characters (U+0000–U+001F, U+007F) stripped.
- Length-capped to prevent layout-breaking payloads.
- React escapes by default; we never use `dangerouslySetInnerHTML`.

Addresses are validated and short-formatted; malformed addresses render as a safe placeholder.

### Input Validation
- Numeric inputs (amounts, fees, days) are parsed defensively; NaN/negative values are rejected before building the transaction.
- USDC amounts parsed at exactly 6 decimals via `parseUsdc`; excess precision is truncated, not silently rounded up.

### Error Handling
- Every `writeContract` call has `onError` that surfaces a sanitized message.
- Read failures degrade gracefully (loading/empty states), never crash the page.
- Network mismatch is caught by the `Header` network guard — users on the wrong chain are prompted to switch before they can trade.

### Wallet & Approvals
- Approvals are scoped to the exact FPMM and the exact amount being traded (not `type(uint256).max`), limiting blast radius if a market contract were compromised.

## Deployment Safety

- **Mainnet guard:** Deploying to Arc mainnet requires explicit env vars and is gated behind a separate script target to prevent fat-fingering a testnet command into prod.
- **No secrets in repo:** Private keys come from `.env` (gitignored). `.env.example` documents the shape with placeholders.
- **Deterministic addresses:** Deployment writes to `deployments/index.json` keyed by chainId, so the frontend always targets the correct contracts per network.

## Known Limitations

1. **Resolution is trusted.** The designated resolver reports the outcome. There is no on-chain dispute mechanism or decentralized oracle. For production, integrate a UMA-style optimistic oracle or a multi-sig resolver.
2. **MockUSDC is testnet-only.** On mainnet, the collateral is Arc's native USDC — the deploy script must be pointed at the canonical USDC address, not a mock.
3. **No formal audit.** The contracts are tested (19 tests, constant-product invariants) but have not undergone external audit. Do not deploy to mainnet with real value without one.
4. **LP impermanent loss.** Liquidity providers bear standard AMM IL plus resolution risk. This is inherent to the design, not a bug.
5. **`min-release-age` is process-enforced on npm** (see above), not runtime-gated.

## Reporting

This is a demo project. For a production deployment, set up a responsible-disclosure process and a bug bounty before launch.
