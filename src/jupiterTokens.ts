import axios from 'axios';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import config from './config';
import logger from './logger';
import { ensureDirectory } from './storage';
import { JupiterTokenMap, JupiterTokenMetadata, TokenCandidate } from './types';
import { httpsAgent } from './network';

interface CachedTokenList {
  fetchedAt: number;
  source: string;
  tokenCount: number;
  tokens: JupiterTokenMap;
}

const DEFAULT_FALLBACK_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERJJP7xH3gEUyXrmLitUgSBuozHWEwewTv', // USDT
  'So11111111111111111111111111111111111111112', // SOL wrapped
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z6T1gWVBq87mHam3P' // mSOL
];

const DEFAULT_METADATA_BY_MINT: Record<string, JupiterTokenMetadata> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6
  },
  Es9vMFrzaCERJJP7xH3gEUyXrmLitUgSBuozHWEwewTv: {
    address: 'Es9vMFrzaCERJJP7xH3gEUyXrmLitUgSBuozHWEwewTv',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6
  },
  So11111111111111111111111111111111111111112: {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Wrapped SOL',
    decimals: 9
  },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z6T1gWVBq87mHam3P: {
    address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z6T1gWVBq87mHam3P',
    symbol: 'mSOL',
    name: 'Marinade staked SOL',
    decimals: 9
  }
};

const BASE58_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const isValidSolanaMint = (value: string): boolean => BASE58_MINT_PATTERN.test(value);

const readCachedTokenList = async (filePath: string): Promise<CachedTokenList | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CachedTokenList;
    if (!parsed.tokens || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    if (parsed.tokenCount === undefined) {
      parsed.tokenCount = Object.keys(parsed.tokens).length;
    }
    if (!parsed.source) {
      parsed.source = config.jupiter.tokenListUrl;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.warn({ err: error, filePath }, 'Failed to read token list cache');
    return null;
  }
};

const writeCachedTokenList = async (filePath: string, tokens: JupiterTokenMap): Promise<void> => {
  await ensureDirectory(filePath);
  const payload: CachedTokenList = {
    fetchedAt: Date.now(),
    source: config.jupiter.tokenListUrl,
    tokenCount: Object.keys(tokens).length,
    tokens
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
};

const fetchTokenList = async (): Promise<JupiterTokenMap> => {
  const response = await axios.get(config.jupiter.tokenListUrl, {
    timeout: 10_000,
    httpsAgent
  });
  const tokensArray = response.data as {
    address: string;
    symbol: string;
    name?: string;
    decimals: number;
    logoURI?: string;
    tags?: string[];
  }[];

  const tokenMap: JupiterTokenMap = {};
  for (const token of tokensArray) {
    if (!token.address) {
      continue;
    }

    tokenMap[token.address] = {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      logoURI: token.logoURI,
      tags: token.tags
    };
  }

  return tokenMap;
};

const buildBootstrapTokenMap = (mints: string[]): JupiterTokenMap => {
  const tokenMap: JupiterTokenMap = {};

  for (const mint of mints) {
    const metadata = DEFAULT_METADATA_BY_MINT[mint];
    tokenMap[mint] = metadata ?? {
      address: mint,
      symbol: mint.slice(0, 4),
      name: mint.slice(0, 8),
      decimals: 9
    };
  }

  return tokenMap;
};

export const loadJupiterTokenMap = async (): Promise<JupiterTokenMap> => {
  const cacheFilePath = path.resolve(config.jupiter.tokenListCacheFile);
  const cached = await readCachedTokenList(cacheFilePath);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < config.jupiter.tokenListTtlMs) {
    logger.debug('Loaded Jupiter token metadata from cache');
    return cached.tokens;
  }

  logger.info('Refreshing Jupiter token metadata cache');
  try {
    const tokens = await fetchTokenList();
    await writeCachedTokenList(cacheFilePath, tokens);
    return tokens;
  } catch (error) {
    if (cached) {
      logger.warn({ err: error }, 'Failed to refresh Jupiter token list, falling back to cached copy');
      return cached.tokens;
    }

    logger.error(
      { err: error, tokenListUrl: config.jupiter.tokenListUrl },
      'Failed to load Jupiter token list and no cache available'
    );
    return {};
  }
};

