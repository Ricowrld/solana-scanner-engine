import { FilterThresholds, JupiterQuoteResponse, QuoteEvaluation } from './types';

interface QuoteEvaluationParams {
  quote: JupiterQuoteResponse | null;
  inputDecimals: number;
  outputDecimals: number;
  maxPriceImpactPct: number;
}

const toDecimalAmount = (value: string | undefined, decimals: number): number => {
  if (!value) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric / 10 ** decimals;
};

const extractRoute = (quote: JupiterQuoteResponse): string[] => {
  if (!quote.routePlan) {
    return [];
  }

  return quote.routePlan
    .map((step) => step.swapInfo?.label ?? step.swapInfo?.ammKey ?? 'Unknown')
    .filter((label) => Boolean(label)) as string[];
};

export const evaluateQuoteQuality = ({
  quote,
  inputDecimals,
  outputDecimals,
  maxPriceImpactPct
}: QuoteEvaluationParams): QuoteEvaluation => {
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

export const evaluateMomentum = (
  priceChange1mPercent: number,
  priceChange5mPercent: number,
  priceChange1hPercent: number,
  thresholds: FilterThresholds
): QuoteEvaluation => {
  const passes5m = priceChange5mPercent >= thresholds.minPriceChange5mPercent;
  const passes1h = priceChange1hPercent >= thresholds.minPriceChange1hPercent;
  const passes1m = priceChange1mPercent >= thresholds.minPriceChange1mPercent;

  // Ignore 1m-only spikes. Require confirmation from a slower window.
  if (passes5m || passes1h) {
    return { shouldAlert: true };
  }

  const reasons: string[] = [];
  if (passes1m && !passes5m && !passes1h) {
    reasons.push(
      `1m price change ${priceChange1mPercent.toFixed(2)}% passed, but 5m/1h confirmation is missing`
    );
  } else if (!passes1m) {
    reasons.push(
      `1m price change ${priceChange1mPercent.toFixed(2)}% < ${thresholds.minPriceChange1mPercent}%`
    );
  }
  if (!passes5m) {
    reasons.push(
      `5m price change ${priceChange5mPercent.toFixed(2)}% < ${thresholds.minPriceChange5mPercent}%`
    );
  }
  if (!passes1h) {
    reasons.push(
      `1h price change ${priceChange1hPercent.toFixed(2)}% < ${thresholds.minPriceChange1hPercent}%`
    );
  }

  return {
    shouldAlert: false,
    reason: reasons.join('; ')
  };
};
