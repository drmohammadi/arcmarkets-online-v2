# Arc Prediction Market

Polymarket-style binary prediction market on Circle's Arc L1 (testnet 5042002, mainnet-ready).

## What This Is

An on-chain prediction market where users trade YES/NO shares on binary outcomes. Market prices reflect collective probability estimates. When a market resolves, winning shares pay 1 USDC each; losing shares pay 0.

Built for **Arc**  Circle's native-USDC stablecoin L1. Gas is paid in 6-decimal USDC, not ETH.

**Current status:** Deployed on Arc testnet. Mainnet-ready pending Circle's mainnet launch.

## Architecture

- **Contracts** (Solidity 0.8.20): `MockUSDC`, `ConditionalTokens` (ERC-1155 outcome shares), `FixedProductMarketMaker` (constant-product AMM), `MarketFactory` (create + resolve), `MarketMetadata` (descriptions + image URLs, additive and owner-gated).
- **Frontend** (Next.js 14 + wagmi + RainbowKit): market list, trade UI, admin panel.


## Install & Run

### Prerequisites
- Node.js ≥20
- A wallet with Arc testnet USDC (get testnet funds at [Arc faucet](https://faucet.testnet.arc.io))

### 1. Install dependencies

```bash
npm install
```

### 2. Deploy contracts (local Hardhat node)

Terminal 1 — start a local Hardhat network:
```bash
npm run node
```

Terminal 2 — deploy the contracts + seed 3 demo markets:
```bash
npm run deploy:local
```

This writes deployment addresses to `frontend/lib/deployments/index.json`.

### 3. Run the frontend

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Connect your wallet (use the local Hardhat network, chain ID 31337). The demo markets are pre-seeded with 1000 USDC liquidity each.

## Deploy to Arc Testnet

1. **Get a deployer private key** with Arc testnet USDC. Fund it at the [Arc faucet](https://faucet.testnet.arc.io).

2. **Create `contracts/.env`** (copy from `.env.example`):
   ```
   DEPLOYER_PRIVATE_KEY=0x...your_key
   ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io
   ```

3. **Deploy**:
   ```bash
   npm run deploy:testnet
   ```

4. **Run the frontend** pointing to testnet. The deployment script already wrote the testnet addresses to `frontend/lib/deployments/index.json`. Just `npm run dev` and connect to Arc testnet (chain ID 5042002) in your wallet.

## Adding the metadata registry to an EXISTING deployment

`MarketMetadata` was added after the testnet factory went live. To attach it without
disturbing anything already deployed:

```bash
npm run deploy:metadata:testnet
```

This deploys **only** `MarketMetadata` and merges its address into the existing chain entry
in `frontend/lib/deployments/index.json`. Every other address is left untouched.

> **Do not run the full `npm run deploy:testnet` against a chain that already has markets.**
> It deploys a *new* `MarketFactory` and repoints the frontend at it, orphaning every
> existing market, pool and open position.

Until the registry is deployed, `/admin` will refuse to create markets — a market created
without it would have no way to store the required description and image. Existing markets
keep working and simply show no description.

## Test the Contracts

All 19 tests must pass before deploying to a live network.

```bash
npm test
```

Coverage:
```bash
npm run coverage
```

Key tests:
- ✅ FPMM constant-product invariant (no free money, no drain)
- ✅ Buy/sell round-trip loses value (fee + spread)
- ✅ Split/merge is lossless (conservation)
- ✅ Resolve → redeem pays winners
- ✅ Time-gated + resolver-gated + one-shot resolution
- ✅ 6-decimal USDC handling

## How It Works

### For Users

1. **Browse markets** at `/`. Probabilities are shown as YES%/NO%.
2. **Trade** by clicking a market. Buy YES if you think the outcome will happen; buy NO if not.
   - Approval flow: first approve USDC, then buy shares.
   - Slippage protection: 1% tolerance (adjustable in code).
3. **Sell** shares anytime before resolution to lock in profit/loss.
4. **Redeem** after resolution: winning shares pay 1 USDC each.

### For Admins (Factory Owner)

Visit `/admin` (owner-gated):
- **Create a single market**: question, **description**, **image URL**, **resolution
  source**, category, resolution date, resolver address, fee (bps).
- **Create a multi-outcome event**: enter an event title and 2–12 outcomes, each with an
  optional image URL of its own. Because the contracts are binary at every layer, each
  outcome is created as its own YES/NO market named `Event: Outcome` and grouped in the UI
  — so this submits **one transaction per outcome**, then **one** `setMetadataBatch`
  transaction carrying all their descriptions and images.
- **Add liquidity** to any unresolved market's pool.
- **Resolve markets**: once past the resolution time, pick YES-wins or NO-wins.
- **Edit details** on any existing market — this is also how you **backfill** markets that
  were created before the metadata registry was deployed.
- **Hide a market** from the browsable list. This is a display filter, not a delete: the
  factory has no delete function, so the market, its pool and all positions stay on-chain
  and holders can still open it by URL to redeem.

> **Images are external https URLs, not uploads.** They are stored on-chain in
> `MarketMetadata` so every visitor sees them, and displayed cropped to a square with
> `object-fit: cover`. The trade-off is inherent to referencing a URL: the viewer's browser
> fetches from that third-party host (disclosing their IP to it), and the host can change or
> remove the image after you approved it. Only the registry owner can set these URLs.

### Getting test USDC

Any visitor can click **Faucet** in the header to claim 1000 test USDC — `MockUSDC.faucet()`
is public and rate-limits itself on-chain to one claim per address per day. Note that Arc's
gas token is *native* USDC, so a brand-new wallet needs the
[Circle faucet](https://faucet.circle.com) first; the in-app faucet supplies the collateral
you trade with, not gas.

### Under the Hood

- **ConditionalTokens**: ERC-1155. Splitting 100 USDC mints 100 YES + 100 NO. Merging burns them back to 100 USDC.
- **FPMM**: Constant-product market maker. Reserves obey x·y = k (Gnosis-style, buy by collateral-in, sell by collateral-out, ceilDiv rounding favors the pool). Fee accrues to LPs as extra outcome tokens.
- **MarketFactory**: Owns ConditionalTokens, prepares conditions, deploys FPMMs, stores metadata, enforces time-gated + resolver-gated resolution.

## Security


- **Sanitization:** All contract-returned strings (questions, categories) are sanitized before render.
- **Slippage:** Buy/sell have minSharesOut/maxSharesIn protection.
- **Mainnet guard:** Mainnet deployment requires three env vars + manual confirmation to prevent accidental prod pushes.
- **No admin keys in production:** The factory owner can create/resolve markets but cannot rug liquidity or steal funds.

## Repo Structure

```
arc-prediction-market/
├── contracts/           # Solidity + Hardhat
│   ├── src/             # 4 contracts
│   ├── test/            # 19 tests
│   └── scripts/         # deploy.ts, e2e-local.ts
├── frontend/            # Next.js app
│   ├── app/             # pages (list, market detail, portfolio, admin)
│   ├── components/      # Header, Footer, MarketCard, FeaturedSlider,
│   │                    #   TradePanel, LiquidityForm, MarketImageUpload, ui
│   ├── hooks/           # useMarkets, useMarket, useMarketImage, useHiddenMarkets
│   └── lib/             # chains, format (6-decimal USDC), sanitize, ABIs,
│                        #   links, marketImages, hiddenMarkets
├── DEPENDENCIES.md      # Why 7-day policy + audit
├── SECURITY.md          # Threat model + mitigations
└── README.md            # This file
```

## License

MIT — see LICENSE file.

Built by Fabio.