const readWatchlist = async (filePath: string): Promise<string[]> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      logger.warn({ filePath }, 'Watchlist file must contain a JSON array of mint strings');
      return [];
    }

    const validMints: string[] = [];
    const invalidEntries: string[] = [];
    const duplicateMints = new Set<string>();
    const seenMints = new Set<string>();

    for (const entry of parsed) {
      if (typeof entry !== 'string') {
        invalidEntries.push(String(entry));
        continue;
      }

      const mint = entry.trim();
      if (!mint || !isValidSolanaMint(mint)) {
        invalidEntries.push(entry);
        continue;
      }

      if (seenMints.has(mint)) {
        duplicateMints.add(mint);
        continue;
      }

      seenMints.add(mint);
      validMints.push(mint);
    }

    if (invalidEntries.length > 0) {
      logger.warn(
        { filePath, invalidEntries: invalidEntries.slice(0, 10), invalidEntryCount: invalidEntries.length },
        'Ignoring invalid watchlist entries that are not plausible Solana mint addresses'
      );
    }

    if (duplicateMints.size > 0) {
      logger.warn(
        { filePath, duplicateMints: Array.from(duplicateMints), duplicateCount: duplicateMints.size },
        'Ignoring duplicate watchlist mints'
      );
    }

    return validMints;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn({ filePath }, 'Watchlist file not found, scanner will use top token metadata');
      return [];
    }

    logger.warn({ err: error, filePath }, 'Failed to read watchlist file');
    return [];
  }
};

export const buildTokenCandidates = async (): Promise<{
  candidates: TokenCandidate[];
  tokenMap: JupiterTokenMap;
}> => {
  const watchlist = await readWatchlist(path.resolve(config.jupiter.watchlistFile));
  let tokenMap = await loadJupiterTokenMap();

  if (Object.keys(tokenMap).length === 0 && watchlist.length > 0) {
    const bootstrapMints = Array.from(new Set([config.jupiter.inputMint, ...DEFAULT_FALLBACK_MINTS, ...watchlist]));
    tokenMap = buildBootstrapTokenMap(bootstrapMints);
    logger.warn(
      { candidates: watchlist.length, bootstrapMints: bootstrapMints.length },
      'Using watchlist/bootstrap token metadata because Jupiter token list is unavailable'
    );
  }

  const validWatchlist = watchlist.filter((mint) => tokenMap[mint]);
  const invalidWatchlist = watchlist.filter((mint) => !tokenMap[mint]);

  if (invalidWatchlist.length > 0) {
    logger.warn({ invalidWatchlist }, 'Watchlist contains mints missing from Jupiter token list');
  }

  const filteredWatchlist = validWatchlist.filter((mint) => mint !== config.jupiter.inputMint);

  if (filteredWatchlist.length !== validWatchlist.length) {
    logger.warn(
      { removedMint: config.jupiter.inputMint },
      'Removed input mint from watchlist candidates to avoid self-quotes'
    );
  }

  let selectedMints: string[] = [];

  const tokenMapIsEmpty = Object.keys(tokenMap).length === 0;

  if (filteredWatchlist.length > 0) {
    selectedMints = filteredWatchlist;
  } else if (tokenMapIsEmpty && watchlist.length > 0) {
    logger.warn('Token metadata unavailable; proceeding with watchlist mints without metadata');
    selectedMints = watchlist.filter((mint) => mint !== config.jupiter.inputMint);
  } else {
    const verifiedMints = Object.values(tokenMap)
      .filter((token) => token.tags?.includes('verified'))
      .map((token) => token.address);

    if (verifiedMints.length > 0) {
      selectedMints = verifiedMints;
    } else {
      const fallbackMints = DEFAULT_FALLBACK_MINTS.filter((mint) => tokenMap[mint]);
      if (fallbackMints.length > 0) {
        selectedMints = fallbackMints;
      } else {
        logger.warn('Falling back to full token list; consider providing a watchlist');
        selectedMints = Object.keys(tokenMap);
      }
    }
  }

  const uniqueCandidateMints = Array.from(
    new Set(selectedMints.filter((mint) => mint !== config.jupiter.inputMint))
  );

  if (uniqueCandidateMints.length !== selectedMints.length) {
    logger.debug(
      {
        removedMint: config.jupiter.inputMint,
        before: selectedMints.length,
        after: uniqueCandidateMints.length
      },
      'Sanitized candidate mint list'
    );
  }

  const candidates = uniqueCandidateMints.map((mint) => ({
    mint,
    metadata: tokenMap[mint]
  }));

  if (uniqueCandidateMints.length === 0) {
    logger.warn('No token candidates available after applying watchlist and fallbacks');
  }

  return { candidates, tokenMap };
};
