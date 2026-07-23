import config from './config';
import logger from './logger';
import { QuoteRequestOptions, fetchJupiterQuote } from './jupiter';
import { buildTokenCandidates } from './jupiterTokens';
import { fetchTrendingTokens } from './discovery';
import { evaluateMomentum, evaluateQuoteQuality } from './filters';
import {
  DiscoveryRejection,
  JupiterTokenMetadata,
  QuoteEvaluation,
  QuoteFailureCache,
  QuoteFailureReason,
  ScanResult,
  TokenAlert,
  QuoteFetchResult,
  TokenCandidate
} from './types';
import {
  TrendStore,
  calculateChangePercent,
  getTrendObservationAgeMs,
  loadTrendStore,
  pruneTrendStore,
  saveTrendStore,
  updateTrendStore
} from './trends';
import { loadJsonCache, saveJsonCache } from './storage';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_JUPITER_RPS = Math.max(1, Math.trunc(config.jupiter.maxRequestsPerSecond) || 1);

let adaptiveJupiterRps = BASE_JUPITER_RPS;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const reduceAdaptiveJupiterRps = (rateLimitedCount: number): void => {
  const previousRps = adaptiveJupiterRps;
  const reductionFactor = rateLimitedCount > 1 ? 0.4 : 0.5;
  adaptiveJupiterRps = Math.max(1, Math.floor(adaptiveJupiterRps * reductionFactor));

  if (adaptiveJupiterRps < previousRps) {
    logger.warn(
      {
        rateLimitedCount,
        previousRps,
        nextRps: adaptiveJupiterRps
      },
      'Reduced Jupiter throughput after rate limit responses'
    );
  }
};

const recoverAdaptiveJupiterRps = (): void => {
  if (adaptiveJupiterRps >= BASE_JUPITER_RPS) {
    return;
  }

  const previousRps = adaptiveJupiterRps;
  adaptiveJupiterRps = Math.min(BASE_JUPITER_RPS, adaptiveJupiterRps + 1);

  if (adaptiveJupiterRps > previousRps) {
    logger.debug(
      {
        previousRps,
        nextRps: adaptiveJupiterRps
      },
      'Recovered Jupiter throughput after a clean scan'
    );
  }
};

const createRateLimiter = (delayMs: number) => {
  if (delayMs <= 0) {
    return null;
  }
  let nextAvailable = 0;
  return async (): Promise<void> => {
    const now = Date.now();
    if (now < nextAvailable) {
      await sleep(nextAvailable - now);
    }
    nextAvailable = Math.max(now, nextAvailable) + delayMs;
  };
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
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

const buildChartLink = (mint: string): string => {
  return `https://birdeye.so/token/${mint}?chain=solana`;
};

const ensureTrendObservation = (
  trendStore: TrendStore,
  mint: string,
  firstSeenAt: number
): TrendStore => {
  const existing = trendStore[mint];
  if (existing) {
    if (existing.firstSeenAt !== undefined) {
      return trendStore;
    }

    return {
      ...trendStore,
      [mint]: {
        ...existing,
        firstSeenAt: existing.points[0]?.timestamp ?? firstSeenAt
      }
    };
  }

  return {
    ...trendStore,
    [mint]: {
      mint,
      firstSeenAt,
      points: []
    }
  };
};

const derivePriceQuote = (inputAmount: number, outputAmount: number): number => {
  if (outputAmount === 0) {
    return 0;
  }
  return inputAmount / outputAmount;
};

const extractDecimals = (metadata: JupiterTokenMetadata | undefined): number => {
  return metadata?.decimals ?? 9;
};

const extractName = (metadata: JupiterTokenMetadata | undefined, mint: string): string => {
  return metadata?.name ?? mint.slice(0, 8);
};

const extractSymbol = (metadata: JupiterTokenMetadata | undefined, mint: string): string => {
  return metadata?.symbol ?? mint.slice(0, 4);
};

const logRejection = (mint: string, reason?: string): void => {
  logger.debug({ mint, reason }, 'Token filtered out');
};

const pruneFailureCache = (cache: QuoteFailureCache, now: number): QuoteFailureCache => {
  let removedEntries = 0;

  for (const [mint, entry] of Object.entries(cache)) {
    const expired = now - entry.recordedAt >= config.jupiter.failureTtlMs;
    const isInputMint = mint === config.jupiter.inputMint;

    if (expired || isInputMint) {
      delete cache[mint];
      removedEntries += 1;
    }
  }

  if (removedEntries > 0) {
    logger.debug({ removed: removedEntries }, 'Pruned entries from failure cache');
  }

  return cache;
};

const buildBaseAlert = (
  candidate: TokenCandidate,
  metadata: JupiterTokenMetadata | undefined,
  inputTokenSymbol: string
): TokenAlert => {
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
    discoveryScore: discovery?.discoveryScore,
    discoveryWarnings: discovery?.filterWarnings
  };
};

interface FinalizeContext {
  timestamp: number;
  inputDecimals: number;
  inputTokenSymbol: string;
}

interface FinalizeResult {
  scanResult: ScanResult;
  trendStore: TrendStore;
  failureCache: QuoteFailureCache;
}

