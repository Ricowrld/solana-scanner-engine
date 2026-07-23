import 'dotenv/config';

import config from './config';
import logger from './logger';
import { createDiscordClient, sendAlert, sendPaperTradingSummary, sendDiscoveryRejections } from './discord';
import { loadCache, saveCache } from './storage';
import { scanOnce } from './scanner';
import { createPaperTradingEngine } from './paperTrading';
import type { PaperTradingSummary, PaperTradingUpdate } from './types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const shouldSendPaperTradingSummary = (
  summary: PaperTradingSummary,
  updates: PaperTradingUpdate[],
  lastSentSummary: PaperTradingSummary | null,
  lastSentAt: number,
  now: number
): boolean => {
  if (updates.length > 0) {
    return true;
  }

  if (!lastSentSummary) {
    return true;
  }

  const minEquityChangeUsd = Math.max(0, config.paperTrading.summaryMinEquityChangeUsd);
  const summaryIntervalMs = Math.max(0, config.paperTrading.summaryIntervalMinutes) * 60_000;
  const equityChangeUsd = Math.abs(summary.equityUsd - lastSentSummary.equityUsd);
  const realizedChangeUsd = Math.abs(summary.realizedPnlUsd - lastSentSummary.realizedPnlUsd);
  const unrealizedChangeUsd = Math.abs(summary.unrealizedPnlUsd - lastSentSummary.unrealizedPnlUsd);
  const openPositionsChanged = summary.openPositions !== lastSentSummary.openPositions;

  if (
    equityChangeUsd >= minEquityChangeUsd ||
    realizedChangeUsd >= minEquityChangeUsd ||
    unrealizedChangeUsd >= minEquityChangeUsd ||
    openPositionsChanged
  ) {
    return true;
  }

  if (summaryIntervalMs > 0 && now - lastSentAt >= summaryIntervalMs) {
    return true;
  }

  return false;
};

const run = async (): Promise<void> => {
  if (!config.botToken || !config.channelId) {
    throw new Error('BOT_TOKEN and CHANNEL_ID must be set in the environment');
  }

  const client = createDiscordClient();

  client.once('clientReady', () => {
    logger.info({ user: client.user?.tag }, 'Discord bot logged in');
  });

  await client.login(config.botToken);

  const cache = await loadCache(config.cacheFile);
  const paperTrader = await createPaperTradingEngine();
  let lastPaperTradingSummary: PaperTradingSummary | null = null;
  let lastPaperTradingSummaryAt = 0;

  while (true) {
    try {
      logger.info('Running scan cycle...');
      const cooldownMints = new Set(
        Object.entries(cache)
          .filter(([, entry]) => Date.now() - entry.lastAlertedAt < config.cooldownMs)
          .map(([mint]) => mint)
      );
      const trackedMints = paperTrader.trackedMints();

      const { results, discoveryRejections } = await scanOnce(cooldownMints, trackedMints);
      logger.info({ total: results.length }, 'Scan results returned');

      if (config.discovery.rejectionChannelId && discoveryRejections.length > 0) {
        await sendDiscoveryRejections(client, config.discovery.rejectionChannelId, discoveryRejections);
      }
      const now = Date.now();
      const tradingUpdates: PaperTradingUpdate[] = [];

      for (const result of results) {
        const { alert, decision } = result;

        const observation = await paperTrader.observe(result);
        if (observation) {
          tradingUpdates.push(observation);
        }

        if (!decision.shouldAlert) {
          logger.debug({ token: alert.tokenSymbol, reason: decision.reason }, 'Skipping token');
          continue;
        }

        const cacheKey = alert.contractAddress;
        const legacyKey = alert.contractAddress.toLowerCase();
        const lastAlerted = cache[cacheKey]?.lastAlertedAt ?? cache[legacyKey]?.lastAlertedAt ?? 0;

        if (now - lastAlerted < config.cooldownMs) {
          logger.debug({ token: alert.tokenSymbol }, 'Token in cooldown, skipping');
          continue;
        }

        const entry = paperTrader.executeEntry(result);
        if (entry) {
          tradingUpdates.push(entry);
        }

        await sendAlert(client, alert);
        cache[cacheKey] = { lastAlertedAt: now };
        if (legacyKey in cache && legacyKey !== cacheKey) {
          delete cache[legacyKey];
        }
        logger.info({ token: alert.tokenSymbol }, 'Alert sent');
      }

      await paperTrader.persist();
      if (config.paperTrading.enabled) {
        const summary = paperTrader.summary();
        logger.info(
          {
            paperTradingSummary: summary,
            updatesCount: tradingUpdates.length
          },
          'Paper trading cycle complete'
        );

        const summaryChannelId = config.paperTrading.summaryChannelId || config.channelId;

        if (
          summaryChannelId &&
          shouldSendPaperTradingSummary(
            summary,
            tradingUpdates,
            lastPaperTradingSummary,
            lastPaperTradingSummaryAt,
            now
          )
        ) {
          try {
            await sendPaperTradingSummary(client, summaryChannelId, summary, tradingUpdates);
            lastPaperTradingSummary = summary;
            lastPaperTradingSummaryAt = now;
          } catch (error) {
            logger.error({ err: error, summaryChannelId }, 'Failed to send paper trading summary');
          }
        } else if (summaryChannelId) {
          logger.debug(
            {
              summaryChannelId,
              updatesCount: tradingUpdates.length
            },
            'Skipping paper trading summary for this cycle'
          );
        }
      }

      await saveCache(config.cacheFile, cache);
    } catch (error) {
      logger.error({ err: error }, 'Scan loop failed');
    }

    logger.info({ seconds: config.scanIntervalMs / 1000 }, 'Sleeping before next scan');
    await sleep(config.scanIntervalMs);
  }
};

run().catch((error) => {
  logger.fatal({ err: error }, 'Fatal error in bot');
  process.exit(1);
});
