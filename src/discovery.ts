import axios, { AxiosError, AxiosInstance } from 'axios';

import config from './config';
import logger from './logger';
import { httpsAgent } from './network';
import type { DiscoveryCandidate, DiscoveryRejection, DiscoverySource } from './types';

const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so/defi';
const BIRDEYE_TRENDING_URL = `${BIRDEYE_BASE_URL}/token_trending`;
const BIRDEYE_TOKEN_OVERVIEW_URL = `${BIRDEYE_BASE_URL}/token_overview`;
const BIRDEYE_TOKEN_SECURITY_URL = `${BIRDEYE_BASE_URL}/token_security`;
const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';

const BIRDEYE_MIN_TRENDING_LIMIT = 1;
const BIRDEYE_PAGE_LIMIT = 20;
const DETAIL_FETCH_CONCURRENCY = 3;
const MS_IN_MINUTE = 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_BIRDEYE_RETRY_ATTEMPTS = 2;

type UnknownRecord = Record<string, any>;
type NullableRecord = UnknownRecord | null;

interface FilterFailure {
  key: string;
  message: string;
}

interface FilterEvaluation {
  passes: boolean;
  conditions: Record<string, boolean | null>;
  failures: FilterFailure[];
  warnings: string[];
  score: number;
}

interface BirdeyeTrendingCacheEntry {
  fetchedAt: number;
  tokens: UnknownRecord[];
}

interface EndpointCacheEntry {
  fetchedAt: number;
  items: UnknownRecord[];
}

interface DiscoverySeed {
  token: UnknownRecord;
  sources: DiscoverySource[];
}

let birdeyeTrendingCache: BirdeyeTrendingCacheEntry | null = null;
let birdeyeRequestQueue: Promise<void> = Promise.resolve();
let birdeyeNextRequestAt = 0;
let dexscreenerTrendingCache: EndpointCacheEntry | null = null;
let dexscreenerBoostedCache: EndpointCacheEntry | null = null;

const toNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
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

const normalizeMint = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const extractMint = (record: UnknownRecord | null | undefined): string | undefined => {
  return normalizeMint(
    record?.address ??
      record?.mint ??
      record?.tokenAddress ??
      record?.baseToken?.address ??
      record?.token?.address
  );
};

const computeRatio = (numerator: number | undefined, denominator: number | undefined): number | undefined => {
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }

  return numerator / denominator;
};

const mergeSources = (
  existing: DiscoverySource[] | undefined,
  incoming: DiscoverySource[]
): DiscoverySource[] => {
  const merged = new Set<DiscoverySource>([...(existing ?? []), ...incoming]);
  return Array.from(merged);
};

const coerceTimestampMs = (value: unknown): number | undefined => {
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

const computeAgeMinutes = (timestampMs: number | undefined): number | undefined => {
  if (!timestampMs) {
    return undefined;
  }

  const ageMs = Date.now() - timestampMs;
  if (ageMs <= 0) {
    return undefined;
  }

  return ageMs / MS_IN_MINUTE;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const extractArrayPayload = (payload: UnknownRecord): UnknownRecord[] => {
  const candidateArrays = [
    payload?.pairs,
    payload?.tokens,
    payload?.data?.pairs,
    payload?.data?.tokens,
    payload?.data?.items,
    payload?.items,
    payload?.results,
    Array.isArray(payload) ? payload : undefined
  ];

  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) {
      return candidate as UnknownRecord[];
    }
  }

  return [];
};

const extractTxnCount = (
  record: UnknownRecord | null,
  window: 'm5' | 'h1',
  side: 'buys' | 'sells'
): number | undefined => {
  return toNumber(
    record?.txns?.[window]?.[side] ??
      record?.transactions?.[window]?.[side] ??
      record?.[`${side}${window.toUpperCase()}`]
  );
};