const finalizeCandidate = (
  candidate: TokenCandidate,
  metadata: JupiterTokenMetadata | undefined,
  quoteResult: QuoteFetchResult | null,
  fetchError: unknown,
  trendStore: TrendStore,
  failureCache: QuoteFailureCache,
  ctx: FinalizeContext
): FinalizeResult => {
  const mint = candidate.mint;
  const baseAlert = buildBaseAlert(candidate, metadata, ctx.inputTokenSymbol);

  if (fetchError) {
    logger.warn({ mint, err: fetchError }, 'Jupiter quote fetch failed');
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
  if (cachedFailure && ctx.timestamp - cachedFailure.recordedAt < config.jupiter.failureTtlMs) {
    if (
      cachedFailure.reason === 'BAD_REQUEST' &&
      ctx.timestamp - cachedFailure.recordedAt > config.jupiter.failureTtlMs * 0.8
    ) {
      delete failureCache[mint];
    }
    const decision: QuoteEvaluation = {
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

  const quoteDecision = evaluateQuoteQuality({
    quote,
    inputDecimals: ctx.inputDecimals,
    outputDecimals: extractDecimals(metadata),
    maxPriceImpactPct: config.jupiter.maxPriceImpactPct
  });

  const inputAmount = quoteDecision.inputAmount ?? 0;
  const outputAmount = quoteDecision.outputAmount ?? 0;
  const priceQuote = derivePriceQuote(inputAmount, outputAmount);

  let workingTrendStore = trendStore;
  if (priceQuote > 0) {
    workingTrendStore = updateTrendStore(workingTrendStore, mint, priceQuote, ctx.timestamp);
  }

  const enrichAlert = (alert: TokenAlert): TokenAlert => ({
    ...alert,
    priceQuote,
    priceChange1mPercent: calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 60 * 1000),
    priceChange5mPercent: calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 5 * 60 * 1000),
    priceChange1hPercent: calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 60 * 60 * 1000),
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
    discoveryScore: candidate.discovery?.discoveryScore ?? alert.discoveryScore,
    discoveryWarnings: candidate.discovery?.filterWarnings ?? alert.discoveryWarnings
  });

  if (!quoteDecision.shouldAlert || !quote) {
    const derivedReason: QuoteFailureReason | undefined = failureReason
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

  const momentumDecision = evaluateMomentum(
    calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 60 * 1000),
    calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 5 * 60 * 1000),
    calculateChangePercent(workingTrendStore[mint], ctx.timestamp, 60 * 60 * 1000),
    config.thresholds
  );

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

const hasWarnedAboutInputMint: { value: boolean } = { value: false };

