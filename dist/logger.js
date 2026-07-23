"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pino_1 = __importDefault(require("pino"));
const config_1 = __importDefault(require("./config"));
const logger = (0, pino_1.default)({
    level: config_1.default.logLevel,
    transport: process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'UTC:yyyy-mm-dd HH:MM:ss'
            }
        }
        : undefined
});
exports.default = logger;
