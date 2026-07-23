import config from './config';
import { fetchJupiterQuote } from './jupiter';
import logger from './logger';
import { loadJsonCache, saveJsonCache } from './storage';
import {
  PaperTradeFill,
  PaperTradePosition,
  PaperTradingState,
  PaperTradingUpdate,
  PaperTradingSummary,
  ScanResult
} from './types';

const HISTORY_LIMIT = Math.max(0, config.paperTrading.historyLimit);
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const now = (): number => Date.now();

const decimalToAtomicAmount = (value: number, decimals: number): string | null => {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(decimals) || decimals < 0) {
    return null;
  }

  const scaled = Math.floor(value * 10 ** decimals);
  if (!Number.isFinite(scaled) || scaled <= 0) {
    return null;
  }

  return String(scaled);
};

const clampPositionValue = (balanceUsd: number): number => {
  if (balanceUsd <= 0) {
    return 0;
  }

  const upperBound = Math.min(balanceUsd, config.paperTrading.maxPositionUsd);
  const lowerBound = Math.min(config.paperTrading.minPositionUsd, upperBound);
  const fractionTarget = balanceUsd * config.paperTrading.positionFractionOfBalance;
  const target = Math.min(Math.max(fractionTarget, lowerBound), upperBound);

  return Math.max(target, 0);
};

const selectSellFills = (history: PaperTradeFill[]): PaperTradeFill[] => {
  return history.filter((fill) => fill.action === 'sell');
};

interface ExitDecision {
  shouldExit: boolean;
  reason?: string;
  pnlUsd: number;
  pnlPercent: number;
  holdTimeMs: number;
}

