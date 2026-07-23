"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTokenCandidates = exports.loadJupiterTokenMap = void 0;
const axios_1 = __importDefault(require("axios"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const storage_1 = require("./storage");
const network_1 = require("./network");
const DEFAULT_FALLBACK_MINTS = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERJJP7xH3gEUyXrmLitUgSBuozHWEwewTv', // USDT
    'So11111111111111111111111111111111111111112', // SOL wrapped
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z6T1gWVBq87mHam3P' // mSOL
];
const DEFAULT_METADATA_BY_MINT = {
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
const isValidSolanaMint = (value) => BASE58_MINT_PATTERN.test(value);
const readCachedTokenList = async (filePath) => {
    try {
        const raw = await node_fs_1.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.tokens || typeof parsed.fetchedAt !== 'number') {
            return null;
        }
        if (parsed.tokenCount === undefined) {
            parsed.tokenCount = Object.keys(parsed.tokens).length;
        }
        if (!parsed.source) {
            parsed.source = config_1.default.jupiter.tokenListUrl;
        }
        return parsed;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        logger_1.default.warn({ err: error, filePath }, 'Failed to read token list cache');
        return null;
    }
};
const writeCachedTokenList = async (filePath, tokens) => {
    await (0, storage_1.ensureDirectory)(filePath);
    const payload = {
        fetchedAt: Date.now(),
        source: config_1.default.jupiter.tokenListUrl,
        tokenCount: Object.keys(tokens).length,
        tokens
    };
    await node_fs_1.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
};
const fetchTokenList = async () => {
    const response = await axios_1.default.get(config_1.default.jupiter.tokenListUrl, {
        timeout: 10_000,
        httpsAgent: network_1.httpsAgent
    });
    const tokensArray = response.data;
    const tokenMap = {};
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
const buildBootstrapTokenMap = (mints) => {
    const tokenMap = {};
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
const loadJupiterTokenMap = async () => {
    const cacheFilePath = node_path_1.default.resolve(config_1.default.jupiter.tokenListCacheFile);
    const cached = await readCachedTokenList(cacheFilePath);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < config_1.default.jupiter.tokenListTtlMs) {
        logger_1.default.debug('Loaded Jupiter token metadata from cache');
        return cached.tokens;
    }
    logger_1.default.info('Refreshing Jupiter token metadata cache');
    try {
        const tokens = await fetchTokenList();
        await writeCachedTokenList(cacheFilePath, tokens);
        return tokens;
    }
    catch (error) {
        if (cached) {
            logger_1.default.warn({ err: error }, 'Failed to refresh Jupiter token list, falling back to cached copy');
            return cached.tokens;
        }
        logger_1.default.error({ err: error, tokenListUrl: config_1.default.jupiter.tokenListUrl }, 'Failed to load Jupiter token list and no cache available');
        return {};
    }
};
exports.loadJupiterTokenMap = loadJupiterTokenMap;
const readWatchlist = async (filePath) => {
    try {
        const raw = await node_fs_1.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            logger_1.default.warn({ filePath }, 'Watchlist file must contain a JSON array of mint strings');
            return [];
        }
        const validMints = [];
        const invalidEntries = [];
        const duplicateMints = new Set();
        const seenMints = new Set();
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
            logger_1.default.warn({ filePath, invalidEntries: invalidEntries.slice(0, 10), invalidEntryCount: invalidEntries.length }, 'Ignoring invalid watchlist entries that are not plausible Solana mint addresses');
        }
        if (duplicateMints.size > 0) {
            logger_1.default.warn({ filePath, duplicateMints: Array.from(duplicateMints), duplicateCount: duplicateMints.size }, 'Ignoring duplicate watchlist mints');
        }
        return validMints;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            logger_1.default.warn({ filePath }, 'Watchlist file not found, scanner will use top token metadata');
            return [];
        }
        logger_1.default.warn({ err: error, filePath }, 'Failed to read watchlist file');
        return [];
    }
};
const buildTokenCandidates = async () => {
    const watchlist = await readWatchlist(node_path_1.default.resolve(config_1.default.jupiter.watchlistFile));
    let tokenMap = await (0, exports.loadJupiterTokenMap)();
    if (Object.keys(tokenMap).length === 0 && watchlist.length > 0) {
        const bootstrapMints = Array.from(new Set([config_1.default.jupiter.inputMint, ...DEFAULT_FALLBACK_MINTS, ...watchlist]));
        tokenMap = buildBootstrapTokenMap(bootstrapMints);
        logger_1.default.warn({ candidates: watchlist.length, bootstrapMints: bootstrapMints.length }, 'Using watchlist/bootstrap token metadata because Jupiter token list is unavailable');
    }
    const validWatchlist = watchlist.filter((mint) => tokenMap[mint]);
    const invalidWatchlist = watchlist.filter((mint) => !tokenMap[mint]);
    if (invalidWatchlist.length > 0) {
        logger_1.default.warn({ invalidWatchlist }, 'Watchlist contains mints missing from Jupiter token list');
    }
    const filteredWatchlist = validWatchlist.filter((mint) => mint !== config_1.default.jupiter.inputMint);
    if (filteredWatchlist.length !== validWatchlist.length) {
        logger_1.default.warn({ removedMint: config_1.default.jupiter.inputMint }, 'Removed input mint from watchlist candidates to avoid self-quotes');
    }
    let selectedMints = [];
    const tokenMapIsEmpty = Object.keys(tokenMap).length === 0;
    if (filteredWatchlist.length > 0) {
        selectedMints = filteredWatchlist;
    }
    else if (tokenMapIsEmpty && watchlist.length > 0) {
        logger_1.default.warn('Token metadata unavailable; proceeding with watchlist mints without metadata');
        selectedMints = watchlist.filter((mint) => mint !== config_1.default.jupiter.inputMint);
    }
    else {
        const verifiedMints = Object.values(tokenMap)
            .filter((token) => token.tags?.includes('verified'))
            .map((token) => token.address);
        if (verifiedMints.length > 0) {
            selectedMints = verifiedMints;
        }
        else {
            const fallbackMints = DEFAULT_FALLBACK_MINTS.filter((mint) => tokenMap[mint]);
            if (fallbackMints.length > 0) {
                selectedMints = fallbackMints;
            }
            else {
                logger_1.default.warn('Falling back to full token list; consider providing a watchlist');
                selectedMints = Object.keys(tokenMap);
            }
        }
    }
    const uniqueCandidateMints = Array.from(new Set(selectedMints.filter((mint) => mint !== config_1.default.jupiter.inputMint)));
    if (uniqueCandidateMints.length !== selectedMints.length) {
        logger_1.default.debug({
            removedMint: config_1.default.jupiter.inputMint,
            before: selectedMints.length,
            after: uniqueCandidateMints.length
        }, 'Sanitized candidate mint list');
    }
    const candidates = uniqueCandidateMints.map((mint) => ({
        mint,
        metadata: tokenMap[mint]
    }));
    if (uniqueCandidateMints.length === 0) {
        logger_1.default.warn('No token candidates available after applying watchlist and fallbacks');
    }
    return { candidates, tokenMap };
};
exports.buildTokenCandidates = buildTokenCandidates;
