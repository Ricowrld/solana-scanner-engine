import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  TextChannel
} from 'discord.js';

import config from './config';
import logger from './logger';
import { DiscoveryRejection, PaperTradingSummary, PaperTradingUpdate, TokenAlert } from './types';

export const createDiscordClient = (): Client => {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
};

const formatAmount = (value?: number): string => {
  if (value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }
  const absValue = Math.abs(value);

  if (absValue >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (absValue >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }

  return value.toFixed(4);
};

const formatPercent = (value?: number): string => {
  if (value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }

  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const formatRoute = (route: string[]): string => {
  if (!route || route.length === 0) {
    return 'Direct';
  }

  return route.join(' → ');
};

const buildChartUrl = (alert: TokenAlert): string => {
  if (alert.chartUrl) {
    return alert.chartUrl;
  }

  return `https://solscan.io/token/${alert.contractAddress}`;
};

const formatFilterSummary = (summary: Record<string, boolean | null>): string => {
  const entries = Object.entries(summary);
  if (entries.length === 0) {
    return 'No diagnostics registered.';
  }

  return entries
    .map(([key, value]) => {
      let icon = '❔';
      if (value === true) {
        icon = '✅';
      } else if (value === false) {
        icon = '❌';
      }
      return `${icon} ${key}`;
    })
    .join(' · ');
};

const formatDiscovery = (alert: TokenAlert): string | null => {
  if (!alert.discoverySources || alert.discoverySources.length === 0) {
    return null;
  }

  const sources = alert.discoverySources.map((source) => source.replace(/_/g, ' ')).join(', ');
  const rows: string[] = [`Sources: ${sources}`];

  const metrics: Array<[string, number | undefined]> = [
    ['Liq', alert.discoveryLiquidityUsd],
    ['Vol 1h', alert.discoveryVolume1hUsd],
    ['FDV', alert.discoveryMarketCapUsd]
  ];

  const formattedMetrics = metrics
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `${label}: $${formatAmount(value as number)}`);

  if (formattedMetrics.length > 0) {
    rows.push(formattedMetrics.join(' · '));
  }

  if (alert.discoveryAgeMinutes !== undefined) {
    rows.push(`Age: ${alert.discoveryAgeMinutes.toFixed(0)}m`);
  }

  if (alert.discoveryHolderCount !== undefined) {
    rows.push(`Holders: ${alert.discoveryHolderCount}`);
  }

  if (alert.discoveryScore !== undefined) {
    rows.push(`Score: ${alert.discoveryScore}`);
  }

  if (alert.discoveryWarnings && alert.discoveryWarnings.length > 0) {
    rows.push(`Warnings: ${alert.discoveryWarnings.join('; ')}`);
  }

  return rows.join('\n');
};

const buildEmbed = (alert: TokenAlert): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle(`${alert.tokenName} (${alert.tokenSymbol})`)
    .setURL(buildChartUrl(alert))
    .setColor(0x5dade2)
    .addFields(
      {
        name: 'Estimated Price',
        value: `${formatAmount(alert.priceQuote)} ${alert.inputTokenSymbol}`,
        inline: true
      },
      { name: 'Price Impact', value: formatPercent(alert.priceImpactPercent), inline: true },
      {
        name: 'Input',
        value: `${formatAmount(alert.inputAmount)} ${alert.inputTokenSymbol} → ${(alert.outputAmount ?? 0).toFixed(4)} ${alert.tokenSymbol}`,
        inline: true
      },
      {
        name: 'Momentum',
        value: `1m: ${formatPercent(alert.priceChange1mPercent)}\n5m: ${formatPercent(alert.priceChange5mPercent)}\n1h: ${formatPercent(alert.priceChange1hPercent)}`,
        inline: true
      },
      {
        name: 'Route',
        value: formatRoute(alert.route),
        inline: true
      },
      {
        name: 'Contract',
        value: `\`${alert.contractAddress}\``,
        inline: false
      }
    );

  if (alert.bestDex) {
    embed.addFields({ name: 'Best Venue', value: alert.bestDex, inline: true });
  }

  const discoverySummary = formatDiscovery(alert);
  if (discoverySummary) {
    embed.addFields({ name: 'Discovery', value: discoverySummary, inline: false });
  }

  return embed;
};

const buildActionRow = (alert: TokenAlert): ActionRowBuilder<ButtonBuilder> => {
  const viewButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setURL(buildChartUrl(alert))
    .setLabel('View Chart');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(viewButton);
};

