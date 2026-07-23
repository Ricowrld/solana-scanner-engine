import config from './config';
import { loadJsonCache, saveJsonCache } from './storage';
import { TokenTrendHistory } from './types';

const MAX_HISTORY_MS = 60 * 60 * 1000; // 1 hour window
const MAX_MINT_STALENESS_MS = 6 * 60 * 60 * 1000; // 6 hours

export type TrendStore = Record<string, TokenTrendHistory>;

const pruneHistory = (history: TokenTrendHistory, now: number): TokenTrendHistory => {
  const filteredPoints = history.points.filter((point) => now - point.timestamp <= MAX_HISTORY_MS);
  return {
    ...history,
    points: filteredPoints
  };
};

export const loadTrendStore = async (): Promise<TrendStore> => {
  const fallback: TrendStore = {};
  return loadJsonCache(config.trendCacheFile, fallback);
};

export const saveTrendStore = async (store: TrendStore): Promise<void> => {
  await saveJsonCache(config.trendCacheFile, store);
};

export const pruneTrendStore = (store: TrendStore, now: number): TrendStore => {
  const nextStore: TrendStore = {
    ...store
  };

  for (const key of Object.keys(nextStore)) {
    const history = nextStore[key];
    const lastPoint = history.points.at(-1);
    const observationStart = history.firstSeenAt ?? lastPoint?.timestamp;

    if (!lastPoint) {
      if (!observationStart || now - observationStart > MAX_MINT_STALENESS_MS) {
        delete nextStore[key];
      }
      continue;
    }

    if (now - lastPoint.timestamp > MAX_MINT_STALENESS_MS) {
      delete nextStore[key];
    }
  }

  return nextStore;
};

export const updateTrendStore = (
  store: TrendStore,
  mint: string,
  priceQuote: number,
  timestamp: number
): TrendStore => {
  const history = store[mint] ?? { mint, points: [] };
  const updatedHistory: TokenTrendHistory = {
    mint,
    firstSeenAt: history.firstSeenAt ?? history.points[0]?.timestamp ?? timestamp,
    points: [...history.points, { timestamp, priceQuote }]
  };

  const pruned = pruneHistory(updatedHistory, timestamp);
  const nextStore: TrendStore = pruneTrendStore(
    {
      ...store,
      [mint]: pruned
    },
    timestamp
  );

  return nextStore;
};

export const getTrendObservationAgeMs = (
  history: TokenTrendHistory | undefined,
  now: number
): number | undefined => {
  if (!history) {
    return undefined;
  }

  const firstSeenAt = history.firstSeenAt ?? history.points[0]?.timestamp;
  if (!firstSeenAt) {
    return undefined;
  }

  return Math.max(0, now - firstSeenAt);
};

export const calculateChangePercent = (
  history: TokenTrendHistory | undefined,
  now: number,
  windowMs: number
): number => {
  if (!history || history.points.length < 2) {
    return 0;
  }

  const cutoff = now - windowMs;
  const latest = history.points[history.points.length - 1];

  const baseline = [...history.points].reverse().find((point) => point.timestamp <= cutoff);

  if (!baseline || baseline.priceQuote <= 0) {
    return 0;
  }

  const current = latest;
  return ((current.priceQuote - baseline.priceQuote) / baseline.priceQuote) * 100;
};

export const calculateChangePercentOverMinutes = (
  history: TokenTrendHistory | undefined,
  now: number,
  minutes: number
): number => {
  return calculateChangePercent(history, now, minutes * 60 * 1000);
};
