"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveJsonCache = exports.loadJsonCache = exports.saveCache = exports.loadCache = exports.ensureDirectory = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const logger_1 = __importDefault(require("./logger"));
const ensureDirectory = async (filePath) => {
    const directory = node_path_1.default.dirname(filePath);
    await node_fs_1.promises.mkdir(directory, { recursive: true });
};
exports.ensureDirectory = ensureDirectory;
const readJsonFile = async (filePath, fallback) => {
    try {
        const raw = await node_fs_1.promises.readFile(filePath, 'utf-8');
        const sanitized = raw.replace(/\u0000/g, '').trim();
        if (!sanitized) {
            logger_1.default.warn({ filePath }, 'Cache file empty or invalid, using fallback');
            return fallback;
        }
        try {
            return JSON.parse(sanitized);
        }
        catch (parseError) {
            logger_1.default.error({ err: parseError, filePath }, 'Failed to parse cache JSON, using fallback');
            return fallback;
        }
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            logger_1.default.info({ filePath }, 'Cache file not found, creating new one');
            return fallback;
        }
        logger_1.default.error({ err: error }, 'Failed to load cache');
        throw error;
    }
};
const writeJsonFile = async (filePath, payload) => {
    try {
        await (0, exports.ensureDirectory)(filePath);
        await node_fs_1.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    }
    catch (error) {
        logger_1.default.error({ err: error }, 'Failed to save cache');
        throw error;
    }
};
const loadCache = async (filePath) => {
    return readJsonFile(filePath, {});
};
exports.loadCache = loadCache;
const saveCache = async (filePath, cache) => {
    await writeJsonFile(filePath, cache);
};
exports.saveCache = saveCache;
const loadJsonCache = async (filePath, fallback) => {
    return readJsonFile(filePath, fallback);
};
exports.loadJsonCache = loadJsonCache;
const saveJsonCache = async (filePath, payload) => {
    await writeJsonFile(filePath, payload);
};
exports.saveJsonCache = saveJsonCache;