const buildRejectionField = (rejection: DiscoveryRejection): { name: string; value: string } => {
  const headerParts: string[] = [];
  if (rejection.symbol || rejection.name) {
    headerParts.push(rejection.symbol ?? rejection.name ?? '');
  }
  headerParts.push(rejection.mint);

  const metrics: string[] = [];
  if (rejection.liquidityUsd !== undefined) {
    metrics.push(`Liq: $${formatAmount(rejection.liquidityUsd)}`);
  }
  if (rejection.volume1hUsd !== undefined) {
    metrics.push(`Vol1h: $${formatAmount(rejection.volume1hUsd)}`);
  }
  if (rejection.marketCapUsd !== undefined) {
    metrics.push(`FDV: $${formatAmount(rejection.marketCapUsd)}`);
  }
  if (rejection.ageMinutes !== undefined) {
    metrics.push(`Age: ${rejection.ageMinutes.toFixed(0)}m`);
  }
  if (rejection.holderCount !== undefined) {
    metrics.push(`Holders: ${rejection.holderCount}`);
  }
  if (rejection.discoveryScore !== undefined) {
    metrics.push(`Score: ${rejection.discoveryScore}`);
  }

  const reasons =
    rejection.reasons.length > 0 ? rejection.reasons.map((reason) => `• ${reason}`).join('\n') : 'No reasons recorded.';
  const summaryLine = formatFilterSummary(rejection.summary);

  const lines: string[] = [reasons, summaryLine];
  if (rejection.warnings && rejection.warnings.length > 0) {
    lines.push(rejection.warnings.map((warning) => `Warning: ${warning}`).join('\n'));
  }
  if (metrics.length > 0) {
    lines.push(metrics.join(' · '));
  }

  return {
    name: headerParts.filter(Boolean).join(' — '),
    value: lines.join('\n')
  };
};

export const sendDiscoveryRejections = async (
  client: Client,
  channelId: string,
  rejections: DiscoveryRejection[]
): Promise<void> => {
  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased()) {
    logger.error({ channelId }, 'Discovery rejection channel is not text-based or not found');
    return;
  }

  const sampleSize = Math.max(1, config.discovery.rejectionLogSampleSize);
  const sample = rejections.slice(0, sampleSize);

  const embed = new EmbedBuilder()
    .setTitle(`Discovery rejections (${sample.length}/${rejections.length})`)
    .setColor(0xf5b041)
    .setTimestamp(new Date())
    .addFields(sample.map((item) => buildRejectionField(item)));

  if (rejections.length > sample.length) {
    embed.setFooter({ text: `${rejections.length - sample.length} more filtered this cycle` });
  }

  try {
    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, channelId }, 'Failed to send discovery rejections');
  }
};

export const sendAlert = async (
  client: Client,
  alert: TokenAlert
): Promise<void> => {
  const channel = await client.channels.fetch(config.channelId);

  if (!channel || !channel.isTextBased()) {
    logger.error({ channelId: config.channelId }, 'Channel is not text-based or not found');
    return;
  }

  const embed = buildEmbed(alert);
  const row = buildActionRow(alert);

  logger.info({ channelId: config.channelId }, 'Sending alert...');
  try {
    await (channel as TextChannel).send({ embeds: [embed], components: [row] });
  } catch (err) {
    logger.error({ err, channelId: config.channelId }, 'Discord send failed');
  }
};

const formatUpdateLine = (update: PaperTradingUpdate): string => {
  const parts: string[] = [update.action.toUpperCase(), update.mint];
  if (update.reason) {
    parts.push(`(${update.reason})`);
  }
  if (update.pnlUsd !== undefined) {
    const sign = update.pnlUsd >= 0 ? '+' : '-';
    parts.push(`${sign}$${Math.abs(update.pnlUsd).toFixed(2)}`);
  }
  if (update.pnlPercent !== undefined) {
    const sign = update.pnlPercent >= 0 ? '+' : '-';
    parts.push(`${sign}${Math.abs(update.pnlPercent).toFixed(2)}%`);
  }
  return parts.join(' ');
};

const buildSummaryEmbed = (
  summary: PaperTradingSummary,
  updates: PaperTradingUpdate[]
): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setTitle('Paper Trading Summary')
    .setColor(0x58d68d)
    .addFields(
      {
        name: 'Balance',
        value: `$${summary.balanceUsd.toFixed(2)}`,
        inline: true
      },
      {
        name: 'Equity',
        value: `$${summary.equityUsd.toFixed(2)}`,
        inline: true
      },
      {
        name: 'Realized PnL',
        value: `$${summary.realizedPnlUsd.toFixed(2)}`,
        inline: true
      },
      {
        name: 'Unrealized PnL',
        value: `$${summary.unrealizedPnlUsd.toFixed(2)}`,
        inline: true
      },
      {
        name: 'Win Rate',
        value: `${summary.tradeCount > 0 ? summary.winRatePercent.toFixed(2) : '0.00'}%`,
        inline: true
      },
      {
        name: 'Average Hold',
        value: `${summary.averageHoldMinutes.toFixed(2)} min`,
        inline: true
      },
      {
        name: 'Open Positions',
        value: `${summary.openPositions}`,
        inline: true
      },
      {
        name: 'Trades Logged',
        value: `${summary.tradeCount}`,
        inline: true
      }
    );

  if (updates.length > 0) {
    const lines = updates.slice(0, 10).map((update) => `• ${formatUpdateLine(update)}`);
    const remaining = updates.length - lines.length;
    if (remaining > 0) {
      lines.push(`…and ${remaining} more updates`);
    }
    embed.addFields({ name: 'Updates This Cycle', value: lines.join('\n'), inline: false });
  } else {
    embed.addFields({ name: 'Updates This Cycle', value: 'No trades executed this cycle.', inline: false });
  }

  return embed;
};

export const sendPaperTradingSummary = async (
  client: Client,
  channelId: string,
  summary: PaperTradingSummary,
  updates: PaperTradingUpdate[]
): Promise<void> => {
  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased()) {
    logger.error({ channelId }, 'Paper trading summary channel is not text-based or not found');
    return;
  }

  const embed = buildSummaryEmbed(summary, updates);

  try {
    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, channelId }, 'Failed to send paper trading summary');
  }
};
