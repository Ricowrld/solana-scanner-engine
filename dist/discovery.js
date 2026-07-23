"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchTrendingTokens = fetchTrendingTokens;
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const network_1 = require("./network");
const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so/defi';
const BIRDEYE_TRENDING_URL = `${BIRDEYE_BASE_URL}/token_trending`;
const BIRDEYE_TOKEN_OVERVIEW_URL = `${BIRDEYE_BASE_URL}/token_overview`;
const BIRDEYE_TOKEN_SECURITY_URL = `${BIRDEYE_BASE_URL}/token_security`;
const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const BIRDEYE_MIN_TRENDING_LIMIT = 1;
const BIRDEYE_PAGE_LIMIT = 20;
const DETAIL_FETCH_CONCURRENCY = 3;
const MS_IN_MINUTE = 60_000;
const toNumber = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
};
const toBoolean = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(normalized)) {
            return true;
        }
        if (['false', 'no', '0'].includes(normalized)) {
            return false;
        }
    }
    return undefined;
};
const coerceTimestampMs = (value) => {
    const numeric = toNumber(value);
    if (!numeric) {
        return undefined;
    }
    if (numeric > 1_000_000_000_000) {
        return numeric;
    }
    if (numeric > 1_000_000_000) {
        return numeric * 1_000;
    }
    return undefined;
};
const computeAgeMinutes = (timestampMs) => {
    if (!timestampMs) {
        return undefined;
    }
    const ageMs = Date.now() - timestampMs;
    if (ageMs <= 0) {
        return undefined;
    }
    return ageMs / MS_IN_MINUTE;
};
const runWithConcurrency = async (items, concurrency, handler) => {
    if (items.length === 0) {
        return [];
    }
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) {
                break;
            }
            try {
                results[index] = await handler(items[index], index);
            }
            catch (error) {
                throw error;
            }
        }
    });
    await Promise.all(workers);
    return results;
};
const createBirdeyeClient = (apiKey) => axios_1.default.create({
    baseURL: BIRDEYE_BASE_URL,
    headers: {
        'x-chain': 'solana',
        'X-API-KEY': apiKey
    },
    httpsAgent: network_1.httpsAgent
});
const fetchBirdeyeTrending = async (client, limit) => {
    const targetLimit = Math.max(BIRDEYE_MIN_TRENDING_LIMIT, Math.trunc(limit));
    const tokens = [];
    const seenMints = new Set();
    for (let offset = 0; tokens.length < targetLimit; offset += BIRDEYE_PAGE_LIMIT) {
        const pageLimit = Math.min(BIRDEYE_PAGE_LIMIT, targetLimit - tokens.length);
        const response = await client.get(BIRDEYE_TRENDING_URL, {
            params: {
                limit: pageLimit,
                offset
            }
        });
        const pageTokens = response.data?.data?.tokens;
        if (!Array.isArray(pageTokens)) {
            logger_1.default.warn({ limit: pageLimit, offset, payload: response.data }, 'Birdeye trending response did not contain token list');
            break;
        }
        if (pageTokens.length === 0) {
            if (offset === 0) {
                logger_1.default.warn({ payload: response.data }, 'Birdeye trending response contained no tokens');
            }
            break;
        }
        for (const token of pageTokens) {
            const mint = token?.address ?? token?.mint ?? token?.tokenAddress;
            if (typeof mint === 'string' && mint.length > 0) {
                if (seenMints.has(mint)) {
                    continue;
                }
                seenMints.add(mint);
            }
            tokens.push(token);
            if (tokens.length >= targetLimit) {
                break;
            }
        }
        if (pageTokens.length < pageLimit) {
            break;
        }
    }
    return tokens;
};
const fetchTokenOverview = async (client, mint) => {
    try {
        const response = await client.get(BIRDEYE_TOKEN_OVERVIEW_URL, {
            params: {
                address: mint
            }
        });
        return (response.data?.data ?? null);
    }
    catch (err) {
        logger_1.default.debug({ err, mint }, 'Failed to fetch Birdeye token overview');
        return null;
    }
};
const fetchTokenSecurity = async (client, mint) => {
    try {
        const response = await client.get(BIRDEYE_TOKEN_SECURITY_URL, {
            params: {
                address: mint
            }
        });
        return (response.data?.data ?? null);
    }
    catch (err) {
        logger_1.default.debug({ err, mint }, 'Failed to fetch Birdeye token security');
        return null;
    }
};
const fetchDexScreenerPair = async (mint) => {
    try {
        const response = await axios_1.default.get(`${DEXSCREENER_TOKEN_URL}/${mint}`);
        const pairs = response.data?.pairs;
        if (!Array.isArray(pairs) || pairs.length === 0) {
            return null;
        }
        const sorted = [...pairs].sort((a, b) => {
            const aLiquidity = toNumber(a?.liquidity?.usd) ?? 0;
            const bLiquidity = toNumber(b?.liquidity?.usd) ?? 0;
            return bLiquidity - aLiquidity;
        });
        return (sorted[0] ?? null);
    }
    catch (err) {
        logger_1.default.debug({ err, mint }, 'Failed to fetch DexScreener pair data');
        return null;
    }
};
const extractTopHolders = (security) => {
    const raw = security?.top_holders ?? security?.topHolders;
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const holders = raw
        .map((entry) => {
        const address = entry?.address ?? entry?.owner ?? entry?.wallet ?? '';
        const percent = toNumber(entry?.percentage ?? entry?.percent ?? entry?.share ?? entry?.pct);
        if (!address || percent === undefined) {
            return undefined;
        }
        return {
            address: String(address),
            percent
        };
    })
        .filter((entry) => Boolean(entry));
    return holders.length > 0 ? holders : undefined;
};
const buildDiscoveryCandidate = async (client, token) => {
    const mint = token?.address ?? token?.mint ?? token?.tokenAddress;
    if (!mint || typeof mint !== 'string') {
        return null;
    }
    const [overview, security, dexscreener] = await Promise.all([
        fetchTokenOverview(client, mint),
        fetchTokenSecurity(client, mint),
        fetchDexScreenerPair(mint)
    ]);
    const liquidityUsd = toNumber(token?.liquidityUsd ?? token?.liquidity_usd ?? token?.liquidity) ??
        toNumber(overview?.liquidityUsd ?? overview?.liquidity_usd ?? overview?.liquidity) ??
        toNumber(dexscreener?.liquidity?.usd);
    const volume1hUsd = toNumber(token?.volume1hUsd ?? token?.volume_1h ?? token?.volumeUsd1h) ??
        toNumber(overview?.volume1hUsd ?? overview?.volumeUsd1h ?? overview?.volume_1h) ??
        toNumber(dexscreener?.volume?.h1 ?? dexscreener?.volume1h ?? dexscreener?.volume24h);
    const marketCapUsd = toNumber(token?.marketCapUsd ?? token?.market_cap ?? token?.fdv) ??
        toNumber(overview?.marketCap ?? overview?.market_cap ?? overview?.fdv ?? overview?.fully_diluted_valuation) ??
        toNumber(dexscreener?.fdv ?? dexscreener?.marketCap);
    const holderCount = toNumber(token?.holderCount ?? token?.holder ?? token?.holders) ??
        toNumber(overview?.holderCount ?? overview?.holders ?? overview?.holder) ??
        toNumber(security?.holder_count ?? security?.holders);
    const topHolderPercent = toNumber(security?.top_holder_percent ?? security?.topHolderPercent) ??
        toNumber(security?.top_holders?.[0]?.percentage ?? security?.topHolders?.[0]?.percent);
    const creatorHoldPercent = toNumber(security?.creator_hold_percent ?? security?.creatorHoldPercent);
    const mintAuthority = security?.mint_authority ?? security?.mintAuthority;
    const freezeAuthority = security?.freeze_authority ?? security?.freezeAuthority;
    const candidate = {
        mint,
        symbol: token?.symbol ?? overview?.symbol,
        name: token?.name ?? overview?.name,
        priceUsd: toNumber(token?.priceUsd ?? token?.price_usd ?? token?.price ?? overview?.priceUsd ?? overview?.price),
        liquidityUsd,
        volume1hUsd,
        marketCapUsd,
        ageMinutes: computeAgeMinutes(coerceTimestampMs(token?.pairCreatedAt ?? token?.pair_created_at ?? token?.created_at ??
            overview?.pairCreatedAt ?? overview?.created_at ??
            security?.pair_created_at ?? security?.created_at ??
            dexscreener?.pairCreatedAt ?? dexscreener?.createdAt)),
        holderCount,
        priceChange5mPercent: toNumber(token?.priceChange5mPercent ?? token?.price_change_5m_percent ??
            token?.price_change_5m ?? dexscreener?.priceChange?.m5 ?? dexscreener?.priceChange5m),
        priceChange1hPercent: toNumber(token?.priceChange1hPercent ?? token?.price_change_1h_percent ??
            token?.price_change_1h ?? dexscreener?.priceChange?.h1 ?? dexscreener?.priceChange1h),
        topHolderPercent,
        creatorHoldPercent,
        hasMintAuthority: mintAuthority ? true : false,
        hasFreezeAuthority: freezeAuthority ? true : false,
        liquidityLocked: toBoolean(dexscreener?.liquidity?.locked) ?? toBoolean(dexscreener?.liquidityLocked) ?? undefined,
        liquidityBurned: toBoolean(dexscreener?.liquidity?.burned) ?? toBoolean(dexscreener?.liquidityBurned) ?? undefined,
        creatorAddress: security?.creator ?? security?.creator_address ?? overview?.creator ?? undefined,
        isHoneypot: Boolean(security?.is_honeypot ?? security?.honeypot ?? false),
        topHolders: extractTopHolders(security),
        sources: ['birdeye_trending']
    };
    return candidate;
};
const evaluateDiscoveryFilters = (candidate) => {
    const { filters } = config_1.default.discovery;
    const reasons = [];
    const warnings = [];
    const summary = {};
    const compareNumber = (value, threshold, comparator, key, message, allowMissing = true) => {
        if (value === undefined) {
            if (!allowMissing) {
                reasons.push({ key, message });
                summary[key] = null;
            }
            else {
                summary[key] = null;
            }
            return;
        }
        const passed = comparator(value, threshold);
        summary[key] = passed;
        if (!passed) {
            reasons.push({ key, message });
        }
    };
    const checkBooleanRequirement = (value, requiredState, key, message) => {
        if (value === undefined) {
            summary[key] = null;
            if (!filters.allowMissingSecurityData) {
                reasons.push({ key, message: `Missing ${message}` });
            }
            return;
        }
        const passed = value === requiredState;
        summary[key] = passed;
        if (!passed) {
            reasons.push({ key, message });
        }
    };
    compareNumber(candidate.liquidityUsd, filters.minLiquidityUsd, (a, b) => a >= b, 'liquidity', 'Liquidity below minimum');
    compareNumber(candidate.volume1hUsd, filters.minVolume1hUsd, (a, b) => a >= b, 'volume1h', 'Volume 1h below minimum');
    compareNumber(candidate.marketCapUsd, filters.minMarketCapUsd, (a, b) => a >= b, 'marketCap', 'Market cap below minimum');
    compareNumber(candidate.priceChange5mPercent, filters.minPriceChange5mPercent, (a, b) => a >= b, 'momentum5m', 'Momentum below minimum');
    compareNumber(candidate.ageMinutes, filters.minAgeMinutes, (a, b) => a >= b, 'ageMinutes', 'Token age below minimum', !filters.allowMissingSecurityData);
    compareNumber(candidate.holderCount, filters.minHolderCount, (a, b) => a >= b, 'holderCount', 'Holder count below minimum', !filters.allowMissingSecurityData);
    if (filters.maxCreatorHoldPercent >= 0) {
        compareNumber(candidate.creatorHoldPercent, filters.maxCreatorHoldPercent, (a, b) => a <= b, 'creatorConcentration', 'Creator holding exceeds maximum', !filters.allowMissingSecurityData);
    }
    if (filters.maxTopHolderPercent >= 0) {
        compareNumber(candidate.topHolderPercent, filters.maxTopHolderPercent, (a, b) => a <= b, 'topHolderConcentration', 'Top holder concentration exceeds maximum', !filters.allowMissingSecurityData);
    }
    if (filters.requireMintAuthorityDisabled) {
        checkBooleanRequirement(candidate.hasMintAuthority === undefined ? undefined : !candidate.hasMintAuthority, true, 'mintAuthorityDisabled', 'Mint authority still enabled');
    }
    if (filters.requireFreezeAuthorityDisabled) {
        checkBooleanRequirement(candidate.hasFreezeAuthority === undefined ? undefined : !candidate.hasFreezeAuthority, true, 'freezeAuthorityDisabled', 'Freeze authority still enabled');
    }
    if (filters.requireLiquidityLockOrBurn) {
        if (candidate.liquidityLocked === undefined && candidate.liquidityBurned === undefined) {
            summary.liquidityLockOrBurn = null;
            warnings.push('LP lock/burn data unavailable');
        }
        else {
            const lockedOrBurned = Boolean(candidate.liquidityLocked || candidate.liquidityBurned);
            summary.liquidityLockOrBurn = lockedOrBurned;
            if (!lockedOrBurned) {
                warnings.push('Liquidity is neither locked nor burned');
            }
        }
    }
    if (candidate.isHoneypot) {
        summary.honeypot = false;
        reasons.push({ key: 'honeypot', message: 'Token flagged as honeypot' });
    }
    else {
        summary.honeypot = candidate.isHoneypot === undefined ? null : true;
    }
    const passes = reasons.length === 0;
    if (!passes) {
        logger_1.default.debug({ mint: candidate.mint, reasons }, 'Rejected discovery candidate');
    }
    return {
        passes,
        conditions: summary,
        failures: reasons,
        warnings
    };
};
async function fetchTrendingTokens() {
    const { enabled, trendingLimit } = config_1.default.discovery.birdeye;
    const normalizedTrendingLimit = Math.max(BIRDEYE_MIN_TRENDING_LIMIT, Math.trunc(trendingLimit));
    const apiKey = process.env.BIRDEYE_API_KEY?.trim();
    if (!enabled) {
        logger_1.default.debug('Birdeye discovery disabled in configuration');
        return { accepted: [], rejected: [] };
    }
    if (!apiKey) {
        logger_1.default.warn('BIRDEYE_API_KEY is not set; skipping Birdeye trending fetch');
        return { accepted: [], rejected: [] };
    }
    if (normalizedTrendingLimit !== trendingLimit) {
        logger_1.default.warn({
            configuredLimit: trendingLimit,
            effectiveLimit: normalizedTrendingLimit
        }, 'Adjusted Birdeye trending limit to valid range');
    }
    const client = createBirdeyeClient(apiKey);
    try {
        const trendingTokens = await fetchBirdeyeTrending(client, normalizedTrendingLimit);
        if (trendingTokens.length === 0) {
            return { accepted: [], rejected: [] };
        }
        const candidates = await runWithConcurrency(trendingTokens, DETAIL_FETCH_CONCURRENCY, (token) => buildDiscoveryCandidate(client, token));
        const evaluatedCandidates = candidates
            .filter((candidate) => Boolean(candidate))
            .map((candidate) => {
            const evaluation = evaluateDiscoveryFilters(candidate);
            return {
                candidate,
                evaluation
            };
        });
        const validCandidates = evaluatedCandidates
            .filter(({ evaluation }) => evaluation.passes)
            .map(({ candidate, evaluation }) => ({
            ...candidate,
            filterReasons: evaluation.failures.map((failure) => failure.message),
            filterWarnings: evaluation.warnings,
            filterSummary: evaluation.conditions
        }));
        const rejectedCandidates = evaluatedCandidates
            .filter(({ evaluation }) => !evaluation.passes)
            .map(({ candidate, evaluation }) => ({
            mint: candidate.mint,
            symbol: candidate.symbol,
            name: candidate.name,
            reasons: evaluation.failures.map((failure) => failure.message),
            warnings: evaluation.warnings,
            summary: evaluation.conditions,
            sources: candidate.sources ?? ['birdeye_trending'],
            liquidityUsd: candidate.liquidityUsd,
            volume1hUsd: candidate.volume1hUsd,
            marketCapUsd: candidate.marketCapUsd,
            ageMinutes: candidate.ageMinutes,
            holderCount: candidate.holderCount
        }));
        const rejectedCount = rejectedCandidates.length;
        const rejectionDetails = rejectedCandidates
            .slice(0, config_1.default.discovery.rejectionLogSampleSize)
            .map((rejection) => ({ mint: rejection.mint, reasons: rejection.reasons, warnings: rejection.warnings }));
        logger_1.default.info({
            requested: normalizedTrendingLimit,
            fetched: trendingTokens.length,
            evaluated: evaluatedCandidates.length,
            accepted: validCandidates.length,
            rejected: rejectedCount,
            samples: rejectionDetails
        }, 'Birdeye discovery evaluation complete');
        return { accepted: validCandidates, rejected: rejectedCandidates };
    }
    catch (err) {
        logger_1.default.error({ err }, 'Failed to fetch trending tokens from Birdeye');
        return { accepted: [], rejected: [] };
    }
}
