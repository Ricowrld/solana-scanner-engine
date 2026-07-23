"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPaperTradingSummary = exports.sendAlert = exports.sendDiscoveryRejections = exports.createDiscordClient = void 0;
const discord_js_1 = require("discord.js");
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const createDiscordClient = () => {
    return new discord_js_1.Client({ intents: [discord_js_1.GatewayIntentBits.Guilds] });
};
exports.createDiscordClient = createDiscordClient;
const formatAmount = (value) => {
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
const formatPercent = (value) => {
    if (value === undefined || Number.isNaN(value)) {
        return 'N/A';
    }
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};
const formatRoute = (route) => {
    if (!route || route.length === 0) {
        return 'Direct';
    }
    return route.join(' → ');
};
const buildChartUrl = (alert) => {
    if (alert.chartUrl) {
        return alert.chartUrl;
    }
    return `https://solscan.io/token/${alert.contractAddress}`;
};
const formatFilterSummary = (summary) => {
    const entries = Object.entries(summary);
    if (entries.length === 0) {
        return 'No diagnostics registered.';
    }
    return entries
        .map(([key, value]) => {
        let icon = '❔';
        if (value === true) {
            icon = '✅';
        }
        else if (value === false) {
            icon = '❌';
        }
        return `${icon} ${key}`;
    })
        .join(' · ');
};
const formatDiscovery = (alert) => {
    if (!alert.discoverySources || alert.discoverySources.length === 0) {
        return null;
    }
    const sources = alert.discoverySources.map((source) => source.replace(/_/g, ' ')).join(', ');
    const rows = [`Sources: ${sources}`];
    const metrics = [
        ['Liq', alert.discoveryLiquidityUsd],
        ['Vol 1h', alert.discoveryVolume1hUsd],
        ['FDV', alert.discoveryMarketCapUsd]
    ];
    const formattedMetrics = metrics
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) => `${label}: $${formatAmount(value)}`);
    if (formattedMetrics.length > 0) {
        rows.push(formattedMetrics.join(' · '));
    }
    if (alert.discoveryAgeMinutes !== undefined) {
        rows.push(`Age: ${alert.discoveryAgeMinutes.toFixed(0)}m`);
    }
    if (alert.discoveryHolderCount !== undefined) {
        rows.push(`Holders: ${alert.discoveryHolderCount}`);
    }
    if (alert.discoveryWarnings && alert.discoveryWarnings.length > 0) {
        rows.push(`Warnings: ${alert.discoveryWarnings.join('; ')}`);
    }
    return rows.join('\n');
};
const buildEmbed = (alert) => {
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`${alert.tokenName} (${alert.tokenSymbol})`)
        .setURL(buildChartUrl(alert))
        .setColor(0x5dade2)
        .addFields({
        name: 'Estimated Price',
        value: `${formatAmount(alert.priceQuote)} ${alert.inputTokenSymbol}`,
        inline: true
    }, { name: 'Price Impact', value: formatPercent(alert.priceImpactPercent), inline: true }, {
        name: 'Input',
        value: `${formatAmount(alert.inputAmount)} ${alert.inputTokenSymbol} → ${(alert.outputAmount ?? 0).toFixed(4)} ${alert.tokenSymbol}`,
        inline: true
    }, {
        name: 'Momentum',
        value: `1m: ${formatPercent(alert.priceChange1mPercent)}\n5m: ${formatPercent(alert.priceChange5mPercent)}\n1h: ${formatPercent(alert.priceChange1hPercent)}`,
        inline: true
    }, {
        name: 'Route',
        value: formatRoute(alert.route),
        inline: true
    }, {
        name: 'Contract',
        value: `\`${alert.contractAddress}\``,
        inline: false
    });
    if (alert.bestDex) {
        embed.addFields({ name: 'Best Venue', value: alert.bestDex, inline: true });
    }
    const discoverySummary = formatDiscovery(alert);
    if (discoverySummary) {
        embed.addFields({ name: 'Discovery', value: discoverySummary, inline: false });
    }
    return embed;
};
const buildActionRow = (alert) => {
    const viewButton = new discord_js_1.ButtonBuilder()
        .setStyle(discord_js_1.ButtonStyle.Link)
        .setURL(buildChartUrl(alert))
        .setLabel('View Chart');
    return new discord_js_1.ActionRowBuilder().addComponents(viewButton);
};
const buildRejectionField = (rejection) => {
    const headerParts = [];
    if (rejection.symbol || rejection.name) {
        headerParts.push(rejection.symbol ?? rejection.name ?? '');
    }
    headerParts.push(rejection.mint);
    const metrics = [];
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
    const reasons = rejection.reasons.length > 0 ? rejection.reasons.map((reason) => `• ${reason}`).join('\n') : 'No reasons recorded.';
    const summaryLine = formatFilterSummary(rejection.summary);
    const lines = [reasons, summaryLine];
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
const sendDiscoveryRejections = async (client, channelId, rejections) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
        logger_1.default.error({ channelId }, 'Discovery rejection channel is not text-based or not found');
        return;
    }
    const sampleSize = Math.max(1, config_1.default.discovery.rejectionLogSampleSize);
    const sample = rejections.slice(0, sampleSize);
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`Discovery rejections (${sample.length}/${rejections.length})`)
        .setColor(0xf5b041)
        .setTimestamp(new Date())
        .addFields(sample.map((item) => buildRejectionField(item)));
    if (rejections.length > sample.length) {
        embed.setFooter({ text: `${rejections.length - sample.length} more filtered this cycle` });
    }
    try {
        await channel.send({ embeds: [embed] });
    }
    catch (err) {
        logger_1.default.error({ err, channelId }, 'Failed to send discovery rejections');
    }
};
exports.sendDiscoveryRejections = sendDiscoveryRejections;
const sendAlert = async (client, alert) => {
    const channel = await client.channels.fetch(config_1.default.channelId);
    if (!channel || !channel.isTextBased()) {
        logger_1.default.error({ channelId: config_1.default.channelId }, 'Channel is not text-based or not found');
        return;
    }
    const embed = buildEmbed(alert);
    const row = buildActionRow(alert);
    logger_1.default.info({ channelId: config_1.default.channelId }, 'Sending alert...');
    try {
        await channel.send({ embeds: [embed], components: [row] });
    }
    catch (err) {
        logger_1.default.error({ err, channelId: config_1.default.channelId }, 'Discord send failed');
    }
};
exports.sendAlert = sendAlert;
const formatUpdateLine = (update) => {
    const parts = [update.action.toUpperCase(), update.mint];
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
const buildSummaryEmbed = (summary, updates) => {
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle('Paper Trading Summary')
        .setColor(0x58d68d)
        .addFields({
        name: 'Balance',
        value: `$${summary.balanceUsd.toFixed(2)}`,
        inline: true
    }, {
        name: 'Equity',
        value: `$${summary.equityUsd.toFixed(2)}`,
        inline: true
    }, {
        name: 'Realized PnL',
        value: `$${summary.realizedPnlUsd.toFixed(2)}`,
        inline: true
    }, {
        name: 'Unrealized PnL',
        value: `$${summary.unrealizedPnlUsd.toFixed(2)}`,
        inline: true
    }, {
        name: 'Win Rate',
        value: `${summary.tradeCount > 0 ? summary.winRatePercent.toFixed(2) : '0.00'}%`,
        inline: true
    }, {
        name: 'Average Hold',
        value: `${summary.averageHoldMinutes.toFixed(2)} min`,
        inline: true
    }, {
        name: 'Open Positions',
        value: `${summary.openPositions}`,
        inline: true
    }, {
        name: 'Trades Logged',
        value: `${summary.tradeCount}`,
        inline: true
    });
    if (updates.length > 0) {
        const lines = updates.slice(0, 10).map((update) => `• ${formatUpdateLine(update)}`);
        const remaining = updates.length - lines.length;
        if (remaining > 0) {
            lines.push(`…and ${remaining} more updates`);
        }
        embed.addFields({ name: 'Updates This Cycle', value: lines.join('\n'), inline: false });
    }
    else {
        embed.addFields({ name: 'Updates This Cycle', value: 'No trades executed this cycle.', inline: false });
    }
    return embed;
};
const sendPaperTradingSummary = async (client, channelId, summary, updates) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
        logger_1.default.error({ channelId }, 'Paper trading summary channel is not text-based or not found');
        return;
    }
    const embed = buildSummaryEmbed(summary, updates);
    try {
        await channel.send({ embeds: [embed] });
    }
    catch (err) {
        logger_1.default.error({ err, channelId }, 'Failed to send paper trading summary');
    }
};
exports.sendPaperTradingSummary = sendPaperTradingSummary;
