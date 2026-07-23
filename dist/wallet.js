"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadKeypairFromFile = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const web3_js_1 = require("@solana/web3.js");
const loadKeypairFromFile = (filePath) => {
    const absolutePath = node_path_1.default.isAbsolute(filePath)
        ? filePath
        : node_path_1.default.join(process.cwd(), filePath);
    if (!node_fs_1.default.existsSync(absolutePath)) {
        throw new Error(`Wallet file not found: ${absolutePath}`);
    }
    const raw = node_fs_1.default.readFileSync(absolutePath, "utf-8");
    const secretKey = Uint8Array.from(JSON.parse(raw));
    return web3_js_1.Keypair.fromSecretKey(secretKey);
};
exports.loadKeypairFromFile = loadKeypairFromFile;
