"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInProcessMcp = createInProcessMcp;
/**
 * In-process MCP connection for embedding the ioBroker MCP server inside another adapter
 * (e.g. ioBroker.admin's chat helper) without an HTTP transport.
 *
 * The MCP SDK `Client` and `Server` are linked over an in-memory transport that lives entirely
 * in this module. The public {@link InProcessMcp} facade intentionally exposes only plain,
 * SDK-free shapes so consumers can depend on `iobroker.mcp` without resolving the MCP SDK's
 * subpath types themselves (important for consumers using classic `node` module resolution).
 */
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const inMemory_js_1 = require("@modelcontextprotocol/sdk/inMemory.js");
const mcp_server_1 = __importDefault(require("./mcp-server"));
/**
 * Create an in-process MCP server embedded in the given adapter and a linked client to drive it.
 *
 * @param options embedding options (host adapter, default user, language, permission toggles)
 * @returns a facade to list/call tools and to tear the connection down again
 */
async function createInProcessMcp(options) {
    const mcp = mcp_server_1.default.createEmbedded({
        adapter: options.adapter,
        defaultUser: options.defaultUser,
        language: options.language,
        allowSetState: options.allowSetState,
        allowObjectChange: options.allowObjectChange,
    });
    const server = mcp.createInProcessServer();
    const [clientTransport, serverTransport] = inMemory_js_1.InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new index_js_1.Client({
        name: options.clientName || 'iobroker-inprocess-client',
        version: options.clientVersion || '1.0.0',
    }, { capabilities: {} });
    await client.connect(clientTransport);
    return {
        async listTools() {
            const res = await client.listTools();
            return (res.tools || []).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            }));
        },
        async callTool(name, args) {
            const res = await client.callTool({ name, arguments: args || {} });
            const blocks = res.content || [];
            const text = blocks
                .filter(block => block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text)
                .join('\n');
            return { text, isError: !!res.isError };
        },
        async close() {
            try {
                await client.close();
            }
            catch {
                // ignore
            }
            try {
                await server.close();
            }
            catch {
                // ignore
            }
            mcp.unload();
        },
    };
}
//# sourceMappingURL=inProcessClient.js.map