const sumTopHolderPercent = (
  holders: DiscoveryCandidate['topHolders'],
  limit: number
): number | undefined => {
  if (!holders || holders.length === 0) {
    return undefined;
  }

  const total = holders
    .slice(0, limit)
    .reduce((acc, holder) => acc + (Number.isFinite(holder.percent) ? holder.percent : 0), 0);

  return total > 0 ? total : undefined;
};

const calculateBuySellRatio = (buys: number | undefined, sells: number | undefined): number | undefined => {
  if (buys === undefined || !Number.isFinite(buys)) {
    return undefined;
  }

  if (sells === undefined || sells <= 0) {
    return buys > 0 ? buys : undefined;
  }

  return buys / sells;
};

const getRetryAfterMs = (error: unknown): number => {
  if (!axios.isAxiosError(error)) {
    return DEFAULT_RETRY_AFTER_SECONDS * 1000;
  }

  const retryAfterHeader = error.response?.headers?.['retry-after'];
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return DEFAULT_RETRY_AFTER_SECONDS * 1000;
};

const isRateLimitError = (error: unknown): error is AxiosError => {
  return axios.isAxiosError(error) && error.response?.status === 429;
};

const withBirdeyeRateLimit = async <T>(
  label: string,
  handler: () => Promise<T>
): Promise<T> => {
  let releaseQueue!: () => void;
  const priorRequest = birdeyeRequestQueue;
  birdeyeRequestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await priorRequest;

  try {
    for (let attempt = 1; attempt <= MAX_BIRDEYE_RETRY_ATTEMPTS; attempt += 1) {
      const waitMs = Math.max(0, birdeyeNextRequestAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      try {
        const result = await handler();
        birdeyeNextRequestAt = Date.now() + Math.max(0, config.discovery.birdeye.minIntervalMs);
        return result;
      } catch (error) {
        if (!isRateLimitError(error) || attempt >= MAX_BIRDEYE_RETRY_ATTEMPTS) {
          throw error;
        }

        const retryAfterMs = Math.max(
          getRetryAfterMs(error),
          Math.max(0, config.discovery.birdeye.minIntervalMs)
        );
        birdeyeNextRequestAt = Date.now() + retryAfterMs;

        logger.warn(
          {
            label,
            attempt,
            retryAfterMs,
            statusCode: error.response?.status
          },
          'Birdeye rate limited request; backing off'
        );
      }
    }

    throw new Error(`Birdeye request failed without returning data: ${label}`);
  } finally {
    releaseQueue();
  }
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        break;
      }

      try {
        results[index] = await handler(items[index], index);
      } catch (error) {
        throw error;
      }
    }
  });

  await Promise.all(workers);
  return results;
};

const createBirdeyeClient = (apiKey: string): AxiosInstance =>
  axios.create({
    baseURL: BIRDEYE_BASE_URL,
    headers: {
      'x-chain': 'solana',
      'X-API-KEY': apiKey
    },
    httpsAgent
  });

const fetchDexScreenerDiscoveryList = async (
  url: string,
  limit: number,
  label: DiscoverySource,
  cache: EndpointCacheEntry | null
): Promise<UnknownRecord[]> => {
  const cacheTtlMs = Math.max(0, config.discovery.dexscreener.cacheTtlMs);
  if (cache && cacheTtlMs > 0 && Date.now() - cache.fetchedAt < cacheTtlMs && cache.items.length > 0) {
    return cache.items.slice(0, limit);
  }

  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 7_000
    });
    const items = extractArrayPayload(response.data ?? {}).slice(0, limit);
    if (items.length === 0) {
      logger.warn({ label, payload: response.data }, 'DexScreener discovery response contained no items');
    }
    return items;
  } catch (err) {
    logger.warn({ err, label, url }, 'Failed to fetch DexScreener discovery list');
    return cache?.items.slice(0, limit) ?? [];
  }
};

