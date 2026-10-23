"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = void 0;
// Entry point for the web adapter (`common.webExtension` in io-package.json): it requires this file and
// instantiates the default export as a web extension.
var mcp_server_1 = require("@iobroker/mcp-server");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(mcp_server_1).default; } });
//# sourceMappingURL=mcp-server.js.map