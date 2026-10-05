# 0xOutcome On-Chain Prediction Market

**0xOutcome** is a fully on-chain, Polymarket-style prediction market built on **Circle's Arc**.

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
💰 **Liquidity**

**Markets use a Fixed Product Market Maker (FPMM).**

Liquidity providers supply the underlying outcome tokens to the market pool.

The AMM follows a constant-product model:

x × y = k

Trading fees accrue to liquidity providers.

The contracts also protect important invariants such as:

No free-money trades
No reserve draining
Conservation during split/merge
Correct rounding
Correct fee accounting

📈 **Real-Time Market Charts**

Markets include price/probability charts to visualize how the market moved over time.

The chart system is designed to support fast historical data retrieval through a database-backed indexing layer rather than repeatedly scanning the blockchain from the frontend.

**Architecture:**
```
Arc Blockchain
      ↓
Indexer
      ↓
Database
      ↓
Chart API
      ↓
Next.js Frontend
```
This significantly reduces RPC work and improves chart loading performance.


🏗️ **Architecture**
```
                    ┌─────────────────────┐
                    │      Next.js UI     │
                    │                     │
                    │ Markets             │
                    │ Trading             │
                    │ Portfolio           │
                    │ Profiles            │
                    │ Leaderboard         │
                    │ Admin               │
                    └──────────┬──────────┘
                               │
                     wagmi / viem
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Arc / Base L1     │
                    │                     │
                    │ MarketFactory       │
                    │ ConditionalTokens   │
                    │ FPMM                │
                    │ MarketMetadata      │
                    │ Social              │
                    │ USDC                │
                    └─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Indexer / DB      │
                    │                     │
                    │ Trades              │
                    │ Price history       │
                    │ Market activity     │
                    └─────────────────────┘
```
🔐 **Smart Contracts**

The core contracts include:

**ConditionalTokens**

ERC-1155 based outcome shares.

Supports:

Split collateral into YES/NO
Merge YES/NO back into collateral
Redeem winning positions

Example:

100 USDC
   ↓
100 YES + 100 NO

**FixedProductMarketMaker**

Constant-product AMM used for market trading.

**MarketFactory**

Responsible for:

Market creation
Condition preparation
FPMM deployment
Market resolution
Resolver permissions
Resolution timing

**MarketMetadata**

Stores market:

Description
Image URL
Metadata

Metadata updates are owner-gated.

**Social**

Handles:

Usernames
Comments
User activity


📁 **Repository Structure**
```
0xoutcome/
│
├── contracts/
│   ├── src/
│   │   ├── ConditionalTokens.sol
│   │   ├── FixedProductMarketMaker.sol
│   │   ├── MarketFactory.sol
│   │   ├── MarketMetadata.sol
│   │   ├── MockUSDC.sol
│   │   └── Social.sol
│   │
│   ├── test/
│   └── scripts/
│
├── frontend/
│   ├── app/
│   │   ├── markets
│   │   ├── portfolio
│   │   ├── profile
│   │   └── admin
│   │
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   └── db/
│
├── docs/
│
└── README.md
```
## License

MIT — see LICENSE file.

Built by Fabio.
