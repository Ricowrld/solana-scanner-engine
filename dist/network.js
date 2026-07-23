"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpsAgent = void 0;
const node_https_1 = __importDefault(require("node:https"));
exports.httpsAgent = new node_https_1.default.Agent({
    keepAlive: true
});
