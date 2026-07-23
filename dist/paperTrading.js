"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPaperTradingEngine = void 0;
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const storage_1 = require("./storage");
const HISTORY_LIMIT = Math.max(0, config_1.default.paperTrading.historyLimit);
const now = () => Date.now();
const clampPositionValue = (balanceUsd) => {
    if (balanceUsd <= 0) {
        return 0;
    }
    const upperBound = Math.min(balanceUsd, config_1.default.paperTrading.maxPositionUsd);
    const lowerBound = Math.min(config_1.default.paperTrading.minPositionUsd, upperBound);
    const fractionTarget = balanceUsd * config_1.default.paperTrading.positionFractionOfBalance;
    const target = Math.min(Math.max(fractionTarget, lowerBound), upperBound);
    return Math.max(target, 0);
};
const selectSellFills = (history) => {
    return history.filter((fill) => fill.action === 'sell');
};
const evaluateExitDecision = (position, price, timestamp) => {
    const currentValue = price * position.quantity;
    const pnlUsd = currentValue - position.entryValueUsd;
    const pnlPercent = position.entryValueUsd > 0 ? (pnlUsd / position.entryValueUsd) * 100 : 0;
    const holdTimeMs = Math.max(0, timestamp - position.entryTimestamp);
    const holdMinutes = holdTimeMs / 60000;
    let reason;
    if (pnlPercent >= config_1.default.paperTrading.takeProfitPercent) {
        reason = 'take_profit';
    }
    if (!reason) {
        const peakPrice = position.peakPrice ?? position.entryPrice;
        if (config_1.default.paperTrading.trailingStopPercent > 0 && peakPrice > 0) {
            const dropPercent = ((price - peakPrice) / peakPrice) * 100;
            if (dropPercent <= -config_1.default.paperTrading.trailingStopPercent) {
                reason = 'trailing_stop';
            }
        }
    }
    if (!reason && pnlPercent <= config_1.default.paperTrading.stopLossPercent) {
        reason = 'stop_loss';
    }
    if (!reason && config_1.default.paperTrading.maxHoldMinutes > 0 && holdMinutes >= config_1.default.paperTrading.maxHoldMinutes) {
        reason = 'max_hold';
    }
    return {
        shouldExit: Boolean(reason),
        reason,
        pnlUsd,
        pnlPercent,
        holdTimeMs
    };
};
const computeTradeAnalytics = (history) => {
    const sells = selectSellFills(history);
    if (sells.length === 0) {
        return {
            tradeCount: 0,
            winRatePercent: 0,
            averageHoldMinutes: 0
        };
    }
    const wins = sells.filter((fill) => (fill.isWinner ?? (fill.pnlUsd ?? 0) > 0)).length;
    const totalHoldMs = sells.reduce((acc, fill) => acc + (fill.holdTimeMs ?? 0), 0);
    return {
        tradeCount: sells.length,
        winRatePercent: (wins / sells.length) * 100,
        averageHoldMinutes: totalHoldMs / sells.length / 60000
    };
};
const trimHistory = (history) => {
    if (!Array.isArray(history)) {
        return [];
    }
    if (HISTORY_LIMIT <= 0 || history.length <= HISTORY_LIMIT) {
        return history.slice();
    }
    return history.slice(-HISTORY_LIMIT);
};
const createDefaultState = () => ({
    balanceUsd: config_1.default.paperTrading.startingBalanceUsd,
    startingBalanceUsd: config_1.default.paperTrading.startingBalanceUsd,
    positions: {},
    realizedPnlUsd: 0,
    tradeHistory: []
});
const clampHistory = (state) => {
    if (HISTORY_LIMIT <= 0) {
        return;
    }
    if (state.tradeHistory.length <= HISTORY_LIMIT) {
        return;
    }
    state.tradeHistory.splice(0, state.tradeHistory.length - HISTORY_LIMIT);
};
const normalizeState = (raw) => {
    if (!raw) {
        return createDefaultState();
    }
    const defaultState = createDefaultState();
    const timestamp = now();
    const normalizedPositions = {};
    if (raw.positions && typeof raw.positions === 'object') {
        for (const [mint, position] of Object.entries(raw.positions)) {
            if (!position) {
                continue;
            }
            const quantity = Number(position.quantity);
            const entryPrice = Number(position.entryPrice);
            if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
                continue;
            }
            const entryValueUsd = Number.isFinite(position.entryValueUsd)
                ? Number(position.entryValueUsd)
                : entryPrice * quantity;
            const entryTimestamp = Number.isFinite(position.entryTimestamp)
                ? Number(position.entryTimestamp)
                : timestamp;
            const lastPrice = Number.isFinite(position.lastPrice) ? Number(position.lastPrice) : entryPrice;
            const lastUpdatedAt = Number.isFinite(position.lastUpdatedAt)
                ? Number(position.lastUpdatedAt)
                : entryTimestamp;
            const peakPrice = Number.isFinite(position.peakPrice)
                ? Number(position.peakPrice)
                : Math.max(lastPrice, entryPrice);
            normalizedPositions[mint] = {
                mint,
                quantity,
                entryPrice,
                entryValueUsd,
                entryTimestamp,
                sources: Array.isArray(position.sources) ? position.sources : [],
                lastPrice,
                lastUpdatedAt,
                peakPrice
            };
        }
    }
    return {
        balanceUsd: Number.isFinite(raw.balanceUsd) ? Number(raw.balanceUsd) : defaultState.balanceUsd,
        startingBalanceUsd: Number.isFinite(raw.startingBalanceUsd)
            ? Number(raw.startingBalanceUsd)
            : config_1.default.paperTrading.startingBalanceUsd,
        positions: normalizedPositions,
        realizedPnlUsd: Number.isFinite(raw.realizedPnlUsd) ? Number(raw.realizedPnlUsd) : 0,
        tradeHistory: trimHistory(Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [])
    };
};
const computePositionValue = (position) => {
    const price = position.lastPrice ?? position.entryPrice;
    return price * position.quantity;
};
const computeUnrealized = (state) => {
    return Object.values(state.positions).reduce((acc, position) => {
        const currentValue = computePositionValue(position);
        return acc + (currentValue - position.entryValueUsd);
    }, 0);
};
const computeEquity = (state) => {
    const investedValue = Object.values(state.positions).reduce((acc, position) => {
        return acc + computePositionValue(position);
    }, 0);
    return state.balanceUsd + investedValue;
};
const recordHistory = (state, fill) => {
    state.tradeHistory.push(fill);
    clampHistory(state);
};
const createPosition = (result, desiredValueUsd) => {
    const { alert, candidate } = result;
    if (alert.priceQuote <= 0 ||
        alert.outputAmount <= 0 ||
        alert.inputAmount <= 0 ||
        desiredValueUsd <= 0) {
        return null;
    }
    const scale = Math.min(1, desiredValueUsd / alert.inputAmount);
    if (!Number.isFinite(scale) || scale <= 0) {
        return null;
    }
    const timestamp = now();
    const quantity = alert.outputAmount * scale;
    const entryValueUsd = alert.inputAmount * scale;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryValueUsd) || entryValueUsd <= 0) {
        return null;
    }
    return {
        mint: alert.contractAddress,
        quantity,
        entryPrice: alert.priceQuote,
        entryValueUsd,
        entryTimestamp: timestamp,
        sources: candidate.discovery?.sources ?? [],
        lastPrice: alert.priceQuote,
        lastUpdatedAt: timestamp,
        peakPrice: alert.priceQuote
    };
};
const countPositions = (state) => Object.keys(state.positions).length;
class NoopPaperTradingEngine {
    observe() {
        return null;
    }
    executeEntry() {
        return null;
    }
    async persist() {
        // no-op
    }
    summary() {
        return {
            balanceUsd: 0,
            equityUsd: 0,
            realizedPnlUsd: 0,
            unrealizedPnlUsd: 0,
            openPositions: 0,
            tradeCount: 0,
            winRatePercent: 0,
            averageHoldMinutes: 0
        };
    }
}
class ActivePaperTradingEngine {
    constructor(state) {
        this.state = state;
    }
    observe(result) {
        const position = this.state.positions[result.alert.contractAddress];
        if (!position) {
            return null;
        }
        const price = result.alert.priceQuote;
        if (!Number.isFinite(price) || price <= 0) {
            return null;
        }
        const timestamp = now();
        position.lastPrice = price;
        position.lastUpdatedAt = timestamp;
        position.peakPrice = Math.max(position.peakPrice ?? price, price);
        const decision = evaluateExitDecision(position, price, timestamp);
        if (!decision.shouldExit || !decision.reason) {
            return null;
        }
        const currentValue = computePositionValue(position);
        const pnlUsd = decision.pnlUsd;
        const pnlPercent = decision.pnlPercent;
        this.state.balanceUsd += currentValue;
        this.state.realizedPnlUsd += pnlUsd;
        const fill = {
            mint: position.mint,
            action: 'sell',
            quantity: position.quantity,
            price,
            valueUsd: currentValue,
            timestamp,
            reason: decision.reason,
            sources: position.sources,
            pnlUsd,
            pnlPercent,
            holdTimeMs: decision.holdTimeMs,
            isWinner: pnlUsd >= 0
        };
        recordHistory(this.state, fill);
        delete this.state.positions[position.mint];
        logger_1.default.info({
            mint: position.mint,
            pnlUsd,
            pnlPercent,
            reason: decision.reason,
            holdMinutes: decision.holdTimeMs / 60000,
            balanceUsd: this.state.balanceUsd,
            realizedPnlUsd: this.state.realizedPnlUsd
        }, 'Paper trading exit');
        return {
            action: 'sell',
            mint: position.mint,
            reason: decision.reason,
            pnlUsd,
            pnlPercent
        };
    }
    executeEntry(result) {
        if (!result.decision.shouldAlert) {
            return null;
        }
        const mint = result.alert.contractAddress;
        if (this.state.positions[mint]) {
            return {
                action: 'skip',
                mint,
                reason: 'already_holding'
            };
        }
        if (countPositions(this.state) >= config_1.default.paperTrading.maxOpenPositions) {
            return {
                action: 'skip',
                mint,
                reason: 'max_positions_reached'
            };
        }
        const desiredValueUsd = clampPositionValue(this.state.balanceUsd);
        if (desiredValueUsd <= 0) {
            return {
                action: 'skip',
                mint,
                reason: 'insufficient_balance'
            };
        }
        const position = createPosition(result, desiredValueUsd);
        if (!position) {
            return {
                action: 'skip',
                mint,
                reason: 'invalid_quote'
            };
        }
        if (this.state.balanceUsd < position.entryValueUsd) {
            return {
                action: 'skip',
                mint,
                reason: 'insufficient_balance'
            };
        }
        this.state.balanceUsd -= position.entryValueUsd;
        this.state.positions[mint] = position;
        const fill = {
            mint,
            action: 'buy',
            quantity: position.quantity,
            price: position.entryPrice,
            valueUsd: position.entryValueUsd,
            timestamp: position.entryTimestamp,
            sources: position.sources
        };
        recordHistory(this.state, fill);
        logger_1.default.info({
            mint,
            quantity: position.quantity,
            price: position.entryPrice,
            cost: position.entryValueUsd,
            balanceUsd: this.state.balanceUsd,
            openPositions: countPositions(this.state)
        }, 'Paper trading entry');
        return {
            action: 'buy',
            mint,
            position
        };
    }
    async persist() {
        await (0, storage_1.saveJsonCache)(config_1.default.paperTrading.stateFile, this.state);
    }
    summary() {
        const unrealizedPnlUsd = computeUnrealized(this.state);
        const equityUsd = computeEquity(this.state);
        const analytics = computeTradeAnalytics(this.state.tradeHistory);
        return {
            balanceUsd: this.state.balanceUsd,
            equityUsd,
            realizedPnlUsd: this.state.realizedPnlUsd,
            unrealizedPnlUsd,
            openPositions: countPositions(this.state),
            tradeCount: analytics.tradeCount,
            winRatePercent: analytics.winRatePercent,
            averageHoldMinutes: analytics.averageHoldMinutes
        };
    }
}
const createPaperTradingEngine = async () => {
    if (!config_1.default.paperTrading.enabled) {
        return new NoopPaperTradingEngine();
    }
    const cachedState = await (0, storage_1.loadJsonCache)(config_1.default.paperTrading.stateFile, createDefaultState());
    const state = normalizeState(cachedState);
    return new ActivePaperTradingEngine(state);
};
exports.createPaperTradingEngine = createPaperTradingEngine;
