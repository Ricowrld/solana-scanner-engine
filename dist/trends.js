"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateChangePercentOverMinutes = exports.calculateChangePercent = exports.updateTrendStore = exports.saveTrendStore = exports.loadTrendStore = void 0;
const config_1 = __importDefault(require("./config"));
const storage_1 = require("./storage");
const MAX_HISTORY_MS = 60 * 60 * 1000; // 1 hour window
const MAX_MINT_STALENESS_MS = 6 * 60 * 60 * 1000; // 6 hours
const pruneHistory = (history, now) => {
    const filteredPoints = history.points.filter((point) => now - point.timestamp <= MAX_HISTORY_MS);
    return {
        ...history,
        points: filteredPoints
    };
};
const loadTrendStore = async () => {
    const fallback = {};
    return (0, storage_1.loadJsonCache)(config_1.default.trendCacheFile, fallback);
};
exports.loadTrendStore = loadTrendStore;
const saveTrendStore = async (store) => {
    await (0, storage_1.saveJsonCache)(config_1.default.trendCacheFile, store);
};
exports.saveTrendStore = saveTrendStore;
const updateTrendStore = (store, mint, priceQuote, timestamp) => {
    const history = store[mint] ?? { mint, points: [] };
    const updatedHistory = {
        mint,
        points: [...history.points, { timestamp, priceQuote }]
    };
    const pruned = pruneHistory(updatedHistory, timestamp);
    const nextStore = {
        ...store,
        [mint]: pruned
    };
    for (const key of Object.keys(nextStore)) {
        const lastPoint = nextStore[key].points.at(-1);
        if (!lastPoint || timestamp - lastPoint.timestamp > MAX_MINT_STALENESS_MS) {
            delete nextStore[key];
        }
    }
    return nextStore;
};
exports.updateTrendStore = updateTrendStore;
const calculateChangePercent = (history, now, windowMs) => {
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
exports.calculateChangePercent = calculateChangePercent;
const calculateChangePercentOverMinutes = (history, now, minutes) => {
    return (0, exports.calculateChangePercent)(history, now, minutes * 60 * 1000);
};
exports.calculateChangePercentOverMinutes = calculateChangePercentOverMinutes;
