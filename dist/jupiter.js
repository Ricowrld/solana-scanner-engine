"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchJupiterQuote = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./logger"));
const network_1 = require("./network");
const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const buildHeaders = () => {
    if (!config_1.default.jupiter.apiKey) {
        return {};
    }
    return {
        'x-api-key': config_1.default.jupiter.apiKey
    };
};
const shouldRetry = (error) => {
    const code = error?.code;
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
        return true;
    }
    if (axios_1.default.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        return status >= 500 && status < 600;
    }
    return false;
};
const fetchJupiterQuote = async (options) => {
    const amount = options.amount ?? config_1.default.jupiter.inputAmount;
    const params = {
        inputMint: config_1.default.jupiter.inputMint,
        outputMint: options.outputMint,
        amount,
        swapMode: 'ExactIn',
        slippageBps: String(config_1.default.jupiter.slippageBps)
    };
    if (config_1.default.jupiter.onlyDirectRoutes) {
        params.onlyDirectRoutes = 'true';
    }
    if (config_1.default.jupiter.excludeDexes.length > 0) {
        params.excludeDexes = config_1.default.jupiter.excludeDexes.join(',');
    }
    if (config_1.default.jupiter.includeDexes.length > 0) {
        params.dexes = config_1.default.jupiter.includeDexes.join(',');
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const performRequest = async (params) => {
        const startedAt = Date.now();
        try {
            const response = await axios_1.default.get(JUPITER_QUOTE_URL, {
                headers: buildHeaders(),
                params,
                timeout: 7_000,
                httpsAgent: network_1.httpsAgent
            });
            return {
                quote: response.data,
                httpStatus: response.status,
                latencyMs: Date.now() - startedAt
            };
        }
        catch (error) {
            error.latencyMs = Date.now() - startedAt;
            throw error;
        }
    };
    const runWithRetry = async (params) => {
        try {
            return await performRequest(params);
        }
        catch (error) {
            if (shouldRetry(error)) {
                await sleep(500);
                try {
                    return await performRequest(params);
                }
                catch (secondError) {
                    throw secondError;
                }
            }
            throw error;
        }
    };
    try {
        return await runWithRetry(params);
    }
    catch (error) {
        if (axios_1.default.isAxiosError(error)) {
            const axiosError = error;
            const status = axiosError.response?.status;
            const latencyMs = axiosError.latencyMs;
            if (status === 404 || status === 422) {
                logger_1.default.debug({
                    outputMint: options.outputMint,
                    status,
                    body: axiosError.response?.data
                }, 'No valid Jupiter route for token');
                return {
                    quote: null,
                    failureReason: 'NO_ROUTE',
                    httpStatus: status,
                    latencyMs
                };
            }
            if (status === 400) {
                logger_1.default.warn({
                    outputMint: options.outputMint,
                    status,
                    body: axiosError.response?.data
                }, 'Bad request to Jupiter quote API');
                return { quote: null, failureReason: 'BAD_REQUEST', httpStatus: status, latencyMs };
            }
            if (status === 429) {
                logger_1.default.warn({ outputMint: options.outputMint }, 'Rate limited by Jupiter quote API');
                return { quote: null, failureReason: 'RATE_LIMITED', httpStatus: status, latencyMs };
            }
            logger_1.default.warn({ err: axiosError, outputMint: options.outputMint }, 'Failed to fetch Jupiter quote');
            return { quote: null, failureReason: 'API_ERROR', httpStatus: status, latencyMs };
        }
        logger_1.default.warn({ err: error, outputMint: options.outputMint }, 'Unexpected error fetching Jupiter quote');
        return { quote: null, failureReason: 'API_ERROR' };
    }
};
exports.fetchJupiterQuote = fetchJupiterQuote;
