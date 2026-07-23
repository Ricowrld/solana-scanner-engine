"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeJupiterSwap = exports.getJupiterQuote = void 0;
const axios_1 = __importDefault(require("axios"));
const web3_js_1 = require("@solana/web3.js");
const getJupiterQuote = async ({ inputMint, outputMint, amount, slippageBps }) => {
    const url = "https://quote-api.jup.ag/v6/quote";
    const { data } = await axios_1.default.get(url, {
        params: {
            inputMint,
            outputMint,
            amount,
            slippageBps
        },
        timeout: 15000
    });
    return data;
};
exports.getJupiterQuote = getJupiterQuote;
const executeJupiterSwap = async ({ connection, wallet, quoteResponse }) => {
    const swapUrl = "https://quote-api.jup.ag/v6/swap";
    const { data } = await axios_1.default.post(swapUrl, {
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true
    }, {
        timeout: 20000,
        headers: { "Content-Type": "application/json" }
    });
    if (!data?.swapTransaction) {
        throw new Error("Jupiter swap response missing swapTransaction");
    }
    const txBuf = Buffer.from(data.swapTransaction, "base64");
    const tx = web3_js_1.VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3
    });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
};
exports.executeJupiterSwap = executeJupiterSwap;
