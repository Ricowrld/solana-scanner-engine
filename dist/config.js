"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const toNumber = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const toBoolean = (value, fallback) => {
    if (value === undefined) {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no'].includes(normalized)) {
        return false;
    }
    return fallback;
};
const hoursToMs = (hours) => hours * 60 * 60 * 1000;
const thresholds = {
    minPriceChange1mPercent: toNumber(process.env.MIN_PRICE_CHANGE_1M, 3),
    minPriceChange5mPercent: toNumber(process.env.MIN_PRICE_CHANGE_5M, 5),
    minPriceChange1hPercent: toNumber(process.env.MIN_PRICE_CHANGE_1H, 15)
};
const parseList = (value, delimiter = ',') => {
    if (!value) {
        return [];
    }
    return value
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
};
const discoveryFilters = {
    minLiquidityUsd: toNumber(process.env.MIN_LIQUIDITY, 100_000),
    minVolume1hUsd: toNumber(process.env.MIN_VOLUME_1H, 250_000),
    minMarketCapUsd: toNumber(process.env.MIN_FDV, 250_000),
    minAgeMinutes: toNumber(process.env.MIN_TOKEN_AGE_MINUTES, 60),
    minHolderCount: toNumber(process.env.MIN_HOLDER_COUNT, 200),
    minPriceChange5mPercent: toNumber(process.env.MIN_PRICE_CHANGE_5M_DISCOVERY, 8),
    maxCreatorHoldPercent: toNumber(process.env.MAX_CREATOR_HOLD_PERCENT, 10),
    maxTopHolderPercent: toNumber(process.env.MAX_TOP_HOLDER_PERCENT, 15),
    requireMintAuthorityDisabled: toBoolean(process.env.REQUIRE_MINT_AUTHORITY_DISABLED, true),
    requireFreezeAuthorityDisabled: toBoolean(process.env.REQUIRE_FREEZE_AUTHORITY_DISABLED, true),
    requireLiquidityLockOrBurn: toBoolean(process.env.REQUIRE_LP_LOCK_OR_BURN, true),
    allowMissingSecurityData: toBoolean(process.env.ALLOW_MISSING_SECURITY_DATA, false)
};
const discoveryConfig = {
    enabled: toBoolean(process.env.DISCOVERY_ENABLED, true),
    includeWatchlist: toBoolean(process.env.DISCOVERY_INCLUDE_WATCHLIST, true),
    birdeye: {
        enabled: toBoolean(process.env.BIRDEYE_ENABLED, true),
        apiKey: process.env.BIRDEYE_API_KEY,
        trendingLimit: toNumber(process.env.BIRDEYE_TRENDING_LIMIT, 100),
        cacheTtlMs: toNumber(process.env.BIRDEYE_CACHE_TTL_MS, 60_000),
        minIntervalMs: toNumber(process.env.BIRDEYE_MIN_INTERVAL_MS, 15_000)
    },
    dexscreener: {
        enabled: toBoolean(process.env.DEXSCREENER_ENABLED, true),
        trendingUrl: process.env.DEXSCREENER_TRENDING_URL ?? 'https://api.dexscreener.com/latest/dex/trending',
        boostedUrl: process.env.DEXSCREENER_BOOSTED_URL ??
            'https://api.dexscreener.com/latest/dex/trending/boosted',
        trendingLimit: toNumber(process.env.DEXSCREENER_TRENDING_LIMIT, 50),
        boostedLimit: toNumber(process.env.DEXSCREENER_BOOSTED_LIMIT, 50),
        cacheTtlMs: toNumber(process.env.DEXSCREENER_CACHE_TTL_MS, 60_000),
        minIntervalMs: toNumber(process.env.DEXSCREENER_MIN_INTERVAL_MS, 10_000)
    },
    jupiterStrictList: parseList(process.env.JUPITER_STRICT_LIST),
    filters: discoveryFilters,
    rejectionChannelId: process.env.DISCOVERY_REJECTION_CHANNEL_ID,
    rejectionLogSampleSize: toNumber(process.env.DISCOVERY_REJECTION_SAMPLE_SIZE, 5)
};
const paperTradingConfig = {
    enabled: toBoolean(process.env.PAPER_TRADING_ENABLED, true),
    startingBalanceUsd: toNumber(process.env.PAPER_TRADING_START_BALANCE, 25_000),
    stateFile: process.env.PAPER_TRADING_STATE_FILE ?? 'data/paper-trading.json',
    maxOpenPositions: toNumber(process.env.PAPER_TRADING_MAX_POSITIONS, 5),
    takeProfitPercent: toNumber(process.env.PAPER_TRADING_TAKE_PROFIT, 20),
    stopLossPercent: toNumber(process.env.PAPER_TRADING_STOP_LOSS, -8),
    trailingStopPercent: toNumber(process.env.PAPER_TRADING_TRAILING_STOP, 10),
    maxHoldMinutes: toNumber(process.env.PAPER_TRADING_MAX_HOLD_MINUTES, 240),
    positionFractionOfBalance: toNumber(process.env.PAPER_TRADING_POSITION_FRACTION, 0.1),
    maxPositionUsd: toNumber(process.env.PAPER_TRADING_MAX_POSITION_USD, 5_000),
    minPositionUsd: toNumber(process.env.PAPER_TRADING_MIN_POSITION_USD, 500),
    historyLimit: toNumber(process.env.PAPER_TRADING_HISTORY_LIMIT, 200),
    summaryChannelId: process.env.PAPER_TRADING_SUMMARY_CHANNEL_ID,
    summaryIntervalMinutes: toNumber(process.env.PAPER_TRADING_SUMMARY_INTERVAL_MINUTES, 240),
    summaryMinEquityChangeUsd: toNumber(process.env.PAPER_TRADING_SUMMARY_MIN_EQUITY_CHANGE_USD, 50)
};
const config = {
    botToken: process.env.BOT_TOKEN ?? '',
    channelId: process.env.CHANNEL_ID ?? '',
    scanIntervalMs: toNumber(process.env.SCAN_INTERVAL, 60) * 1000,
    cooldownMs: hoursToMs(toNumber(process.env.COOLDOWN_HOURS, 6)),
    thresholds,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    cacheFile: process.env.CACHE_FILE ?? 'data/alert-cache.json',
    trendCacheFile: process.env.TREND_CACHE_FILE ?? 'data/trend-cache.json',
    // NEW
    rpcUrl: process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    walletPath: process.env.WALLET_PATH ?? 'bot-wallet.json',
    tradingEnabled: process.env.TRADING_ENABLED === 'true',
    discovery: discoveryConfig,
    paperTrading: paperTradingConfig,
    jupiter: {
        enabled: toBoolean(process.env.JUPITER_ENABLED, true),
        apiKey: process.env.JUPITER_API_KEY,
        tokenListUrl: process.env.JUPITER_TOKEN_LIST_URL ??
            'https://cache.jup.ag/tokens',
        inputMint: process.env.JUPITER_INPUT_MINT ??
            'So11111111111111111111111111111111111111112',
        inputAmount: process.env.JUPITER_INPUT_AMOUNT ?? '1000000',
        slippageBps: toNumber(process.env.JUPITER_SLIPPAGE_BPS, 50),
        maxPriceImpactPct: toNumber(process.env.JUPITER_MAX_PRICE_IMPACT_PCT, 5),
        maxRequestsPerSecond: toNumber(process.env.JUPITER_MAX_REQUESTS_PER_SECOND, 5),
        batchSize: toNumber(process.env.JUPITER_BATCH_SIZE, 25),
        onlyDirectRoutes: toBoolean(process.env.JUPITER_ONLY_DIRECT_ROUTES, false),
        excludeDexes: process.env.JUPITER_EXCLUDE_DEXES
            ? process.env.JUPITER_EXCLUDE_DEXES
                .split(',')
                .map((dex) => dex.trim())
                .filter(Boolean)
            : [],
        includeDexes: process.env.JUPITER_INCLUDE_DEXES
            ? process.env.JUPITER_INCLUDE_DEXES
                .split(',')
                .map((dex) => dex.trim())
                .filter(Boolean)
            : [],
        tokenListCacheFile: process.env.JUPITER_TOKEN_LIST_CACHE ??
            'data/jupiter-tokens.json',
        tokenListTtlMs: toNumber(process.env.JUPITER_TOKEN_LIST_TTL_MS, 60 * 60 * 1000),
        watchlistFile: process.env.WATCHLIST_FILE ??
            'config/watchlist.json',
        failureCacheFile: process.env.JUPITER_FAILURE_CACHE ??
            'data/jupiter-failures.json',
        failureTtlMs: toNumber(process.env.JUPITER_FAILURE_TTL_MS, 30 * 60 * 1000),
        dnsFallbackHost: process.env.JUPITER_DNS_FALLBACK_HOST ??
            'jup.ag',
        dnsFallbackIp: process.env.JUPITER_DNS_FALLBACK_IP
    }
};
exports.default = config;
