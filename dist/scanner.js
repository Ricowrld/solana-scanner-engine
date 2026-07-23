"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanOnce = void 0;
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const jupiter_1 = require("./jupiter");
const jupiterTokens_1 = require("./jupiterTokens");
const discovery_1 = require("./discovery");
const filters_1 = require("./filters");
const trends_1 = require("./trends");
const storage_1 = require("./storage");
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const createRateLimiter = (delayMs) => {
    if (delayMs <= 0) {
        return null;
    }
    let nextAvailable = 0;
    return async () => {
        const now = Date.now();
        if (now < nextAvailable) {
            await sleep(nextAvailable - now);
        }
        nextAvailable = Math.max(now, nextAvailable) + delayMs;
    };
};
const runWithConcurrency = async (items, concurrency, handler) => {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        while (true) {
            const currentIndex = cursor++;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await handler(items[currentIndex], currentIndex);
        }
    };
    const workerCount = Math.max(1, concurrency);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
};
const buildChartLink = (mint) => {
    return `https://birdeye.so/token/${mint}?chain=solana`;
};
const derivePriceQuote = (inputAmount, outputAmount) => {
    if (outputAmount === 0) {
        return 0;
    }
    return inputAmount / outputAmount;
};
const extractDecimals = (metadata) => {
    return metadata?.decimals ?? 9;
};
const extractName = (metadata, mint) => {
    return metadata?.name ?? mint.slice(0, 8);
};
const extractSymbol = (metadata, mint) => {
    return metadata?.symbol ?? mint.slice(0, 4);
};
const logRejection = (mint, reason) => {
    logger_1.default.debug({ mint, reason }, 'Token filtered out');
};
const pruneFailureCache = (cache, now) => {
    let removedEntries = 0;
    for (const [mint, entry] of Object.entries(cache)) {
        const expired = now - entry.recordedAt >= config_1.default.jupiter.failureTtlMs;
        const isInputMint = mint === config_1.default.jupiter.inputMint;
        if (expired || isInputMint) {
            delete cache[mint];
            removedEntries += 1;
        }
    }
    if (removedEntries > 0) {
        logger_1.default.debug({ removed: removedEntries }, 'Pruned entries from failure cache');
    }
    return cache;
};
const buildBaseAlert = (candidate, metadata, inputTokenSymbol) => {
    const mint = candidate.mint;
    const discovery = candidate.discovery;
    return {
        tokenName: extractName(metadata, mint),
        tokenSymbol: extractSymbol(metadata, mint),
        contractAddress: mint,
        priceQuote: 0,
        priceChange1mPercent: 0,
        priceChange5mPercent: 0,
        priceChange1hPercent: 0,
        priceImpactPercent: 0,
        inputAmount: 0,
        outputAmount: 0,
        inputTokenSymbol,
        route: [],
        chartUrl: buildChartLink(mint),
        discoverySources: discovery?.sources,
        discoveryLiquidityUsd: discovery?.liquidityUsd,
        discoveryVolume1hUsd: discovery?.volume1hUsd,
        discoveryMarketCapUsd: discovery?.marketCapUsd,
        discoveryAgeMinutes: discovery?.ageMinutes,
        discoveryHolderCount: discovery?.holderCount,
        discoveryWarnings: discovery?.filterWarnings
    };
};
const finalizeCandidate = (candidate, metadata, quoteResult, fetchError, trendStore, failureCache, ctx) => {
    const mint = candidate.mint;
    const baseAlert = buildBaseAlert(candidate, metadata, ctx.inputTokenSymbol);
    if (fetchError) {
        logger_1.default.warn({ mint, err: fetchError }, 'Jupiter quote fetch failed');
        failureCache[mint] = { reason: 'API_ERROR', recordedAt: ctx.timestamp };
        return {
            scanResult: {
                alert: baseAlert,
                decision: { shouldAlert: false, reason: 'Jupiter quote request failed' },
                candidate
            },
            trendStore,
            failureCache
        };
    }
    const cachedFailure = failureCache[mint];
    if (cachedFailure && ctx.timestamp - cachedFailure.recordedAt < config_1.default.jupiter.failureTtlMs) {
        if (cachedFailure.reason === 'BAD_REQUEST' &&
            ctx.timestamp - cachedFailure.recordedAt > config_1.default.jupiter.failureTtlMs * 0.8) {
            delete failureCache[mint];
        }
        const decision = {
            shouldAlert: false,
            reason: `Suppressed due to recent ${cachedFailure.reason} failure`
        };
        logRejection(mint, decision.reason);
        return {
            scanResult: { alert: baseAlert, decision, candidate },
            trendStore,
            failureCache
        };
    }
    const { quote, failureReason } = quoteResult ?? { quote: null, failureReason: undefined };
    const quoteDecision = (0, filters_1.evaluateQuoteQuality)({
        quote,
        inputDecimals: ctx.inputDecimals,
        outputDecimals: extractDecimals(metadata),
        maxPriceImpactPct: config_1.default.jupiter.maxPriceImpactPct
    });
    const inputAmount = quoteDecision.inputAmount ?? 0;
    const outputAmount = quoteDecision.outputAmount ?? 0;
    const priceQuote = derivePriceQuote(inputAmount, outputAmount);
    let workingTrendStore = trendStore;
    if (priceQuote > 0) {
        workingTrendStore = (0, trends_1.updateTrendStore)(workingTrendStore, mint, priceQuote, ctx.timestamp);
    }
    const enrichAlert = (alert) => ({
        ...alert,
        priceQuote,
        priceChange1mPercent: (0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 60 * 1000),
        priceChange5mPercent: (0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 5 * 60 * 1000),
        priceChange1hPercent: (0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 60 * 60 * 1000),
        priceImpactPercent: quoteDecision.priceImpactPct ?? 0,
        inputAmount,
        outputAmount,
        route: quoteDecision.route ?? [],
        bestDex: quoteDecision.route?.[0],
        discoverySources: candidate.discovery?.sources ?? alert.discoverySources,
        discoveryLiquidityUsd: candidate.discovery?.liquidityUsd ?? alert.discoveryLiquidityUsd,
        discoveryVolume1hUsd: candidate.discovery?.volume1hUsd ?? alert.discoveryVolume1hUsd,
        discoveryMarketCapUsd: candidate.discovery?.marketCapUsd ?? alert.discoveryMarketCapUsd,
        discoveryAgeMinutes: candidate.discovery?.ageMinutes ?? alert.discoveryAgeMinutes,
        discoveryHolderCount: candidate.discovery?.holderCount ?? alert.discoveryHolderCount,
        discoveryWarnings: candidate.discovery?.filterWarnings ?? alert.discoveryWarnings
    });
    if (!quoteDecision.shouldAlert || !quote) {
        const derivedReason = failureReason
            ? failureReason
            : quoteDecision.reason?.toLowerCase().includes('price impact')
                ? 'HIGH_IMPACT'
                : undefined;
        if (derivedReason) {
            failureCache[mint] = { reason: derivedReason, recordedAt: ctx.timestamp };
        }
        const alert = enrichAlert(baseAlert);
        logRejection(mint, quoteDecision.reason);
        return {
            scanResult: {
                alert,
                decision: quoteDecision,
                candidate
            },
            trendStore: workingTrendStore,
            failureCache
        };
    }
    const momentumDecision = (0, filters_1.evaluateMomentum)((0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 60 * 1000), (0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 5 * 60 * 1000), (0, trends_1.calculateChangePercent)(workingTrendStore[mint], ctx.timestamp, 60 * 60 * 1000), config_1.default.thresholds);
    if (!momentumDecision.shouldAlert) {
        const alert = enrichAlert(baseAlert);
        logRejection(mint, momentumDecision.reason);
        return {
            scanResult: { alert, decision: momentumDecision, candidate },
            trendStore: workingTrendStore,
            failureCache
        };
    }
    if (failureCache[mint]) {
        delete failureCache[mint];
    }
    const finalAlert = enrichAlert(baseAlert);
    return {
        scanResult: {
            alert: finalAlert,
            decision: { ...quoteDecision, shouldAlert: true },
            candidate
        },
        trendStore: workingTrendStore,
        failureCache
    };
};
const hasWarnedAboutInputMint = { value: false };
const scanOnce = async (cooldownMints = new Set()) => {
    const { candidates: fallbackCandidates, tokenMap } = await (0, jupiterTokens_1.buildTokenCandidates)();
    const { accepted: trendingCandidates, rejected: discoveryRejections } = await (0, discovery_1.fetchTrendingTokens)();
    console.log('Trending tokens:', trendingCandidates.map((candidate) => {
        const metadata = tokenMap[candidate.mint];
        return candidate.symbol ?? metadata?.symbol ?? candidate.mint.slice(0, 4);
    }));
    const discoveryCandidates = trendingCandidates.map((candidate) => {
        const metadata = tokenMap[candidate.mint];
        const baseSources = candidate.sources ?? [];
        const mergedSources = baseSources.includes('birdeye_trending')
            ? baseSources
            : [...baseSources, 'birdeye_trending'];
        return {
            mint: candidate.mint,
            metadata,
            discovery: {
                ...candidate,
                symbol: candidate.symbol ?? metadata?.symbol,
                name: candidate.name ?? metadata?.name,
                sources: mergedSources
            }
        };
    });
    const candidates = discoveryCandidates.length > 0 ? discoveryCandidates : fallbackCandidates;
    logger_1.default.info({
        discoveryFetched: trendingCandidates.length,
        discoveryRejected: discoveryRejections.length,
        fallbackCandidates: fallbackCandidates.length,
        candidatesSelected: candidates.length
    }, 'Loaded candidate universe');
    const activeCooldown = new Set(cooldownMints);
    const legacyCooldown = new Set(Array.from(cooldownMints, (mint) => mint.toLowerCase()));
    const activeCandidates = candidates.filter((candidate) => {
        if (activeCooldown.has(candidate.mint)) {
            return false;
        }
        if (legacyCooldown.has(candidate.mint.toLowerCase())) {
            return false;
        }
        return true;
    });
    const inputTokenMetadata = tokenMap[config_1.default.jupiter.inputMint];
    const inputTokenSymbol = extractSymbol(inputTokenMetadata, config_1.default.jupiter.inputMint);
    const inputDecimals = extractDecimals(inputTokenMetadata);
    if (!hasWarnedAboutInputMint.value && config_1.default.jupiter.inputMint !== USDC_MINT) {
        logger_1.default.warn({
            inputMint: config_1.default.jupiter.inputMint,
            expectedMint: USDC_MINT
        }, 'Momentum tracking is calibrated for USDC input mint; rename fields indicate priceQuote instead of USD');
        hasWarnedAboutInputMint.value = true;
    }
    let trendStore = await (0, trends_1.loadTrendStore)();
    let failureCache = await (0, storage_1.loadJsonCache)(config_1.default.jupiter.failureCacheFile, {});
    const cycleTimestamp = Date.now();
    failureCache = pruneFailureCache(failureCache, cycleTimestamp);
    const delayBetweenRequestsMs = config_1.default.jupiter.maxRequestsPerSecond > 0 ? Math.floor(1000 / config_1.default.jupiter.maxRequestsPerSecond) : 0;
    const rateLimiter = createRateLimiter(delayBetweenRequestsMs);
    const concurrency = Math.max(1, Math.min(config_1.default.jupiter.batchSize, config_1.default.jupiter.maxRequestsPerSecond || 1));
    const pending = [];
    const results = [];
    activeCandidates.forEach((candidate) => {
        const metadata = candidate.metadata;
        const mint = candidate.mint;
        const cachedFailure = failureCache[mint];
        if (cachedFailure && cycleTimestamp - cachedFailure.recordedAt < config_1.default.jupiter.failureTtlMs) {
            if (cachedFailure.reason === 'BAD_REQUEST') {
                logger_1.default.debug({
                    mint,
                    reason: cachedFailure.reason,
                    recordedAt: cachedFailure.recordedAt,
                    ageMs: cycleTimestamp - cachedFailure.recordedAt
                }, 'Skipping mint due to recent BAD_REQUEST failure');
            }
            const alert = buildBaseAlert(candidate, metadata, inputTokenSymbol);
            const decision = {
                shouldAlert: false,
                reason: `Suppressed due to recent ${cachedFailure.reason} failure`
            };
            logRejection(mint, decision.reason);
            results.push({ alert, decision, candidate });
            return;
        }
        pending.push({ candidate, metadata, index: results.length });
        results.push(null);
    });
    const fetchTargets = pending.map((item) => item);
    const fetchOutcomes = await runWithConcurrency(fetchTargets, concurrency, async (target, idx) => {
        const request = { outputMint: target.candidate.mint };
        try {
            if (rateLimiter) {
                await rateLimiter();
            }
            const quoteResult = await (0, jupiter_1.fetchJupiterQuote)(request);
            logger_1.default.info({
                mint: target.candidate.mint,
                hasQuote: Boolean(quoteResult.quote),
                failureReason: quoteResult.failureReason,
                status: quoteResult.httpStatus
            }, 'Quote result');
            return { index: target.index, quoteResult };
        }
        catch (error) {
            return { index: target.index, quoteResult: null, error };
        }
    });
    const outcomeMap = new Map();
    let rateLimitedCount = 0;
    for (const outcome of fetchOutcomes) {
        const quoteResult = outcome.quoteResult ?? null;
        if (quoteResult?.failureReason === 'RATE_LIMITED') {
            rateLimitedCount += 1;
        }
        outcomeMap.set(outcome.index, {
            quoteResult,
            error: outcome.error
        });
    }
    if (rateLimitedCount > 0) {
        const backoffMs = 5000;
        logger_1.default.warn({ rateLimitedCount, backoffMs }, 'Received RATE_LIMITED responses; backing off');
        await sleep(backoffMs);
    }
    for (const pendingItem of pending) {
        const { candidate, metadata, index } = pendingItem;
        const outcome = outcomeMap.get(index) ?? { quoteResult: null, error: undefined };
        const { scanResult, trendStore: nextStore, failureCache: nextFailures } = finalizeCandidate(candidate, metadata, outcome.quoteResult, outcome.error, trendStore, failureCache, {
            timestamp: cycleTimestamp,
            inputDecimals,
            inputTokenSymbol
        });
        trendStore = nextStore;
        failureCache = nextFailures;
        results[index] = scanResult;
    }
    await (0, trends_1.saveTrendStore)(trendStore);
    await (0, storage_1.saveJsonCache)(config_1.default.jupiter.failureCacheFile, failureCache);
    const finalizedResults = results.filter((result) => result !== null);
    const failureReasonCounts = finalizedResults.reduce((acc, result) => {
        const reason = result.decision.shouldAlert ? 'alerted' : result.decision.reason ?? 'unknown';
        acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
    }, {});
    logger_1.default.info({ results: finalizedResults.length, failureReasons: failureReasonCounts }, 'Scan complete');
    return {
        results: finalizedResults,
        discoveryRejections
    };
};
exports.scanOnce = scanOnce;
