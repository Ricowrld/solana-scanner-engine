"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConnection = void 0;
const web3_js_1 = require("@solana/web3.js");
const createConnection = (rpcUrl) => {
    return new web3_js_1.Connection(rpcUrl, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60_000
    });
};
exports.createConnection = createConnection;