export const scanOnce = async (
  cooldownMints: Set<string> = new Set(),
  requiredMints: Set<string> = new Set()
): Promise<{ results: ScanResult[]; discoveryRejections: DiscoveryRejection[] }> => {
  const { candidates: fallbackCandidates, tokenMap } = await buildTokenCandidates();
  const { accepted: trendingCandidates, rejected: discoveryRejections } = await fetchTrendingTokens();

  const discoveryCandidates: TokenCandidate[] = trendingCandidates.map((candidate) => {
    const metadata = tokenMap[candidate.mint];

    return {
      mint: candidate.mint,
      metadata,
      discovery: {
        ...candidate,
        symbol: candidate.symbol ?? metadata?.symbol,
        name: candidate.name ?? metadata?.name,
        sources: candidate.sources ?? []
      }
    };
  });
  const baseCandidates = discoveryCandidates.length > 0 ? discoveryCandidates : fallbackCandidates;
  const candidatesByMint = new Map<string, TokenCandidate>(baseCandidates.map((candidate) => [candidate.mint, candidate]));

  for (const mint of requiredMints) {
    if (candidatesByMint.has(mint)) {
      continue;
    }

    candidatesByMint.set(mint, {
      mint,
      metadata: tokenMap[mint]
    });
  }

  const candidates = Array.from(candidatesByMint.values());

  logger.info(
    {
      discoveryFetched: trendingCandidates.length,
      discoveryRejected: discoveryRejections.length,
      fallbackCandidates: fallbackCandidates.length,
      candidatesSelected: candidates.length,
      requiredMints: requiredMints.size
    },
    'Loaded candidate universe'
  );

  const activeCooldown = new Set(cooldownMints);
  const legacyCooldown = new Set(Array.from(cooldownMints, (mint) => mint.toLowerCase()));
  const activeCandidates = candidates.filter((candidate) => {
    if (requiredMints.has(candidate.mint)) {
      return true;
    }

    if (activeCooldown.has(candidate.mint)) {
      return false;
    }

    if (legacyCooldown.has(candidate.mint.toLowerCase())) {
      return false;
    }

    return true;
  });

  const inputTokenMetadata = tokenMap[config.jupiter.inputMint];
  const inputTokenSymbol = extractSymbol(inputTokenMetadata, config.jupiter.inputMint);
  const inputDecimals = extractDecimals(inputTokenMetadata);

  if (!hasWarnedAboutInputMint.value && config.jupiter.inputMint !== USDC_MINT) {
    logger.warn(
      {
        inputMint: config.jupiter.inputMint,
        expectedMint: USDC_MINT
      },
      'Momentum tracking is calibrated for USDC input mint; rename fields indicate priceQuote instead of USD'
    );
    hasWarnedAboutInputMint.value = true;
  }

  let trendStore = await loadTrendStore();
  let failureCache = await loadJsonCache<QuoteFailureCache>(config.jupiter.failureCacheFile, {});
  const cycleTimestamp = Date.now();
  failureCache = pruneFailureCache(failureCache, cycleTimestamp);
  const observationWindowMs = Math.max(0, config.minObservationAgeMinutes) * 60 * 1000;
  const cycleJupiterRps = adaptiveJupiterRps;
  const delayBetweenRequestsMs = cycleJupiterRps > 0 ? Math.floor(1000 / cycleJupiterRps) : 0;
  const rateLimiter = createRateLimiter(delayBetweenRequestsMs);
  const concurrency = Math.max(1, Math.min(config.jupiter.batchSize, cycleJupiterRps));

  const pending: { candidate: TokenCandidate; metadata?: JupiterTokenMetadata; index: number }[] = [];
  const results: (ScanResult | null)[] = [];

  activeCandidates.forEach((candidate) => {
    const metadata = candidate.metadata;
    const mint = candidate.mint;
    const isRequiredMint = requiredMints.has(mint);
    const cachedFailure = failureCache[mint];
    const history = trendStore[mint];

    if (!isRequiredMint && history && history.firstSeenAt === undefined) {
      trendStore = ensureTrendObservation(trendStore, mint, cycleTimestamp);
    }

    if (!isRequiredMint && observationWindowMs > 0) {
      trendStore = ensureTrendObservation(trendStore, mint, cycleTimestamp);
      const observationAgeMs = getTrendObservationAgeMs(trendStore[mint], cycleTimestamp) ?? 0;

      if (observationAgeMs < observationWindowMs) {
        const alert = buildBaseAlert(candidate, metadata, inputTokenSymbol);
        const remainingMinutes = Math.max(1, Math.ceil((observationWindowMs - observationAgeMs) / (60 * 1000)));
        const decision: QuoteEvaluation = {
          shouldAlert: false,
          reason: `Waiting for observation window (${remainingMinutes}m remaining)`
        };
        logRejection(mint, decision.reason);
        results.push({ alert, decision, candidate });
        return;
      }
    }

    if (cachedFailure && cycleTimestamp - cachedFailure.recordedAt < config.jupiter.failureTtlMs) {
      if (cachedFailure.reason === 'BAD_REQUEST') {
        logger.debug(
          {
            mint,
            reason: cachedFailure.reason,
            recordedAt: cachedFailure.recordedAt,
            ageMs: cycleTimestamp - cachedFailure.recordedAt
          },
          'Skipping mint due to recent BAD_REQUEST failure'
        );
      }
      const alert = buildBaseAlert(candidate, metadata, inputTokenSymbol);
      const decision: QuoteEvaluation = {
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
    const request: QuoteRequestOptions = { outputMint: target.candidate.mint };
    try {
      if (rateLimiter) {
        await rateLimiter();
      }
      const quoteResult = await fetchJupiterQuote(request);
      logger.info(
        {
          mint: target.candidate.mint,
          hasQuote: Boolean(quoteResult.quote),
          failureReason: quoteResult.failureReason,
          status: quoteResult.httpStatus
        },
        'Quote result'
      );
      return { index: target.index, quoteResult };
    } catch (error) {
      return { index: target.index, quoteResult: null, error };
    }
  });

  const outcomeMap = new Map<number, { quoteResult: QuoteFetchResult | null; error?: unknown }>();
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
    reduceAdaptiveJupiterRps(rateLimitedCount);
  } else {
    recoverAdaptiveJupiterRps();
  }

  for (const pendingItem of pending) {
    const { candidate, metadata, index } = pendingItem;
    const outcome = outcomeMap.get(index) ?? { quoteResult: null, error: undefined };
    const { scanResult, trendStore: nextStore, failureCache: nextFailures } = finalizeCandidate(
      candidate,
      metadata,
      outcome.quoteResult,
      outcome.error,
      trendStore,
      failureCache,
      {
        timestamp: cycleTimestamp,
        inputDecimals,
        inputTokenSymbol
      }
    );

    trendStore = nextStore;
    failureCache = nextFailures;
    results[index] = scanResult;
  }

  trendStore = pruneTrendStore(trendStore, cycleTimestamp);
  await saveTrendStore(trendStore);
  await saveJsonCache(config.jupiter.failureCacheFile, failureCache);

  const finalizedResults = results.filter((result): result is ScanResult => result !== null);

  const failureReasonCounts = finalizedResults.reduce<Record<string, number>>((acc, result) => {
    const reason = result.decision.shouldAlert ? 'alerted' : result.decision.reason ?? 'unknown';
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});

  logger.info({ results: finalizedResults.length, failureReasons: failureReasonCounts }, 'Scan complete');

  return {
    results: finalizedResults,
    discoveryRejections
  };
};
