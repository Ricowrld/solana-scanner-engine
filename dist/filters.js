"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateMomentum = exports.evaluateQuoteQuality = void 0;
const toDecimalAmount = (value, decimals) => {
    if (!value) {
        return 0;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return 0;
    }
    return numeric / 10 ** decimals;
};
const extractRoute = (quote) => {
    if (!quote.routePlan) {
        return [];
    }
    return quote.routePlan
        .map((step) => step.swapInfo?.label ?? step.swapInfo?.ammKey ?? 'Unknown')
        .filter((label) => Boolean(label));
};
const evaluateQuoteQuality = ({ quote, inputDecimals, outputDecimals, maxPriceImpactPct }) => {
    if (!quote) {
        return { shouldAlert: false, reason: 'No Jupiter route or quote unavailable' };
    }
    if (!quote.routePlan || quote.routePlan.length === 0) {
        return { shouldAlert: false, reason: 'Jupiter returned empty route plan' };
    }
    const priceImpactPct = Number(quote.priceImpactPct ?? 0);
    if (!Number.isFinite(priceImpactPct)) {
        return { shouldAlert: false, reason: 'Invalid price impact from Jupiter' };
    }
    if (priceImpactPct > maxPriceImpactPct) {
        return {
            shouldAlert: false,
            reason: `Price impact ${priceImpactPct.toFixed(2)}% > ${maxPriceImpactPct}%`,
            priceImpactPct
        };
    }
    const inputAmount = toDecimalAmount(quote.inAmount, inputDecimals);
    const outputAmount = toDecimalAmount(quote.outAmount, outputDecimals);
    if (inputAmount <= 0 || outputAmount <= 0) {
        return {
            shouldAlert: false,
            reason: 'Invalid quote amounts returned from Jupiter',
            priceImpactPct,
            inputAmount,
            outputAmount
        };
    }
    return {
        shouldAlert: true,
        priceImpactPct,
        inputAmount,
        outputAmount,
        route: extractRoute(quote)
    };
};
exports.evaluateQuoteQuality = evaluateQuoteQuality;
const evaluateMomentum = (priceChange1mPercent, priceChange5mPercent, priceChange1hPercent, thresholds) => {
    const passes5m = priceChange5mPercent >= thresholds.minPriceChange5mPercent;
    const passes1h = priceChange1hPercent >= thresholds.minPriceChange1hPercent;
    const passes1m = priceChange1mPercent >= thresholds.minPriceChange1mPercent;
    // Ignore 1m-only spikes. Require confirmation from a slower window.
    if (passes5m || passes1h) {
        return { shouldAlert: true };
    }
    const reasons = [];
    if (passes1m && !passes5m && !passes1h) {
        reasons.push(`1m price change ${priceChange1mPercent.toFixed(2)}% passed, but 5m/1h confirmation is missing`);
    }
    else if (!passes1m) {
        reasons.push(`1m price change ${priceChange1mPercent.toFixed(2)}% < ${thresholds.minPriceChange1mPercent}%`);
    }
    if (!passes5m) {
        reasons.push(`5m price change ${priceChange5mPercent.toFixed(2)}% < ${thresholds.minPriceChange5mPercent}%`);
    }
    if (!passes1h) {
        reasons.push(`1h price change ${priceChange1hPercent.toFixed(2)}% < ${thresholds.minPriceChange1hPercent}%`);
    }
    return {
        shouldAlert: false,
        reason: reasons.join('; ')
    };
};
exports.evaluateMomentum = evaluateMomentum;