const fetchBirdeyeTrending = async (
  client: AxiosInstance,
  limit: number
): Promise<UnknownRecord[]> => {
  const targetLimit = Math.max(BIRDEYE_MIN_TRENDING_LIMIT, Math.trunc(limit));
  const cacheTtlMs = Math.max(0, config.discovery.birdeye.cacheTtlMs);
  if (
    birdeyeTrendingCache &&
    cacheTtlMs > 0 &&
    Date.now() - birdeyeTrendingCache.fetchedAt < cacheTtlMs &&
    birdeyeTrendingCache.tokens.length > 0
  ) {
    return birdeyeTrendingCache.tokens.slice(0, targetLimit);
  }

  const tokens: UnknownRecord[] = [];
  const seenMints = new Set<string>();

  try {
    for (let offset = 0; tokens.length < targetLimit; offset += BIRDEYE_PAGE_LIMIT) {
      const pageLimit = Math.min(BIRDEYE_PAGE_LIMIT, targetLimit - tokens.length);
      const response = await withBirdeyeRateLimit(`token_trending:${offset}`, () =>
        client.get(BIRDEYE_TRENDING_URL, {
          params: {
            limit: pageLimit,
            offset
          }
        })
      );

      const pageTokens = response.data?.data?.tokens;
      if (!Array.isArray(pageTokens)) {
        logger.warn(
          { limit: pageLimit, offset, payload: response.data },
          'Birdeye trending response did not contain token list'
        );
        break;
      }

      if (pageTokens.length === 0) {
        if (offset === 0) {
          logger.warn({ payload: response.data }, 'Birdeye trending response contained no tokens');
        }
        break;
      }

      for (const token of pageTokens as UnknownRecord[]) {
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
  } catch (err) {
    if (birdeyeTrendingCache?.tokens.length) {
      logger.warn(
        {
          err,
          cachedCount: birdeyeTrendingCache.tokens.length
        },
        'Falling back to cached Birdeye trending tokens after fetch failure'
      );
      return birdeyeTrendingCache.tokens.slice(0, targetLimit);
    }

    throw err;
  }

  birdeyeTrendingCache = {
    fetchedAt: Date.now(),
    tokens: tokens.slice()
  };

  return tokens;
};

const fetchTokenOverview = async (
  client: AxiosInstance,
  mint: string
): Promise<NullableRecord> => {
  try {
    const response = await withBirdeyeRateLimit(`token_overview:${mint}`, () =>
      client.get(BIRDEYE_TOKEN_OVERVIEW_URL, {
        params: {
          address: mint
        }
      })
    );

    return (response.data?.data ?? null) as UnknownRecord | null;
  } catch (err) {
    logger.debug({ err, mint }, 'Failed to fetch Birdeye token overview');
    return null;
  }
};

const fetchTokenSecurity = async (
  client: AxiosInstance,
  mint: string
): Promise<NullableRecord> => {
  try {
    const response = await withBirdeyeRateLimit(`token_security:${mint}`, () =>
      client.get(BIRDEYE_TOKEN_SECURITY_URL, {
        params: {
          address: mint
        }
      })
    );

    return (response.data?.data ?? null) as UnknownRecord | null;
  } catch (err) {
    logger.debug({ err, mint }, 'Failed to fetch Birdeye token security');
    return null;
  }
};

const fetchDexScreenerPair = async (mint: string): Promise<UnknownRecord | null> => {
  try {
    const response = await axios.get(`${DEXSCREENER_TOKEN_URL}/${mint}`);
    const pairs = response.data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return null;
    }

    const sorted = [...pairs].sort((a, b) => {
      const aLiquidity = toNumber(a?.liquidity?.usd) ?? 0;
      const bLiquidity = toNumber(b?.liquidity?.usd) ?? 0;
      return bLiquidity - aLiquidity;
    });

    return (sorted[0] ?? null) as UnknownRecord | null;
  } catch (err) {
    logger.debug({ err, mint }, 'Failed to fetch DexScreener pair data');
    return null;
  }
};

const extractTopHolders = (security: UnknownRecord | null): DiscoveryCandidate['topHolders'] => {
  const raw = security?.top_holders ?? security?.topHolders;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const holders = raw
    .map((entry: UnknownRecord) => {
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
    .filter((entry): entry is { address: string; percent: number } => Boolean(entry));

  return holders.length > 0 ? holders : undefined;
};

const buildDiscoveryCandidate = async (
  client: AxiosInstance | null,
  token: UnknownRecord,
  sources: DiscoverySource[]
): Promise<DiscoveryCandidate | null> => {
  const mint = extractMint(token);
  if (!mint || typeof mint !== 'string') {
    return null;
  }

  const shouldFetchBirdeyeDetails = !config.discovery.filters.allowMissingSecurityData && Boolean(client);
  const dexscreenerSeed =
    token?.pairAddress || token?.baseToken?.address || token?.txns || token?.liquidity ? token : null;
  const [overview, security, dexscreener] = await Promise.all([
    shouldFetchBirdeyeDetails && client ? fetchTokenOverview(client, mint) : Promise.resolve(null),
    shouldFetchBirdeyeDetails && client ? fetchTokenSecurity(client, mint) : Promise.resolve(null),
    dexscreenerSeed ? Promise.resolve(dexscreenerSeed) : fetchDexScreenerPair(mint)
  ]);

  const liquidityUsd =
    toNumber(token?.liquidityUsd ?? token?.liquidity_usd ?? token?.liquidity) ??
    toNumber(overview?.liquidityUsd ?? overview?.liquidity_usd ?? overview?.liquidity) ??
    toNumber(dexscreener?.liquidity?.usd);

  const volume1hUsd =
    toNumber(token?.volume1hUsd ?? token?.volume_1h ?? token?.volumeUsd1h) ??
    toNumber(overview?.volume1hUsd ?? overview?.volumeUsd1h ?? overview?.volume_1h) ??
    toNumber(dexscreener?.volume?.h1 ?? dexscreener?.volume1h ?? dexscreener?.volume24h);

  const marketCapUsd =
    toNumber(token?.marketCapUsd ?? token?.market_cap ?? token?.fdv) ??
    toNumber(overview?.marketCap ?? overview?.market_cap ?? overview?.fdv ?? overview?.fully_diluted_valuation) ??
    toNumber(dexscreener?.fdv ?? dexscreener?.marketCap);

  const holderCount =
    toNumber(token?.holderCount ?? token?.holder ?? token?.holders) ??
    toNumber(overview?.holderCount ?? overview?.holders ?? overview?.holder) ??
    toNumber(security?.holder_count ?? security?.holders);

  const topHolderPercent =
    toNumber(security?.top_holder_percent ?? security?.topHolderPercent) ??
    toNumber(security?.top_holders?.[0]?.percentage ?? security?.topHolders?.[0]?.percent);

  const topHolders = extractTopHolders(security);
  const top10HolderPercent = sumTopHolderPercent(topHolders, 10);

  const creatorHoldPercent = toNumber(security?.creator_hold_percent ?? security?.creatorHoldPercent);

  const mintAuthority = security?.mint_authority ?? security?.mintAuthority;
  const freezeAuthority = security?.freeze_authority ?? security?.freezeAuthority;
  const txns5mBuys = extractTxnCount(dexscreener, 'm5', 'buys');
  const txns5mSells = extractTxnCount(dexscreener, 'm5', 'sells');
  const volumeToLiquidityRatio = computeRatio(volume1hUsd, liquidityUsd);
  const marketCapToLiquidityRatio = computeRatio(marketCapUsd, liquidityUsd);
  const buySellRatio = calculateBuySellRatio(txns5mBuys, txns5mSells);

  const candidate: DiscoveryCandidate = {
    mint,
    pairAddress: dexscreener?.pairAddress,
    symbol: token?.symbol ?? overview?.symbol,
    name: token?.name ?? overview?.name,
    priceUsd: toNumber(token?.priceUsd ?? token?.price_usd ?? token?.price ?? overview?.priceUsd ?? overview?.price),
    liquidityUsd,
    volume1hUsd,
    marketCapUsd,
    ageMinutes: computeAgeMinutes(
      coerceTimestampMs(
        token?.pairCreatedAt ?? token?.pair_created_at ?? token?.created_at ??
          overview?.pairCreatedAt ?? overview?.created_at ??
          security?.pair_created_at ?? security?.created_at ??
          dexscreener?.pairCreatedAt ?? dexscreener?.createdAt
      )
    ),
    txns5mBuys,
    txns5mSells,
    buySellRatio,
    volumeToLiquidityRatio,
    marketCapToLiquidityRatio,
    holderCount,
    priceChange5mPercent: toNumber(
      token?.priceChange5mPercent ?? token?.price_change_5m_percent ??
        token?.price_change_5m ?? dexscreener?.priceChange?.m5 ?? dexscreener?.priceChange5m
    ),
    priceChange1hPercent: toNumber(
      token?.priceChange1hPercent ?? token?.price_change_1h_percent ??
        token?.price_change_1h ?? dexscreener?.priceChange?.h1 ?? dexscreener?.priceChange1h
    ),
    topHolderPercent,
    top10HolderPercent,
    creatorHoldPercent,
    hasMintAuthority: mintAuthority ? true : false,
    hasFreezeAuthority: freezeAuthority ? true : false,
    liquidityLocked: toBoolean(dexscreener?.liquidity?.locked) ?? toBoolean(dexscreener?.liquidityLocked) ?? undefined,
    liquidityBurned: toBoolean(dexscreener?.liquidity?.burned) ?? toBoolean(dexscreener?.liquidityBurned) ?? undefined,
    creatorAddress: security?.creator ?? security?.creator_address ?? overview?.creator ?? undefined,
    isHoneypot: Boolean(security?.is_honeypot ?? security?.honeypot ?? false),
    topHolders,
    sources
  };

  return candidate;
};

const fetchDiscoverySeeds = async (
  birdeyeClient: AxiosInstance | null
): Promise<{ requested: number; seeds: DiscoverySeed[] }> => {
  const seedsByMint = new Map<string, DiscoverySeed>();
  let requested = 0;

  if (config.discovery.birdeye.enabled && birdeyeClient) {
    const normalizedTrendingLimit = Math.max(
      BIRDEYE_MIN_TRENDING_LIMIT,
      Math.trunc(config.discovery.birdeye.trendingLimit)
    );
    requested += normalizedTrendingLimit;
    const birdeyeTokens = await fetchBirdeyeTrending(birdeyeClient, normalizedTrendingLimit);
    for (const token of birdeyeTokens) {
      const mint = extractMint(token);
      if (!mint) {
        continue;
      }

      const existing = seedsByMint.get(mint);
      if (existing) {
        existing.sources = mergeSources(existing.sources, ['birdeye_trending']);
        continue;
      }

      seedsByMint.set(mint, {
        token,
        sources: ['birdeye_trending']
      });
    }
  }

  if (config.discovery.dexscreener.enabled) {
    const trendingLimit = Math.max(0, Math.trunc(config.discovery.dexscreener.trendingLimit));
    const boostedLimit = Math.max(0, Math.trunc(config.discovery.dexscreener.boostedLimit));

    if (trendingLimit > 0) {
      requested += trendingLimit;
      const trendingItems = await fetchDexScreenerDiscoveryList(
        config.discovery.dexscreener.trendingUrl,
        trendingLimit,
        'dexscreener_trending',
        dexscreenerTrendingCache
      );
      dexscreenerTrendingCache = { fetchedAt: Date.now(), items: trendingItems.slice() };

      for (const token of trendingItems) {
        const mint = extractMint(token);
        if (!mint) {
          continue;
        }

        const existing = seedsByMint.get(mint);
        if (existing) {
          existing.sources = mergeSources(existing.sources, ['dexscreener_trending']);
          continue;
        }

        seedsByMint.set(mint, {
          token,
          sources: ['dexscreener_trending']
        });
      }
    }

    if (boostedLimit > 0) {
      requested += boostedLimit;
      const boostedItems = await fetchDexScreenerDiscoveryList(
        config.discovery.dexscreener.boostedUrl,
        boostedLimit,
        'dexscreener_boosted',
        dexscreenerBoostedCache
      );
      dexscreenerBoostedCache = { fetchedAt: Date.now(), items: boostedItems.slice() };

      for (const token of boostedItems) {
        const mint = extractMint(token);
        if (!mint) {
          continue;
        }

        const existing = seedsByMint.get(mint);
        if (existing) {
          existing.sources = mergeSources(existing.sources, ['dexscreener_boosted']);
          continue;
        }

        seedsByMint.set(mint, {
          token,
          sources: ['dexscreener_boosted']
        });
      }
    }
  }

  return {
    requested,
    seeds: Array.from(seedsByMint.values())
  };
};

const evaluateDiscoveryFilters = (candidate: DiscoveryCandidate): FilterEvaluation => {
  const { filters } = config.discovery;
  const reasons: FilterFailure[] = [];
  const warnings: string[] = [];
  const summary: Record<string, boolean | null> = {};
  let score = 0;

  const compareNumber = (
    value: number | undefined,
    threshold: number,
    comparator: (a: number, b: number) => boolean,
    key: string,
    message: string,
    allowMissing = true
  ) => {
    if (value === undefined) {
      if (!allowMissing) {
        reasons.push({ key, message });
        summary[key] = null;
      } else {
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

  const checkBooleanRequirement = (
    value: boolean | undefined,
    requiredState: boolean,
    key: string,
    message: string
  ) => {
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

  const awardPoints = (key: string, points: number) => {
    if (summary[key] === true) {
      score += points;
    }
  };

  compareNumber(
    candidate.liquidityUsd,
    filters.minLiquidityUsd,
    (a, b) => a >= b,
    'liquidity',
    'Liquidity below minimum'
  );
  compareNumber(
    candidate.volume1hUsd,
    filters.minVolume1hUsd,
    (a, b) => a >= b,
    'volume1h',
    'Volume 1h below minimum'
  );
  compareNumber(
    candidate.marketCapUsd,
    filters.minMarketCapUsd,
    (a, b) => a >= b,
    'marketCap',
    'Market cap below minimum'
  );
  compareNumber(
    candidate.priceChange5mPercent,
    filters.minPriceChange5mPercent,
    (a, b) => a >= b,
    'momentum5m',
    'Momentum below minimum'
  );
  compareNumber(
    candidate.ageMinutes,
    filters.minAgeMinutes,
    (a, b) => a >= b,
    'ageMinutes',
    'Token age below minimum',
    !filters.allowMissingSecurityData
  );
  if (filters.maxAgeMinutes > 0) {
    compareNumber(
      candidate.ageMinutes,
      filters.maxAgeMinutes,
      (a, b) => a <= b,
      'ageWindowMax',
      'Token age above maximum',
      !filters.allowMissingSecurityData
    );
  }
  compareNumber(
    candidate.holderCount,
    filters.minHolderCount,
    (a, b) => a >= b,
    'holderCount',
    'Holder count below minimum',
    !filters.allowMissingSecurityData
  );
  compareNumber(
    candidate.volumeToLiquidityRatio,
    filters.minVolumeToLiquidityRatio,
    (a, b) => a >= b,
    'volumeLiquidityMin',
    'Volume/liquidity ratio below minimum'
  );
  compareNumber(
    candidate.volumeToLiquidityRatio,
    filters.maxVolumeToLiquidityRatio,
    (a, b) => a <= b,
    'volumeLiquidityMax',
    'Volume/liquidity ratio above maximum'
  );
  compareNumber(
    candidate.marketCapToLiquidityRatio,
    filters.maxMarketCapToLiquidityRatio,
    (a, b) => a <= b,
    'fdvLiquidity',
    'FDV/liquidity ratio above maximum'
  );
  compareNumber(
    candidate.buySellRatio,
    filters.minBuySellRatio,
    (a, b) => a >= b,
    'buySellRatio5m',
    '5m buy/sell ratio below minimum'
  );

  if (filters.maxCreatorHoldPercent >= 0) {
    compareNumber(
      candidate.creatorHoldPercent,
      filters.maxCreatorHoldPercent,
      (a, b) => a <= b,
      'creatorConcentration',
      'Creator holding exceeds maximum',
      !filters.allowMissingSecurityData
    );
  }

  if (filters.maxTopHolderPercent >= 0) {
    compareNumber(
      candidate.topHolderPercent,
      filters.maxTopHolderPercent,
      (a, b) => a <= b,
      'topHolderConcentration',
      'Top holder concentration exceeds maximum',
      !filters.allowMissingSecurityData
    );
  }

  if (filters.maxTop10HolderPercent >= 0) {
    compareNumber(
      candidate.top10HolderPercent,
      filters.maxTop10HolderPercent,
      (a, b) => a <= b,
      'top10HolderConcentration',
      'Top 10 holder concentration exceeds maximum',
      !filters.allowMissingSecurityData
    );
  }

  if (filters.requireMintAuthorityDisabled) {
    checkBooleanRequirement(
      candidate.hasMintAuthority === undefined ? undefined : !candidate.hasMintAuthority,
      true,
      'mintAuthorityDisabled',
      'Mint authority still enabled'
    );
  }

  if (filters.requireFreezeAuthorityDisabled) {
    checkBooleanRequirement(
      candidate.hasFreezeAuthority === undefined ? undefined : !candidate.hasFreezeAuthority,
      true,
      'freezeAuthorityDisabled',
      'Freeze authority still enabled'
    );
  }

  if (filters.requireLiquidityLockOrBurn) {
    if (candidate.liquidityLocked === undefined && candidate.liquidityBurned === undefined) {
      summary.liquidityLockOrBurn = null;
      warnings.push('LP lock/burn data unavailable');
    } else {
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
  } else {
    summary.honeypot = candidate.isHoneypot === undefined ? null : true;
  }

  awardPoints('liquidity', 12);
  awardPoints('volume1h', 12);
  awardPoints('marketCap', 6);
  awardPoints('momentum5m', 10);
  awardPoints('ageMinutes', 6);
  awardPoints('ageWindowMax', 6);
  awardPoints('holderCount', 8);
  awardPoints('volumeLiquidityMin', 8);
  awardPoints('volumeLiquidityMax', 8);
  awardPoints('fdvLiquidity', 10);
  awardPoints('buySellRatio5m', 10);
  awardPoints('creatorConcentration', 4);
  awardPoints('topHolderConcentration', 4);
  awardPoints('top10HolderConcentration', 6);
  awardPoints('mintAuthorityDisabled', 3);
  awardPoints('freezeAuthorityDisabled', 3);
  awardPoints('honeypot', 4);

  candidate.discoveryScore = score;
  const scorePasses = score >= filters.minDiscoveryScore;
  summary.discoveryScore = scorePasses;
  if (!scorePasses) {
    reasons.push({
      key: 'discoveryScore',
      message: `Discovery score ${score} below minimum ${filters.minDiscoveryScore}`
    });
  }

  const passes = reasons.length === 0;

  if (!passes) {
    logger.debug({ mint: candidate.mint, reasons, score }, 'Rejected discovery candidate');
  }

  return {
    passes,
    conditions: summary,
    failures: reasons,
    warnings,
    score
  };
};

interface DiscoveryFetchResult {
  accepted: DiscoveryCandidate[];
  rejected: DiscoveryRejection[];
}

export async function fetchTrendingTokens(): Promise<DiscoveryFetchResult> {
  if (!config.discovery.enabled) {
    logger.debug('Discovery disabled in configuration');
    return { accepted: [], rejected: [] };
  }

  const apiKey = process.env.BIRDEYE_API_KEY?.trim();
  const birdeyeClient =
    config.discovery.birdeye.enabled && apiKey ? createBirdeyeClient(apiKey) : null;

  if (config.discovery.birdeye.enabled && !birdeyeClient) {
    logger.warn('BIRDEYE_API_KEY is not set; Birdeye discovery will be skipped');
  }

  if (!config.discovery.birdeye.enabled && !config.discovery.dexscreener.enabled) {
    logger.debug('All discovery sources are disabled in configuration');
    return { accepted: [], rejected: [] };
  }

  try {
    const { requested, seeds } = await fetchDiscoverySeeds(birdeyeClient);

    if (seeds.length === 0) {
      return { accepted: [], rejected: [] };
    }

    const candidates = await runWithConcurrency(seeds, DETAIL_FETCH_CONCURRENCY, (seed) =>
      buildDiscoveryCandidate(birdeyeClient, seed.token, seed.sources)
    );

    const evaluatedCandidates = candidates
      .filter((candidate): candidate is DiscoveryCandidate => Boolean(candidate))
      .map((candidate) => {
        const evaluation = evaluateDiscoveryFilters(candidate);
        return {
          candidate,
          evaluation
        };
      });

    const maxDiscoveryCandidates = Math.max(0, Math.trunc(config.discovery.topDiscoveryCandidates));
    const rankedCandidates = evaluatedCandidates
      .filter(({ evaluation }) => evaluation.passes)
      .sort((a, b) => {
        const scoreDelta = b.evaluation.score - a.evaluation.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        const liquidityDelta = (b.candidate.liquidityUsd ?? 0) - (a.candidate.liquidityUsd ?? 0);
        if (liquidityDelta !== 0) {
          return liquidityDelta;
        }

        return (b.candidate.volume1hUsd ?? 0) - (a.candidate.volume1hUsd ?? 0);
      });

    const cappedCandidates =
      maxDiscoveryCandidates > 0 ? rankedCandidates.slice(0, maxDiscoveryCandidates) : rankedCandidates;

    const validCandidates = cappedCandidates.map(({ candidate, evaluation }) => ({
      ...candidate,
      discoveryScore: evaluation.score,
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
        discoveryScore: evaluation.score,
        reasons: evaluation.failures.map((failure) => failure.message),
        warnings: evaluation.warnings,
        summary: evaluation.conditions,
        sources: candidate.sources ?? ['watchlist'],
        liquidityUsd: candidate.liquidityUsd,
        volume1hUsd: candidate.volume1hUsd,
        marketCapUsd: candidate.marketCapUsd,
        ageMinutes: candidate.ageMinutes,
        holderCount: candidate.holderCount
      }));

    const rejectedCount = rejectedCandidates.length;
    const rejectionDetails = rejectedCandidates
      .slice(0, config.discovery.rejectionLogSampleSize)
      .map((rejection) => ({ mint: rejection.mint, reasons: rejection.reasons, warnings: rejection.warnings }));

    logger.info(
      {
        requested,
        fetched: seeds.length,
        evaluated: evaluatedCandidates.length,
        acceptedBeforeCap: rankedCandidates.length,
        accepted: validCandidates.length,
        topDiscoveryCandidates: maxDiscoveryCandidates > 0 ? maxDiscoveryCandidates : 'unbounded',
        rejected: rejectedCount,
        samples: rejectionDetails
      },
      'Discovery evaluation complete'
    );

    return { accepted: validCandidates, rejected: rejectedCandidates };
  } catch (err) {
    logger.error({ err }, 'Failed to fetch discovery candidates');
    return { accepted: [], rejected: [] };
  }
}
