import axios, { AxiosError } from 'axios';

import config from './config';
import logger from './logger';
import { httpsAgent } from './network';
import { JupiterQuoteResponse, QuoteFailureReason, QuoteFetchResult } from './types';

const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';

const buildHeaders = (): Record<string, string> => {
  if (!config.jupiter.apiKey) {
    return {};
  }

  return {
    'x-api-key': config.jupiter.apiKey
  };
};

export interface QuoteRequestOptions {
  inputMint?: string;
  outputMint: string;
  amount?: string;
}

const shouldRetry = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    return status >= 500 && status < 600;
  }

  return false;
};

export const fetchJupiterQuote = async (
  options: QuoteRequestOptions
): Promise<QuoteFetchResult> => {
  const amount = options.amount ?? config.jupiter.inputAmount;
  const inputMint = options.inputMint ?? config.jupiter.inputMint;

  const params: Record<string, string> = {
    inputMint,
    outputMint: options.outputMint,
    amount,
    swapMode: 'ExactIn',
    slippageBps: String(config.jupiter.slippageBps)
  };

  if (config.jupiter.onlyDirectRoutes) {
    params.onlyDirectRoutes = 'true';
  }

  if (config.jupiter.excludeDexes.length > 0) {
    params.excludeDexes = config.jupiter.excludeDexes.join(',');
  }

  if (config.jupiter.includeDexes.length > 0) {
    params.dexes = config.jupiter.includeDexes.join(',');
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const performRequest = async (params: Record<string, string>): Promise<QuoteFetchResult> => {
    const startedAt = Date.now();
    try {
      const response = await axios.get<JupiterQuoteResponse>(JUPITER_QUOTE_URL, {
        headers: buildHeaders(),
        params,
        timeout: 7_000,
        httpsAgent
      });

      return {
        quote: response.data,
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      (error as AxiosError & { latencyMs?: number }).latencyMs = Date.now() - startedAt;
      throw error;
    }
  };

  const runWithRetry = async (params: Record<string, string>): Promise<QuoteFetchResult> => {
    try {
      return await performRequest(params);
    } catch (error) {
      if (shouldRetry(error)) {
        await sleep(500);
        try {
          return await performRequest(params);
        } catch (secondError) {
          throw secondError;
        }
      }

      throw error;
    }
  };

  try {
    return await runWithRetry(params);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: string }>;
      const status = axiosError.response?.status;
      const latencyMs = (axiosError as AxiosError & { latencyMs?: number }).latencyMs;

      if (status === 404 || status === 422) {
        logger.debug(
          {
            outputMint: options.outputMint,
            status,
            body: axiosError.response?.data
          },
          'No valid Jupiter route for token'
        );
        return {
          quote: null,
          failureReason: 'NO_ROUTE',
          httpStatus: status,
          latencyMs
        };
      }

      if (status === 400) {
        logger.warn(
          {
            outputMint: options.outputMint,
            status,
            body: axiosError.response?.data
          },
          'Bad request to Jupiter quote API'
        );
        return { quote: null, failureReason: 'BAD_REQUEST', httpStatus: status, latencyMs };
      }

      if (status === 429) {
        logger.warn({ outputMint: options.outputMint }, 'Rate limited by Jupiter quote API');
        return { quote: null, failureReason: 'RATE_LIMITED', httpStatus: status, latencyMs };
      }

      logger.warn({ err: axiosError, outputMint: options.outputMint }, 'Failed to fetch Jupiter quote');
      return { quote: null, failureReason: 'API_ERROR', httpStatus: status, latencyMs };
    }

    logger.warn({ err: error, outputMint: options.outputMint }, 'Unexpected error fetching Jupiter quote');
    return { quote: null, failureReason: 'API_ERROR' };
  }
};
