/**
 * In-process MCP connection for embedding the ioBroker MCP server inside another adapter
 * (e.g. ioBroker.admin's chat helper) without an HTTP transport.
 *
 * The MCP SDK `Client` and `Server` are linked over an in-memory transport that lives entirely
 * in this module. The public {@link InProcessMcp} facade intentionally exposes only plain,
 * SDK-free shapes so consumers can depend on `iobroker.mcp` without resolving the MCP SDK's
 * subpath types themselves (important for consumers using classic `node` module resolution).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import McpServer from './mcp-server';

/** A tool exposed by the in-process MCP server, in a plain (SDK-free) shape. */
export interface InProcessToolInfo {
    /** Tool name, e.g. `list_devices`. */
    name: string;
    /** Human/LLM-readable description of what the tool does. */
    description?: string;
    /** JSON Schema (object schema) describing the tool's input arguments. */
    inputSchema: Record<string, unknown>;
}

/** Result of a tool call: the concatenated text content plus the error flag. */
export interface InProcessToolResult {
    /** Concatenated text of all text content blocks the tool returned. */
    text: string;
    /** True if the tool reported an error (the text then holds the error payload). */
    isError: boolean;
}

/** Options for {@link createInProcessMcp}. */
export interface InProcessMcpOptions {
    /** The host adapter the MCP server runs inside (its ACLs/connection are used for all calls). */
    adapter: ioBroker.Adapter;
    /** ioBroker user whose permissions every tool call runs with (default: `system.user.admin`). */
    defaultUser?: `system.user.${string}`;
    /** Language for localized output (rooms/devices/functions). */
    language?: ioBroker.Languages;
    /** Allow the state-writing tools `set_state`/`set_states` (default: false). */
    allowSetState?: boolean;
    /** Allow the object/file-changing tools (`create_state`, `set_object`, ...) (default: false). */
    allowObjectChange?: boolean;
    /** Name reported to the server by the embedded client. */
    clientName?: string;
    /** Version reported to the server by the embedded client. */
    clientVersion?: string;
}

/** A ready-to-use in-process MCP connection: list tools, call them, and close everything. */
export interface InProcessMcp {
    /** List the available tools (already filtered by the configured permission toggles). */
    listTools(): Promise<InProcessToolInfo[]>;
    /** Call a tool by name with the given arguments; returns its text result. */
    callTool(name: string, args?: Record<string, unknown>): Promise<InProcessToolResult>;
    /** Disconnect the client and server and release the host adapter's log listener. */
    close(): Promise<void>;
}

/** Content block shape returned by the MCP SDK for a tool call (only `text` blocks are used here). */
interface ToolContentBlock {
    type: string;
    text?: string;
}

/**
 * Create an in-process MCP server embedded in the given adapter and a linked client to drive it.
 *
 * @param options embedding options (host adapter, default user, language, permission toggles)
 * @returns a facade to list/call tools and to tear the connection down again
 */
export async function createInProcessMcp(options: InProcessMcpOptions): Promise<InProcessMcp> {
    const mcp = McpServer.createEmbedded({
        adapter: options.adapter,
        defaultUser: options.defaultUser,
        language: options.language,
        allowSetState: options.allowSetState,
        allowObjectChange: options.allowObjectChange,
    });

    const server = mcp.createInProcessServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
        {
            name: options.clientName || 'iobroker-inprocess-client',
            version: options.clientVersion || '1.0.0',
        },
        { capabilities: {} },
    );
    await client.connect(clientTransport);

    return {
        async listTools(): Promise<InProcessToolInfo[]> {
            const res = await client.listTools();
            return (res.tools || []).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
            }));
        },
        async callTool(name: string, args?: Record<string, unknown>): Promise<InProcessToolResult> {
            const res = await client.callTool({ name, arguments: args || {} });
            const blocks = (res.content as ToolContentBlock[] | undefined) || [];
            const text = blocks
                .filter(block => block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text as string)
                .join('\n');
            return { text, isError: !!res.isError };
        },
        async close(): Promise<void> {
            try {
                await client.close();
            } catch {
                // ignore
            }
            try {
                await server.close();
            } catch {
                // ignore
            }
            mcp.unload();
        },
    };
}
