"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("./logger"));
const wallet_1 = require("./wallet");
const solana_1 = require("./solana");
const trade_1 = require("./trade");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const run = async () => {
    const wallet = (0, wallet_1.loadKeypairFromFile)(process.env.WALLET_PATH || "bot-wallet.json");
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = (0, solana_1.createConnection)(rpcUrl);
    logger_1.default.info({ pubkey: wallet.publicKey.toBase58() }, "Loaded wallet");
    // 1 USDC = 1_000_000 (because USDC decimals = 6)
    const quote = await (0, trade_1.getJupiterQuote)({
        inputMint: USDC,
        outputMint: SOL,
        amount: 1_000_000,
        slippageBps: 50
    });
    logger_1.default.info({
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct
    }, "Quote received");
    if (process.env.TRADING_ENABLED !== "true") {
        logger_1.default.warn("TRADING_ENABLED is false, not executing swap.");
        return;
    }
    const sig = await (0, trade_1.executeJupiterSwap)({
        connection,
        wallet,
        quoteResponse: quote
    });
    logger_1.default.info({ sig }, "Swap executed");
};
run().catch((err) => {
    logger_1.default.error({ err }, "Trade test failed");
});
