# 0xOutcome

**0xOutcome** is a fully on-chain, Polymarket-style prediction market built on **Circle's Arc **.

Trade YES/NO outcomes, provide liquidity, follow market probabilities, and redeem winning positions all settled on-chain with USDC.

## ✨ Features

* 📊 Binary YES/NO prediction markets
* 🔄 Buy & sell positions
* 💰 USDC trading & liquidity
* 🏆 Portfolio, PnL & leaderboard
* 👤 User profiles & trading activity
* 💬 On-chain comments
* 📈 Real-time & historical market charts
* 🧩 Multi-outcome events (2–12 outcomes)
* 🖼️ Market descriptions & images
* 🛠️ Admin dashboard for creating, editing, resolving and managing markets
* 🔐 On-chain resolution & winning-share redemption
* 🌐 Arc Testnet 

## 🏗️ Tech Stack

**Smart Contracts**

* Solidity 0.8.20
* Hardhat
* ERC-1155
* Fixed Product Market Maker
* USDC

**Frontend**

* Next.js 14
* TypeScript
* wagmi / viem
* RainbowKit

**Data**

* PostgreSQL / Neon
* Blockchain event indexing

## 🚀 Run Locally

```bash
npm install
npm run node
npm run deploy:local
npm run dev
```

Open `http://localhost:3000`.

Run tests:

```bash
npm test
```

## 🌐 Network

| Network      | Status       |
| ------------ | ------------ |
| Arc Testnet  | ✅ Live       |
| Arc Mainnet  | 🚧 Ready     |

## 🔄 How It Works

```text
Create Market
     ↓
Add Liquidity
     ↓
Buy / Sell
     ↓
Resolve
     ↓
Redeem Winning Shares
```


## Repo Structure

```
arc-prediction-market/
├── contracts/           # Solidity + Hardhat
│   ├── src/             # 6 contracts
│   ├── test/            # 19 tests
│   └── scripts/         # deploy.ts, e2e-local.ts
├── frontend/            # Next.js app
│   ├── app/             # pages (list, market detail, portfolio, admin)
│   ├── components/      # Header, Footer, MarketCard, FeaturedSlider,
│   │                    #   TradePanel, LiquidityForm, MarketImageUpload, ui
│   ├── hooks/           # useMarkets, useMarket, useMarketImage, useHiddenMarkets
│   ├── lib/             # chains, format (6-decimal USDC), sanitize, ABIs,
│   │                    #   links, marketImages, hiddenMarkets
│   ├── db/              # Database added to increase chart data loading speed
└── README.md            # This file
```

## License

MIT — see LICENSE file.

Built by Fabio.
