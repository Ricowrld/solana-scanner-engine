<<<<<<< HEAD
# Solana Market Intelligence Platform

A TypeScript-based Discord bot that continuously scans the Solana blockchain for emerging token opportunities, evaluates them against configurable on-chain and market filters, and delivers real-time alerts to a Discord channel. Includes a full paper trading engine for risk-free strategy backtesting.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![Node.js](https://img.shields.io/badge/Node.js-20-339933)
![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2)
![License](https://img.shields.io/badge/License-MIT-yellow)

=======
# Solana Token Scanner Bot

A TypeScript-based Discord bot that continuously scans the Solana blockchain for emerging token opportunities, evaluates them against configurable on-chain and market filters, and delivers real-time alerts to a Discord channel. Includes a full paper trading engine for risk-free strategy backtesting.

>>>>>>> ee62131dcff53f9d0d0ceff4643c15f6c0970709
---

## Features

- **Multi-source token discovery** — aggregates trending tokens from Birdeye, DexScreener (trending + boosted), Jupiter strict token list, and a custom watchlist
- **Scored filtering pipeline** — each candidate is evaluated across 17+ metrics and assigned a discovery score; only tokens meeting the minimum threshold are surfaced
- **Momentum-based alerting** — tracks price change over 1m, 5m, and 1h intervals with configurable thresholds and per-token alert cooldowns
- **Paper trading engine** — simulates portfolio management with take-profit, stop-loss, trailing stop, and max hold time; persists state between runs
- **Discord integration** — rich embeds for token alerts, paper trading summaries, and discovery rejection logs with filter diagnostics
- **Jupiter swap execution** — real trade execution via the Jupiter v6 API with configurable slippage, price impact limits, and DEX routing
- **Fully configurable** — all thresholds, intervals, and feature flags are controlled via environment variables; no code changes required

---

## Architecture
<<<<<<< HEAD
index.ts → Main scan loop: orchestrates discovery, scanning, paper trading, and Discord alerts
discovery.ts → Fetches and scores discovery candidates from Birdeye and DexScreener
scanner.ts → Evaluates token candidates using Jupiter price quotes and momentum filters
filters.ts → Applies price-change threshold rules to scanner results
paperTrading.ts → Stateful paper trading engine (entry, exit, PnL tracking, position sizing)
discord.ts → Formats and dispatches Discord embeds (alerts, rejections, summaries)
jupiter.ts → Fetches Jupiter quotes; handles rate limiting, failure caching, and retries
jupiterTokens.ts → Loads and caches the Jupiter token list; resolves watchlist mints
trade.ts → Executes real on-chain swaps via Jupiter v6 + Solana web3.js
config.ts → Centralised configuration loaded from environment variables
types.ts → Shared TypeScript interfaces for all modules
storage.ts → JSON-based persistence for alert cache, paper trading state, and trend history
trends.ts → Tracks historical price quote points per token for momentum calculation
logger.ts → Structured logger (pino)
network.ts → Shared HTTPS agent configuration
wallet.ts → Loads Solana wallet keypair from file


text
=======

```
index.ts          → Main scan loop: orchestrates discovery, scanning, paper trading, and Discord alerts
discovery.ts      → Fetches and scores discovery candidates from Birdeye and DexScreener
scanner.ts        → Evaluates token candidates using Jupiter price quotes and momentum filters
filters.ts        → Applies price-change threshold rules to scanner results
paperTrading.ts   → Stateful paper trading engine (entry, exit, PnL tracking, position sizing)
discord.ts        → Formats and dispatches Discord embeds (alerts, rejections, summaries)
jupiter.ts        → Fetches Jupiter quotes; handles rate limiting, failure caching, and retries
jupiterTokens.ts  → Loads and caches the Jupiter token list; resolves watchlist mints
trade.ts          → Executes real on-chain swaps via Jupiter v6 + Solana web3.js
config.ts         → Centralised configuration loaded from environment variables
types.ts          → Shared TypeScript interfaces for all modules
storage.ts        → JSON-based persistence for alert cache, paper trading state, and trend history
trends.ts         → Tracks historical price quote points per token for momentum calculation
logger.ts         → Structured logger (pino)
network.ts        → Shared HTTPS agent configuration
wallet.ts         → Loads Solana wallet keypair from file
```
>>>>>>> ee62131dcff53f9d0d0ceff4643c15f6c0970709

---

## Discovery Pipeline

Tokens flow through the following stages on each scan cycle:

1. **Seed collection** — pulls trending/boosted tokens from Birdeye and DexScreener, deduplicates by mint address
2. **Detail enrichment** — fetches token overview and security data from Birdeye, and pair data from DexScreener concurrently (3 parallel workers)
3. **Filter evaluation** — each token is checked against all configured thresholds; each passing check contributes to a composite discovery score
4. **Ranking** — candidates are sorted by discovery score, then by liquidity and 1h volume; the top N proceed to the scanner
5. **Quote evaluation** — the scanner fetches a Jupiter swap quote per candidate to get a real estimated price and route
6. **Alert dispatch** — tokens that pass momentum and cooldown checks trigger Discord embeds and optional paper trade entries

### Discovery Filter Criteria

| Metric | Default | Description |
|---|---|---|
| Min Liquidity | $150,000 | Pool liquidity in USD |
| Min 1h Volume | $300,000 | Trading volume in the past hour |
| Min Market Cap (FDV) | $250,000 | Fully diluted valuation |
| Token Age | 60–360 min | Window of accepted token age |
| Min Holder Count | 200 | Unique wallet holders |
| Buy/Sell Ratio (5m) | ≥ 1.1 | Buying pressure indicator |
| Vol/Liquidity Ratio | 0.5–8.0 | Filters wash trading and illiquid tokens |
| FDV/Liquidity Ratio | ≤ 30 | Overvalued token check |
| Creator Hold % | ≤ 10% | Rug pull risk indicator |
| Top 10 Holder % | ≤ 50% | Concentration risk |
| Mint Authority | Disabled | Required by default |
| Freeze Authority | Disabled | Required by default |
| LP Lock/Burn | Required | Liquidity safety check |
| Honeypot flag | Must be false | Birdeye security flag |
| Min Discovery Score | 60 | Composite score gate |

---

## Paper Trading Engine

The paper trading engine simulates portfolio behaviour without executing real trades.

- **Position sizing** — positions are a configurable fraction of the current balance, clamped between a minimum and maximum USD value
- **Exit triggers**
  - Take profit (default: +20%)
  - Stop loss (default: −8%)
  - Trailing stop from peak (default: 10% drawdown)
  - Maximum hold time (default: 240 minutes)
- **PnL tracking** — realised/unrealised PnL, win rate, and average hold time are calculated from trade history
- **State persistence** — position state is written to a JSON file and restored on restart
- **Discord summaries** — periodic embeds include balance, equity, open positions, and a log of recent trade actions; sent when equity change exceeds a configurable threshold

---

## Prerequisites

- Node.js ≥ 18
- A Discord bot token and a target text channel ID
- A Birdeye API key (optional, but recommended for richer data)
- A Solana RPC URL (for live trading only)
- A Jupiter-compatible Solana wallet keypair (for live trading only)

---

## Setup

```bash
# 1. Clone the repository
<<<<<<< HEAD
git clone <repo-url>
cd <repo>
=======
git clone https://github.com/Ricowrld/solana-scanner-engine.git
cd solana-scanner-engine
>>>>>>> ee62131dcff53f9d0d0ceff4643c15f6c0970709

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env

# 4. Fill in required values (see Configuration)
nano .env

# 5. Build and run
npm run build
npm start
```

---

## Configuration

All options are set via environment variables. Defaults are shown in brackets.

### Required

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CHANNEL_ID` | Discord channel ID for token alerts |

### Discovery

| Variable | Default | Description |
|---|---|---|
| `BIRDEYE_API_KEY` | — | Birdeye API key |
| `BIRDEYE_ENABLED` | `true` | Enable Birdeye as a discovery source |
| `DEXSCREENER_ENABLED` | `true` | Enable DexScreener as a discovery source |
| `DISCOVERY_ENABLED` | `true` | Enable the full discovery pipeline |
| `TOP_DISCOVERY_CANDIDATES` | `20` | Maximum tokens to pass to the scanner per cycle |
| `DISCOVERY_REJECTION_CHANNEL_ID` | — | Optional channel for rejection diagnostics |
| `MIN_DISCOVERY_SCORE` | `60` | Minimum composite score to pass discovery |

### Scanner & Alerting

| Variable | Default | Description |
|---|---|---|
| `SCAN_INTERVAL` | `60000` | Milliseconds between scan cycles |
| `COOLDOWN_HOURS` | `6` | Hours before the same token can be alerted again |
| `MIN_PRICE_CHANGE_1M` | `0.3` | Minimum 1-minute price change % to trigger alert |
| `MIN_PRICE_CHANGE_5M` | `1.0` | Minimum 5-minute price change % |
| `MIN_PRICE_CHANGE_1H` | `3.0` | Minimum 1-hour price change % |

### Paper Trading

| Variable | Default | Description |
|---|---|---|
| `PAPER_TRADING_ENABLED` | `true` | Enable the paper trading engine |
| `PAPER_TRADING_START_BALANCE` | `25000` | Starting virtual USD balance |
| `PAPER_TRADING_MAX_POSITIONS` | `5` | Maximum concurrent open positions |
| `PAPER_TRADING_TAKE_PROFIT` | `20` | Take profit threshold (%) |
| `PAPER_TRADING_STOP_LOSS` | `-8` | Stop loss threshold (%) |
| `PAPER_TRADING_TRAILING_STOP` | `10` | Trailing stop drawdown from peak (%) |
| `PAPER_TRADING_MAX_HOLD_MINUTES` | `240` | Maximum position hold time |
| `PAPER_TRADING_POSITION_FRACTION` | `0.1` | Fraction of balance per position |
| `PAPER_TRADING_SUMMARY_CHANNEL_ID` | — | Channel for paper trading summary embeds |

### Live Trading (Advanced)

| Variable | Default | Description |
|---|---|---|
| `TRADING_ENABLED` | `false` | Enable real on-chain swap execution |
| `RPC_URL` | Solana mainnet | Solana JSON-RPC endpoint |
| `WALLET_PATH` | `bot-wallet.json` | Path to wallet keypair JSON file |
| `JUPITER_SLIPPAGE_BPS` | `50` | Slippage tolerance in basis points |
| `JUPITER_MAX_PRICE_IMPACT_PCT` | `5` | Maximum acceptable price impact % |

---

## Disclaimer

This project is for educational and research purposes only. Running automated trading bots carries significant financial risk. The paper trading mode is provided to evaluate strategies without real funds. **Never trade with funds you cannot afford to lose.** This software is provided as-is with no warranty.

---

## License

<<<<<<< HEAD
MIT
=======
MIT
>>>>>>> ee62131dcff53f9d0d0ceff4643c15f6c0970709