const evaluateExitDecision = (
  position: PaperTradePosition,
  price: number,
  currentValue: number,
  timestamp: number
): ExitDecision => {
  const pnlUsd = currentValue - position.entryValueUsd;
  const pnlPercent = position.entryValueUsd > 0 ? (pnlUsd / position.entryValueUsd) * 100 : 0;
  const holdTimeMs = Math.max(0, timestamp - position.entryTimestamp);
  const holdMinutes = holdTimeMs / 60000;

  let reason: string | undefined;

  if (pnlPercent >= config.paperTrading.takeProfitPercent) {
    reason = 'take_profit';
  }

  if (!reason) {
    const peakPrice = position.peakPrice ?? position.entryPrice;
    if (config.paperTrading.trailingStopPercent > 0 && peakPrice > 0) {
      const dropPercent = ((price - peakPrice) / peakPrice) * 100;
      if (dropPercent <= -config.paperTrading.trailingStopPercent) {
        reason = 'trailing_stop';
      }
    }
  }

  if (!reason && pnlPercent <= config.paperTrading.stopLossPercent) {
    reason = 'stop_loss';
  }

  if (!reason && config.paperTrading.maxHoldMinutes > 0 && holdMinutes >= config.paperTrading.maxHoldMinutes) {
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

const computeTradeAnalytics = (history: PaperTradeFill[]): {
  tradeCount: number;
  winRatePercent: number;
  averageHoldMinutes: number;
} => {
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

const trimHistory = (history: PaperTradeFill[]): PaperTradeFill[] => {
  if (!Array.isArray(history)) {
    return [];
  }

  if (HISTORY_LIMIT <= 0 || history.length <= HISTORY_LIMIT) {
    return history.slice();
  }

  return history.slice(-HISTORY_LIMIT);
};

const createDefaultState = (): PaperTradingState => ({
  balanceUsd: config.paperTrading.startingBalanceUsd,
  startingBalanceUsd: config.paperTrading.startingBalanceUsd,
  positions: {},
  realizedPnlUsd: 0,
  tradeHistory: []
});

const clampHistory = (state: PaperTradingState): void => {
  if (HISTORY_LIMIT <= 0) {
    return;
  }

  if (state.tradeHistory.length <= HISTORY_LIMIT) {
    return;
  }

  state.tradeHistory.splice(0, state.tradeHistory.length - HISTORY_LIMIT);
};

const normalizeState = (raw: PaperTradingState | undefined): PaperTradingState => {
  if (!raw) {
    return createDefaultState();
  }

  const defaultState = createDefaultState();
  const timestamp = now();
  const normalizedPositions: Record<string, PaperTradePosition> = {};

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
        decimals: Number.isFinite(position.decimals) ? Number(position.decimals) : 9,
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
      : config.paperTrading.startingBalanceUsd,
    positions: normalizedPositions,
    realizedPnlUsd: Number.isFinite(raw.realizedPnlUsd) ? Number(raw.realizedPnlUsd) : 0,
    tradeHistory: trimHistory(Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [])
  };
};

const computePositionValue = (position: PaperTradePosition): number => {
  const price = position.lastPrice ?? position.entryPrice;
  return price * position.quantity;
};

const computeUnrealized = (state: PaperTradingState): number => {
  return Object.values(state.positions).reduce((acc, position) => {
    const currentValue = computePositionValue(position);
    return acc + (currentValue - position.entryValueUsd);
  }, 0);
};

const computeEquity = (state: PaperTradingState): number => {
  const investedValue = Object.values(state.positions).reduce((acc, position) => {
    return acc + computePositionValue(position);
  }, 0);

  return state.balanceUsd + investedValue;
};

const recordHistory = (state: PaperTradingState, fill: PaperTradeFill): void => {
  state.tradeHistory.push(fill);
  clampHistory(state);
};

const createPosition = (result: ScanResult, desiredValueUsd: number): PaperTradePosition | null => {
  const { alert, candidate } = result;
  if (
    alert.priceQuote <= 0 ||
    alert.outputAmount <= 0 ||
    alert.inputAmount <= 0 ||
    desiredValueUsd <= 0
  ) {
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
    decimals: result.candidate.metadata?.decimals ?? 9,
    entryPrice: alert.priceQuote,
    entryValueUsd,
    entryTimestamp: timestamp,
    sources: candidate.discovery?.sources ?? [],
    lastPrice: alert.priceQuote,
    lastUpdatedAt: timestamp,
    peakPrice: alert.priceQuote
  };
};

const countPositions = (state: PaperTradingState): number => Object.keys(state.positions).length;

export interface PaperTradingEngine {
  observe(result: ScanResult): Promise<PaperTradingUpdate | null>;
  executeEntry(result: ScanResult): PaperTradingUpdate | null;
  persist(): Promise<void>;
  summary(): PaperTradingSummary;
  trackedMints(): Set<string>;
}

class NoopPaperTradingEngine implements PaperTradingEngine {
  async observe(): Promise<PaperTradingUpdate | null> {
    return null;
  }

  executeEntry(): PaperTradingUpdate | null {
    return null;
  }

  async persist(): Promise<void> {
    // no-op
  }

  summary(): PaperTradingSummary {
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

  trackedMints(): Set<string> {
    return new Set();
  }
}

class ActivePaperTradingEngine implements PaperTradingEngine {
  private state: PaperTradingState;

  constructor(state: PaperTradingState) {
    this.state = state;
  }

  async observe(result: ScanResult): Promise<PaperTradingUpdate | null> {
    const position = this.state.positions[result.alert.contractAddress];
    if (!position) {
      return null;
    }

    const fallbackPrice =
      Number.isFinite(result.alert.priceQuote) && result.alert.priceQuote > 0
        ? result.alert.priceQuote
        : (position.lastPrice ?? position.entryPrice);

    let currentValue = fallbackPrice * position.quantity;
    let exitPrice = fallbackPrice;
    const exitAmount = decimalToAtomicAmount(position.quantity, position.decimals);

    if (exitAmount) {
      const exitQuote = await fetchJupiterQuote({
        inputMint: position.mint,
        outputMint: config.jupiter.inputMint,
        amount: exitAmount
      });

      const reverseOutAmount = Number(exitQuote.quote?.outAmount ?? 0);
      const outputDecimals = config.jupiter.inputMint === USDC_MINT ? 6 : 9;

      if (reverseOutAmount > 0 && Number.isFinite(reverseOutAmount)) {
        currentValue = reverseOutAmount / 10 ** outputDecimals;
        exitPrice = position.quantity > 0 ? currentValue / position.quantity : fallbackPrice;
      } else if (exitQuote.failureReason) {
        logger.debug(
          {
            mint: position.mint,
            failureReason: exitQuote.failureReason
          },
          'Using fallback paper exit valuation because reverse quote was unavailable'
        );
      }
    }

    const timestamp = now();
    position.lastPrice = exitPrice;
    position.lastUpdatedAt = timestamp;
    position.peakPrice = Math.max(position.peakPrice ?? exitPrice, exitPrice);

    const decision = evaluateExitDecision(position, exitPrice, currentValue, timestamp);
    if (!decision.shouldExit || !decision.reason) {
      return null;
    }

    const pnlUsd = decision.pnlUsd;
    const pnlPercent = decision.pnlPercent;

    this.state.balanceUsd += currentValue;
    this.state.realizedPnlUsd += pnlUsd;

    const fill: PaperTradeFill = {
      mint: position.mint,
      action: 'sell',
      quantity: position.quantity,
      price: exitPrice,
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

    logger.info(
      {
        mint: position.mint,
        pnlUsd,
        pnlPercent,
        reason: decision.reason,
        holdMinutes: decision.holdTimeMs / 60000,
        balanceUsd: this.state.balanceUsd,
        realizedPnlUsd: this.state.realizedPnlUsd
      },
      'Paper trading exit'
    );

    return {
      action: 'sell',
      mint: position.mint,
      reason: decision.reason,
      pnlUsd,
      pnlPercent
    };
  }

  executeEntry(result: ScanResult): PaperTradingUpdate | null {
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

    if (countPositions(this.state) >= config.paperTrading.maxOpenPositions) {
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

    const fill: PaperTradeFill = {
      mint,
      action: 'buy',
      quantity: position.quantity,
      price: position.entryPrice,
      valueUsd: position.entryValueUsd,
      timestamp: position.entryTimestamp,
      sources: position.sources
    };

    recordHistory(this.state, fill);

    logger.info(
      {
        mint,
        quantity: position.quantity,
        price: position.entryPrice,
        cost: position.entryValueUsd,
        balanceUsd: this.state.balanceUsd,
        openPositions: countPositions(this.state)
      },
      'Paper trading entry'
    );

    return {
      action: 'buy',
      mint,
      position
    };
  }

  async persist(): Promise<void> {
    await saveJsonCache(config.paperTrading.stateFile, this.state);
  }

  summary(): PaperTradingSummary {
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

  trackedMints(): Set<string> {
    return new Set(Object.keys(this.state.positions));
  }
}

export const createPaperTradingEngine = async (): Promise<PaperTradingEngine> => {
  if (!config.paperTrading.enabled) {
    return new NoopPaperTradingEngine();
  }

  const cachedState = await loadJsonCache<PaperTradingState>(
    config.paperTrading.stateFile,
    createDefaultState()
  );
  const state = normalizeState(cachedState);

  return new ActivePaperTradingEngine(state);
};
