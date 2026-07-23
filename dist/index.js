"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const discord_1 = require("./discord");
const storage_1 = require("./storage");
const scanner_1 = require("./scanner");
const paperTrading_1 = require("./paperTrading");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shouldSendPaperTradingSummary = (summary, updates, lastSentSummary, lastSentAt, now) => {
    if (updates.length > 0) {
        return true;
    }
    if (!lastSentSummary) {
        return true;
    }
    const minEquityChangeUsd = Math.max(0, config_1.default.paperTrading.summaryMinEquityChangeUsd);
    const summaryIntervalMs = Math.max(0, config_1.default.paperTrading.summaryIntervalMinutes) * 60_000;
    const equityChangeUsd = Math.abs(summary.equityUsd - lastSentSummary.equityUsd);
    const realizedChangeUsd = Math.abs(summary.realizedPnlUsd - lastSentSummary.realizedPnlUsd);
    const unrealizedChangeUsd = Math.abs(summary.unrealizedPnlUsd - lastSentSummary.unrealizedPnlUsd);
    const openPositionsChanged = summary.openPositions !== lastSentSummary.openPositions;
    if (equityChangeUsd >= minEquityChangeUsd ||
        realizedChangeUsd >= minEquityChangeUsd ||
        unrealizedChangeUsd >= minEquityChangeUsd ||
        openPositionsChanged) {
        return true;
    }
    if (summaryIntervalMs > 0 && now - lastSentAt >= summaryIntervalMs) {
        return true;
    }
    return false;
};
const run = async () => {
    if (!config_1.default.botToken || !config_1.default.channelId) {
        throw new Error('BOT_TOKEN and CHANNEL_ID must be set in the environment');
    }
    const client = (0, discord_1.createDiscordClient)();
    client.once('clientReady', () => {
        logger_1.default.info({ user: client.user?.tag }, 'Discord bot logged in');
    });
    await client.login(config_1.default.botToken);
    const cache = await (0, storage_1.loadCache)(config_1.default.cacheFile);
    const paperTrader = await (0, paperTrading_1.createPaperTradingEngine)();
    let lastPaperTradingSummary = null;
    let lastPaperTradingSummaryAt = 0;
    while (true) {
        try {
            logger_1.default.info('Running scan cycle...');
            const cooldownMints = new Set(Object.entries(cache)
                .filter(([, entry]) => Date.now() - entry.lastAlertedAt < config_1.default.cooldownMs)
                .map(([mint]) => mint));
            const { results, discoveryRejections } = await (0, scanner_1.scanOnce)(cooldownMints);
            logger_1.default.info({ total: results.length }, 'Scan results returned');
            if (config_1.default.discovery.rejectionChannelId && discoveryRejections.length > 0) {
                await (0, discord_1.sendDiscoveryRejections)(client, config_1.default.discovery.rejectionChannelId, discoveryRejections);
            }
            const now = Date.now();
            const tradingUpdates = [];
            for (const result of results) {
                const { alert, decision } = result;
                const observation = paperTrader.observe(result);
                if (observation) {
                    tradingUpdates.push(observation);
                }
                if (!decision.shouldAlert) {
                    logger_1.default.debug({ token: alert.tokenSymbol, reason: decision.reason }, 'Skipping token');
                    continue;
                }
                const cacheKey = alert.contractAddress;
                const legacyKey = alert.contractAddress.toLowerCase();
                const lastAlerted = cache[cacheKey]?.lastAlertedAt ?? cache[legacyKey]?.lastAlertedAt ?? 0;
                if (now - lastAlerted < config_1.default.cooldownMs) {
                    logger_1.default.debug({ token: alert.tokenSymbol }, 'Token in cooldown, skipping');
                    continue;
                }
                const entry = paperTrader.executeEntry(result);
                if (entry) {
                    tradingUpdates.push(entry);
                }
                await (0, discord_1.sendAlert)(client, alert);
                cache[cacheKey] = { lastAlertedAt: now };
                if (legacyKey in cache && legacyKey !== cacheKey) {
                    delete cache[legacyKey];
                }
                logger_1.default.info({ token: alert.tokenSymbol }, 'Alert sent');
            }
            await paperTrader.persist();
            if (config_1.default.paperTrading.enabled) {
                const summary = paperTrader.summary();
                logger_1.default.info({
                    paperTradingSummary: summary,
                    updatesCount: tradingUpdates.length
                }, 'Paper trading cycle complete');
                const summaryChannelId = config_1.default.paperTrading.summaryChannelId || config_1.default.channelId;
                if (summaryChannelId &&
                    shouldSendPaperTradingSummary(summary, tradingUpdates, lastPaperTradingSummary, lastPaperTradingSummaryAt, now)) {
                    try {
                        await (0, discord_1.sendPaperTradingSummary)(client, summaryChannelId, summary, tradingUpdates);
                        lastPaperTradingSummary = summary;
                        lastPaperTradingSummaryAt = now;
                    }
                    catch (error) {
                        logger_1.default.error({ err: error, summaryChannelId }, 'Failed to send paper trading summary');
                    }
                }
                else if (summaryChannelId) {
                    logger_1.default.debug({
                        summaryChannelId,
                        updatesCount: tradingUpdates.length
                    }, 'Skipping paper trading summary for this cycle');
                }
            }
            await (0, storage_1.saveCache)(config_1.default.cacheFile, cache);
        }
        catch (error) {
            logger_1.default.error({ err: error }, 'Scan loop failed');
        }
        logger_1.default.info({ seconds: config_1.default.scanIntervalMs / 1000 }, 'Sleeping before next scan');
        await sleep(config_1.default.scanIntervalMs);
    }
};
run().catch((error) => {
    logger_1.default.fatal({ err: error }, 'Fatal error in bot');
    process.exit(1);
});
