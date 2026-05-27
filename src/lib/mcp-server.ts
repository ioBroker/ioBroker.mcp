import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { McpServer as McpSdkServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAiFriendlyStructure, type Room } from './devices';
import { iobUriParse } from './iob-uri';
import type { McpAdapter, McpAdapterConfig } from './types';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

const SERVER_NAME = 'iobroker-mcp';
const SERVER_VERSION = '0.0.1';

/** Result shape expected by the MCP SDK tool callbacks. */
type ToolResult = {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
};

/** Map the human-friendly aggregation names from the manifest to ioBroker history values. */
const AGG_MAP: Record<string, ioBroker.GetHistoryOptions['aggregate']> = {
    raw: 'none',
    min: 'min',
    max: 'max',
    avg: 'average',
    sum: 'total',
};
const WEB_EXTENSION_PREFIX = 'mcp/';

/** Languages offered for localized names. */
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'] as const;

/** Localize an ioBroker name to a plain string for the given language. */
function getText(text: ioBroker.StringOrTranslated | undefined, language: ioBroker.Languages): string {
    if (!text) {
        return '';
    }
    if (typeof text === 'string') {
        return text;
    }
    return text[language] || text.en || '';
}

/** Loose view over an object's `common` for cross-type metadata access. */
type AnyCommon = {
    name?: ioBroker.StringOrTranslated;
    color?: string;
    icon?: string;
    type?: ioBroker.CommonType;
    role?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    members?: string[];
};

interface EnumItem {
    id: string;
    name: ioBroker.StringOrTranslated;
    type: ioBroker.ObjectType;
    color?: string;
    icon?: string;
    stateType?: ioBroker.CommonType;
    role?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
}
interface EnumResponse {
    id: string;
    name: ioBroker.StringOrTranslated;
    color?: string;
    icon?: string;
    items: EnumItem[];
}

/**
 * MCP (Model Context Protocol) server for ioBroker.
 *
 * Exposes ioBroker functionality as MCP tools over the "Streamable HTTP" transport
 * (POST/GET/DELETE on `/mcp`). Each client session gets its own SDK server instance
 * and transport, tracked by the `Mcp-Session-Id` header.
 */
/** Per-session context: its transport, SDK server and the set of subscribed resource URIs. */
interface SessionContext {
    transport: StreamableHTTPServerTransport;
    server: McpSdkServer;
    /** Canonical ioBroker URIs this session subscribed to (e.g. iobstate://id, iobobject://id, ioblog://all). */
    subscriptions: Set<string>;
}

/** URI prefix for the (non-standard, ioBroker-specific) log stream resource. */
const LOG_URI_PREFIX = 'ioblog://';
/** How many recent log lines to keep for `ioblog://` resource reads. */
const LOG_BUFFER_SIZE = 200;

export default class McpServer {
    private readonly adapter: McpAdapter;
    private readonly app: Express;
    /** Active sessions keyed by session id. */
    private readonly sessions: Record<string, SessionContext> = {};
    /** Ref-count of adapter-level subscriptions across all sessions, keyed by "<type>:<address>" or "log". */
    private readonly subscriptionCounts: Record<string, number> = {};
    /** Recent log lines kept for `ioblog://` resource reads (filled while there are log subscribers). */
    private readonly logBuffer: ioBroker.LogMessage[] = [];
    private config: McpAdapterConfig;
    private readonly namespace: string;
    private readonly extension: boolean;
    private readonly routerPrefix: string;
    /** The ioBroker user whose permissions every MCP request runs with. */
    private readonly defaultUser: `system.user.${string}`;
    /** Default language used to localize device/room/function names. */
    private readonly language: ioBroker.Languages;

    constructor(
        server: HttpServer | HttpsServer,
        webSettings: {
            secure: boolean;
            port: number | string;
            defaultUser?: `system.user.${string}`;
            auth?: boolean;
            language?: ioBroker.Languages;
        },
        adapter: McpAdapter,
        instanceSettings: ioBroker.InstanceObject | null,
        app: Express,
    ) {
        this.app = app;
        this.adapter = adapter;
        this.config = instanceSettings ? (instanceSettings.native as McpAdapterConfig) : adapter.config;
        this.namespace = instanceSettings
            ? instanceSettings._id.substring('system.adapter.'.length)
            : this.adapter.namespace;
        this.extension = !!instanceSettings;
        this.routerPrefix = this.extension ? `/${WEB_EXTENSION_PREFIX}` : '/';

        // Determine the ioBroker user whose permissions all MCP requests run with.
        // Prefer this adapter's own setting; when embedded fall back to the host web server's
        // default user; finally to "admin". Always normalize to the "system.user." prefix.
        const rawUser = (this.config.defaultUser || webSettings.defaultUser || 'admin') as string;
        this.defaultUser = (
            rawUser.startsWith('system.user.') ? rawUser : `system.user.${rawUser}`
        ) as `system.user.${string}`;
        this.config.defaultUser = this.defaultUser;
        this.language = webSettings.language || 'en';

        // Permission toggles: state writes are allowed by default, object/file changes are not.
        this.config.allowSetState = this.config.allowSetState !== false;
        this.config.allowObjectChange = this.config.allowObjectChange === true;

        // Receive ioBroker log messages (only forwarded once a session subscribes via requireLog).
        this.adapter.on('log', this.onLog);

        this.initRoutes();
    }

    private initRoutes(): void {
        // The MCP endpoint. In standalone mode this is `/mcp`; as a web extension we own the
        // `/<adapter>/` namespace (e.g. `/mcp/`) within the shared web server. `.replace` strips
        // the trailing slash so the route matches both `/mcp` and `/mcp/` (Express, non-strict).
        const mcpPath = this.extension ? this.routerPrefix.replace(/\/$/, '') : '/mcp';
        // The MCP transport needs a parsed JSON body; apply the parser per-route so we never
        // touch the body handling of the web adapter or other extensions when running embedded.
        const jsonParser = express.json({ limit: '4mb' });

        // Health endpoint inside our own namespace (`/status` standalone, `/mcp/status` embedded).
        this.app.get(`${this.routerPrefix}status`, (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now(),
                sessions: Object.keys(this.sessions).length,
            });
        });

        // Global middleware and root/info endpoints only when we own the whole app (standalone).
        // As an extension these would collide with the web adapter's own routes.
        if (!this.extension) {
            this.app.use((req: Request, _res: Response, next: NextFunction) => {
                this.adapter.log.debug(`${req.method} ${req.url} from ${req.ip}`);
                next();
            });

            this.app.get('/', (_req: Request, res: Response) => {
                res.json({
                    name: 'ioBroker MCP Server',
                    version: SERVER_VERSION,
                    status: 'running',
                    mcpEndpoint: '/mcp',
                });
            });

            this.app.get('/api/info', (_req: Request, res: Response) => {
                res.json({
                    adapter: 'mcp',
                    version: SERVER_VERSION,
                    secure: this.config.secure,
                    auth: this.config.auth,
                });
            });
        }

        // --- MCP Streamable HTTP transport ---
        this.app.post(mcpPath, jsonParser, (req: Request, res: Response) => {
            void this.handleMcpPost(req, res);
        });
        this.app.get(mcpPath, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });
        this.app.delete(mcpPath, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });

        // Catch-all 404 + error handlers only in standalone mode; the web adapter provides its own.
        if (!this.extension) {
            this.app.use((req: Request, res: Response) => {
                res.status(404).json({ error: 'Not Found', path: req.url });
            });

            this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
                this.adapter.log.error(`Server error: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal Server Error', message: err.message });
                }
            });
        }
    }

    /**
     * Called by the ioBroker web adapter to list this extension on its welcome/intro page.
     * Only relevant when running embedded.
     */
    welcomePage(): { link: string; name: string; img: string; color: string; order: number; pro: boolean } {
        return {
            link: WEB_EXTENSION_PREFIX,
            name: 'MCP Server',
            img: 'adapter/mcp/mcp.png',
            color: '#157ac9',
            order: 10,
            pro: false,
        };
    }

    /** Handle client -> server messages (initialize, tools/call, ...). */
    private async handleMcpPost(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? this.sessions[sessionId]?.transport : undefined;

        if (!transport) {
            // No session yet: only an "initialize" request may create one.
            if (sessionId || !isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                    id: null,
                });
                return;
            }

            const subscriptions = new Set<string>();
            const server = this.createServer(subscriptions);

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid: string) => {
                    this.sessions[sid] = { transport: transport!, server, subscriptions };
                    this.adapter.log.debug(`MCP session initialized: ${sid}`);
                },
            });

            transport.onclose = () => {
                const sid = transport!.sessionId;
                if (sid && this.sessions[sid]) {
                    void this.cleanupSession(this.sessions[sid]);
                    delete this.sessions[sid];
                    this.adapter.log.debug(`MCP session closed: ${sid}`);
                }
            };

            await server.connect(transport);
        }

        await transport.handleRequest(req, res, req.body);
    }

    /** Handle server -> client SSE stream (GET) and session termination (DELETE). */
    private async handleMcpSessionRequest(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = sessionId ? this.sessions[sessionId]?.transport : undefined;
        if (!transport) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        await transport.handleRequest(req, res);
    }

    /**
     * Forward an ioBroker state change to subscribed sessions.
     *
     * Called by our own adapter (standalone) or by the host web adapter (extension mode), which
     * invokes `stateChange` on every web extension that defines it.
     */
    stateChange(id: string, _state: ioBroker.State | null | undefined): void {
        this.notifySubscribers('state', id);
    }

    /**
     * Forward an ioBroker object change to subscribed sessions. Called by our own adapter
     * (standalone) or automatically by the host web adapter (extension mode).
     */
    objectChange(id: string, _obj: ioBroker.Object | null | undefined): void {
        this.notifySubscribers('object', id);
    }

    /** Push `resources/updated` to every session subscribed to the given state/object id. */
    private notifySubscribers(type: 'state' | 'object', id: string): void {
        for (const sid of Object.keys(this.sessions)) {
            const session = this.sessions[sid];
            for (const uri of session.subscriptions) {
                if (uri.startsWith(LOG_URI_PREFIX)) {
                    continue;
                }
                const parsed = iobUriParse(uri);
                if (parsed.type === type && parsed.address === id) {
                    session.server.server.sendResourceUpdated({ uri }).catch(e => {
                        this.adapter.log.debug(`Cannot notify session ${sid} about ${uri}: ${e}`);
                    });
                }
            }
        }
    }

    /** Receive an ioBroker log line: buffer it and push `resources/updated` to ioblog subscribers. */
    private onLog = (message: ioBroker.LogMessage): void => {
        this.logBuffer.push(message);
        if (this.logBuffer.length > LOG_BUFFER_SIZE) {
            this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_SIZE);
        }
        for (const sid of Object.keys(this.sessions)) {
            const session = this.sessions[sid];
            for (const uri of session.subscriptions) {
                if (!uri.startsWith(LOG_URI_PREFIX)) {
                    continue;
                }
                const source = uri.substring(LOG_URI_PREFIX.length) || 'all';
                if (source === 'all' || source === message.from) {
                    session.server.server.sendResourceUpdated({ uri }).catch(e => {
                        this.adapter.log.debug(`Cannot notify session ${sid} about ${uri}: ${e}`);
                    });
                }
            }
        }
    };

    /** Classify a resource URI into its subscription kind, address and ref-count key. */
    private uriKind(uri: string): { kind: 'state' | 'object' | 'log' | 'other'; address: string; key: string } {
        if (uri.startsWith(LOG_URI_PREFIX)) {
            return { kind: 'log', address: uri.substring(LOG_URI_PREFIX.length) || 'all', key: 'log' };
        }
        const { type, address } = iobUriParse(uri);
        if (type === 'state' || type === 'object') {
            return { kind: type, address, key: `${type}:${address}` };
        }
        return { kind: 'other', address: '', key: '' };
    }

    /** Add an adapter-level subscription, subscribing on the adapter only on the first reference. */
    private async refSubscribe(uri: string): Promise<void> {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other') {
            return;
        }
        if (!this.subscriptionCounts[key]) {
            this.subscriptionCounts[key] = 0;
            if (kind === 'log') {
                await this.adapter.requireLog?.(true);
            } else if (kind === 'object') {
                await this.adapter.subscribeForeignObjectsAsync(address);
            } else {
                await this.adapter.subscribeForeignStatesAsync(address);
            }
        }
        this.subscriptionCounts[key]++;
    }

    /** Drop an adapter-level subscription, unsubscribing on the adapter when the last reference goes. */
    private async refUnsubscribe(uri: string): Promise<void> {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other' || !this.subscriptionCounts[key]) {
            return;
        }
        this.subscriptionCounts[key]--;
        if (this.subscriptionCounts[key] <= 0) {
            delete this.subscriptionCounts[key];
            if (kind === 'log') {
                await this.adapter.requireLog?.(false);
            } else if (kind === 'object') {
                await this.adapter.unsubscribeForeignObjectsAsync(address);
            } else {
                await this.adapter.unsubscribeForeignStatesAsync(address);
            }
        }
    }

    /** Release all subscriptions held by a session (on close). */
    private async cleanupSession(session: SessionContext): Promise<void> {
        for (const uri of session.subscriptions) {
            await this.refUnsubscribe(uri);
        }
        session.subscriptions.clear();
    }

    /**
     * Create a new MCP SDK server with all ioBroker tools registered.
     *
     * @param subscriptions the per-session set of subscribed state ids (mutated by subscribe/unsubscribe)
     */
    private createServer(subscriptions: Set<string>): McpSdkServer {
        const server = new McpSdkServer(
            { name: SERVER_NAME, version: SERVER_VERSION },
            { capabilities: { tools: {}, resources: { subscribe: true } } },
        );

        const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
        const fail = (error: unknown): ToolResult => {
            const message = error instanceof Error ? error.message : String(error);
            this.adapter.log.warn(`MCP tool error: ${message}`);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
        };

        server.registerTool(
            'get_states',
            {
                description: 'Retrieve the current value of one or multiple states',
                inputSchema: { ids: z.array(z.string()).describe('Array of state IDs') },
            },
            async ({ ids }) => {
                try {
                    return ok({ ok: true, data: { states: await this.getStates(ids) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        if (this.config.allowSetState) {
            server.registerTool(
                'set_state',
                {
                    description: 'Set the value of a state. The value is coerced to the state type (boolean/number/string).',
                    inputSchema: {
                        id: z.string().describe('State ID'),
                        value: z.any().describe('New value (type depends on the state)'),
                        options: z
                            .object({ ack: z.boolean().default(false), expire: z.number().int().nullable().optional() })
                            .optional(),
                    },
                },
                async ({ id, value, options }) => {
                    try {
                        const written = await this.setState(id, value, options?.ack ?? false);
                        return ok({ ok: true, data: { id, value: written } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        server.registerTool(
            'get_logs',
            {
                description: 'Retrieve system logs',
                inputSchema: {
                    level: z.array(z.enum(['error', 'warn', 'info', 'debug'])).optional(),
                    from_ts: z.number().int().optional(),
                    limit: z.number().int().default(200),
                    adapter: z.string().optional(),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { logs: await this.getLogs(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool('system_info', { description: 'Get system and js-controller information' }, async () => {
            try {
                return ok({ ok: true, data: await this.getSystemInfo() });
            } catch (e) {
                return fail(e);
            }
        });

        server.registerTool(
            'search_objects',
            {
                description: 'Search objects and states by keywords',
                inputSchema: {
                    query: z.string().describe('Keyword to search for'),
                    role: z.string().optional(),
                    room: z.string().optional(),
                    limit: z.number().int().default(50),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { results: await this.searchObjects(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_devices',
            {
                description:
                    'List detected devices grouped by room. Uses the ioBroker type-detector to turn ' +
                    'raw states/channels/devices into functional devices with named controls.',
                inputSchema: {
                    language: z
                        .enum(['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'])
                        .optional()
                        .describe('Language for device/room/function names (defaults to the adapter language)'),
                    room: z.string().optional().describe('Filter the result to a single room (by name)'),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { rooms: await this.listDevices(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'history_query',
            {
                description: 'Query historical values of a state (requires a history adapter)',
                inputSchema: {
                    id: z.string(),
                    from: z.string().optional().describe('Start time (ISO8601)'),
                    to: z.string().optional().describe('End time (ISO8601)'),
                    agg: z.enum(['raw', 'min', 'max', 'avg', 'sum']).default('raw'),
                    interval: z.string().optional().describe('Aggregation interval, e.g. 15m, 1h'),
                    limit: z.number().int().default(1000),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: await this.historyQuery(args) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_instances',
            { description: 'List all adapter instances with their status' },
            async () => {
                try {
                    return ok({ ok: true, data: { instances: await this.listInstances() } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool('list_hosts', { description: 'List all ioBroker hosts with their status' }, async () => {
            try {
                return ok({ ok: true, data: { hosts: await this.listHosts() } });
            } catch (e) {
                return fail(e);
            }
        });

        const enumInput = {
            language: z.enum(LANGUAGES).optional().describe('Language for names (defaults to the adapter language)'),
            withIcons: z.boolean().optional().describe('Include the icons of the enum and its members'),
        };

        server.registerTool(
            'list_rooms',
            { description: 'List all rooms (enum.rooms.*) with their members and metadata', inputSchema: enumInput },
            async ({ language, withIcons }) => {
                try {
                    return ok({ ok: true, data: { rooms: await this.readEnums('rooms', language, withIcons) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'list_functions',
            { description: 'List all functions (enum.functions.*) with their members and metadata', inputSchema: enumInput },
            async ({ language, withIcons }) => {
                try {
                    return ok({ ok: true, data: { functions: await this.readEnums('functions', language, withIcons) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'get_object',
            {
                description: 'Read a single ioBroker object by its ID',
                inputSchema: { id: z.string().describe('Object ID, e.g. system.adapter.admin.0 or hm-rpc.0.ABC') },
            },
            async ({ id }) => {
                try {
                    const object = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
                    return ok({ ok: true, data: { object: object ?? null } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'read_file',
            {
                description: 'Read a file from an adapter file storage, e.g. "vis-2.0/main/vis-views.json"',
                inputSchema: {
                    path: z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                    base64: z.boolean().optional().describe('Return binary content base64-encoded'),
                },
            },
            async ({ path, base64 }) => {
                try {
                    return ok({ ok: true, data: await this.readFile(path, base64) });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        // Always-on log writing (does not change states or objects).
        server.registerTool(
            'write_log',
            {
                description: 'Write a message to the ioBroker log',
                inputSchema: {
                    message: z.string(),
                    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
                },
            },
            async ({ message, level }) => {
                try {
                    this.adapter.log[level](message);
                    return ok({ ok: true, data: { message, level } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        // Object/file changes are gated behind the "allowObjectChange" option (off by default).
        if (this.config.allowObjectChange) {
            server.registerTool(
                'set_object',
                {
                    description:
                        'Create or update an ioBroker object. An existing object is updated by merging the ' +
                        'provided common/native; a missing one is created from the provided object.',
                    inputSchema: {
                        id: z.string().describe('Object ID'),
                        obj: z
                            .record(z.string(), z.any())
                            .describe('Partial object, e.g. { "type": "state", "common": {...}, "native": {...} }'),
                    },
                },
                async ({ id, obj }) => {
                    try {
                        const result = await this.setObject(id, obj as Partial<ioBroker.Object>);
                        return ok({ ok: true, data: result });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'write_file',
                {
                    description: 'Write a file to an adapter file storage, e.g. "vis-2.0/main/vis-views.json"',
                    inputSchema: {
                        path: z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                        content: z.string().describe('File content (UTF-8, or base64 when base64=true)'),
                        base64: z.boolean().optional().describe('Treat content as base64-encoded binary'),
                    },
                },
                async ({ path, content, base64 }) => {
                    try {
                        await this.writeFile(path, content, base64);
                        return ok({ ok: true, data: { path } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        // --- Resources: expose states and objects via the canonical ioBroker URI scheme ---
        // States as `iobstate://<id>`, objects as `iobobject://<id>`. On change the server pushes a
        // `notifications/resources/updated` over the session's SSE stream and the client re-reads.
        server.registerResource(
            'state',
            new ResourceTemplate('iobstate://{id}', { list: undefined }),
            {
                title: 'ioBroker state',
                description: 'A single ioBroker state value, addressed as iobstate://<id>',
                mimeType: 'application/json',
            },
            async (uri, variables) => {
                const id = decodeURIComponent(String(variables.id));
                const state = await this.adapter.getForeignStateAsync(id, { user: this.defaultUser });
                const body = state
                    ? { id, val: state.val, ack: state.ack, ts: state.ts, lc: state.lc, q: state.q }
                    : { id, val: null };
                return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
            },
        );

        server.registerResource(
            'object',
            new ResourceTemplate('iobobject://{id}', { list: undefined }),
            {
                title: 'ioBroker object',
                description: 'A single ioBroker object, addressed as iobobject://<id>',
                mimeType: 'application/json',
            },
            async (uri, variables) => {
                const id = decodeURIComponent(String(variables.id));
                const obj = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
                return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(obj ?? null) }] };
            },
        );

        // Log stream: `ioblog://all` for every source, or `ioblog://<source>` (e.g. ioblog://admin.0).
        // Subscribe to receive `resources/updated` on each new log line, then re-read for recent lines.
        server.registerResource(
            'log',
            new ResourceTemplate(`${LOG_URI_PREFIX}{source}`, { list: undefined }),
            {
                title: 'ioBroker log stream',
                description: 'Recent log lines, addressed as ioblog://all or ioblog://<source>',
                mimeType: 'application/json',
            },
            async (uri, variables) => {
                const source = decodeURIComponent(String(variables.source)) || 'all';
                const logs = this.logBuffer
                    .filter(m => source === 'all' || m.from === source)
                    .map(m => ({ ts: m.ts, level: m.severity, source: m.from, message: m.message }));
                return {
                    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ source, logs }) }],
                };
            },
        );

        // Manual subscribe/unsubscribe handlers (the high-level McpServer does not provide them).
        // Subscriptions are stored as the full canonical URI; supported for states and objects.
        server.server.setRequestHandler(SubscribeRequestSchema, async request => {
            const uri = request.params.uri;
            if (this.uriKind(uri).kind !== 'other' && !subscriptions.has(uri)) {
                subscriptions.add(uri);
                await this.refSubscribe(uri);
            }
            return {};
        });
        server.server.setRequestHandler(UnsubscribeRequestSchema, async request => {
            const uri = request.params.uri;
            if (subscriptions.has(uri)) {
                subscriptions.delete(uri);
                await this.refUnsubscribe(uri);
            }
            return {};
        });

        return server;
    }

    // ---------------------------------------------------------------------
    // Tool implementations (return plain data; the wrappers serialize them)
    // ---------------------------------------------------------------------

    private async getStates(ids: string[]): Promise<Record<string, unknown>[]> {
        const states: Record<string, unknown>[] = [];
        for (const id of ids) {
            try {
                const state = await this.adapter.getForeignStateAsync(id, { user: this.defaultUser });
                if (state) {
                    const entry: Record<string, unknown> = { id, value: state.val, ack: state.ack, ts: state.ts };
                    if (state.lc !== state.ts) {
                        entry.lc = state.lc;
                    }
                    states.push(entry);
                } else {
                    states.push({ id, value: null, ack: false, ts: Date.now() });
                }
            } catch (e) {
                states.push({
                    id,
                    value: null,
                    ack: false,
                    ts: Date.now(),
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return states;
    }

    private getLogs(params: {
        level?: string[];
        from_ts?: number;
        limit?: number;
        adapter?: string;
    }): Promise<Record<string, unknown>[]> {
        return new Promise((resolve, reject) => {
            const message: ioBroker.MessagePayload = { data: { size: params.limit || 200 } };
            if (params.from_ts !== undefined) {
                (message.data as Record<string, unknown>).from_ts = params.from_ts;
            }
            if (params.adapter !== undefined) {
                (message.data as Record<string, unknown>).source = params.adapter;
            }

            this.adapter.sendToHost(this.adapter.host || null, 'getLogs', message, (result: any) => {
                if (!result || result.error) {
                    reject(new Error(result?.error || 'Failed to retrieve logs'));
                    return;
                }
                let logs: any[] = result.list || [];
                if (params.level && params.level.length > 0) {
                    logs = logs.filter(log => params.level!.includes(log.severity));
                }
                resolve(
                    logs.map(log => ({
                        ts: log.ts,
                        level: log.severity,
                        source: log.from,
                        message: log.message,
                        host: this.adapter.host,
                    })),
                );
            });
        });
    }

    private async getSystemInfo(): Promise<Record<string, unknown>> {
        const hostObj = await this.adapter.getForeignObjectAsync(`system.host.${this.adapter.host}`, {
            user: this.defaultUser,
        });
        const jsControllerVersion = hostObj?.common?.installedVersion || 'unknown';
        const totalMem = Math.round(os.totalmem() / (1024 * 1024));
        const freeMem = Math.round(os.freemem() / (1024 * 1024));
        const instanceObjs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.defaultUser,
        });

        return {
            js_controller: jsControllerVersion,
            hostname: os.hostname(),
            platform: os.platform(),
            node: process.version.substring(1),
            cpu_load: parseFloat((os.loadavg()[0] || 0).toFixed(2)),
            mem: { total_mb: totalMem, used_mb: totalMem - freeMem },
            uptime_sec: Math.round(os.uptime()),
            instances: Object.keys(instanceObjs || {}).length,
        };
    }

    private async searchObjects(params: {
        query?: string;
        role?: string;
        room?: string;
        limit?: number;
    }): Promise<Record<string, unknown>[]> {
        const { query = '', role, room, limit = 100 } = params;
        const result = await this.adapter.getObjectListAsync(
            {
                startkey: '',
                endkey: '\u9999',
            },
            { sorted: true, user: this.defaultUser },
        );
        const allObjects = result.rows;
        const roomMembers = room ? await this.getEnumMembers('enum.rooms.', room) : null;

        const results: Record<string, unknown>[] = [];
        for (const obj of allObjects) {
            const o = obj.value;
            if (query && !obj.value._id.toLowerCase().includes(query.toLowerCase())) {
                continue;
            }
            if (role && o?.common?.role !== role) {
                continue;
            }
            if (roomMembers && !roomMembers.includes(obj.value._id)) {
                continue;
            }
            results.push({
                id: obj.value._id,
                type: o?.type || 'state',
                role: o?.common?.role || '',
                name: this.getName(o?.common?.name),
                adapter: obj.value._id.match(/^([^.]+\.\d+)/)?.[1] || '',
            });
            if (results.length >= limit) {
                break;
            }
        }
        return results;
    }

    private async listDevices(params: { language?: ioBroker.Languages; room?: string }): Promise<Room[]> {
        const lang = params.language || this.language;
        const rooms = await getAiFriendlyStructure(this.adapter, lang, { user: this.defaultUser });
        if (params.room) {
            const needle = params.room.toLowerCase();
            return rooms.filter(r => r.roomName.toLowerCase() === needle);
        }
        return rooms;
    }

    private async historyQuery(params: {
        id: string;
        from?: string;
        to?: string;
        agg?: string;
        interval?: string;
        limit?: number;
    }): Promise<Record<string, unknown>> {
        const options: ioBroker.GetHistoryOptions = {
            aggregate: AGG_MAP[params.agg || 'raw'] || 'none',
            count: params.limit ?? 1000,
            limit: params.limit ?? 1000,
        };
        if (params.from) {
            options.start = new Date(params.from).getTime();
        }
        if (params.to) {
            options.end = new Date(params.to).getTime();
        }
        const step = params.interval ? this.parseInterval(params.interval) : undefined;
        if (step) {
            options.step = step;
        }
        // GetHistoryOptions has no typed `user` field, but the controller honors it for ACL checks.
        (options as Record<string, unknown>).user = this.defaultUser;

        const res = await this.adapter.getHistoryAsync(params.id, options);
        return { id: params.id, values: res?.result || [] };
    }

    private async listInstances(): Promise<Record<string, unknown>[]> {
        const objs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.defaultUser,
        });
        const result: Record<string, unknown>[] = [];
        for (const [fullId, obj] of Object.entries(objs || {})) {
            const id = fullId.replace('system.adapter.', '');
            const aliveState = await this.adapter.getForeignStateAsync(`${fullId}.alive`, { user: this.defaultUser });
            const connState = await this.adapter.getForeignStateAsync(`${fullId}.connected`, {
                user: this.defaultUser,
            });
            result.push({
                id,
                enabled: !!obj?.common?.enabled,
                alive: !!aliveState?.val,
                connected: connState ? !!connState.val : null,
                version: obj?.common?.version || '',
                title: this.getName(obj?.common?.titleLang || obj?.common?.title),
            });
        }
        return result;
    }

    private async listHosts(): Promise<Record<string, unknown>[]> {
        const objs = await this.adapter.getForeignObjectsAsync('system.host.*', 'host', { user: this.defaultUser });
        const result: Record<string, unknown>[] = [];
        for (const [fullId, obj] of Object.entries(objs || {})) {
            const aliveState = await this.adapter.getForeignStateAsync(`${fullId}.alive`, { user: this.defaultUser });
            result.push({
                id: fullId.replace('system.host.', ''),
                alive: !!aliveState?.val,
                js_controller: obj?.common?.installedVersion || '',
                platform: obj?.native?.os?.platform || '',
            });
        }
        return result;
    }

    /**
     * Read the rooms/functions enums with localized names and details about each member object
     * (ported from the ioBroker n8n node's `readIobEnums`).
     */
    private async readEnums(
        type: 'rooms' | 'functions',
        language?: ioBroker.Languages,
        withIcons?: boolean,
    ): Promise<EnumResponse[]> {
        const enums = await this.adapter.getObjectViewAsync(
            'system',
            'enum',
            { startkey: `enum.${type}.`, endkey: `enum.${type}.香` },
            { user: this.defaultUser },
        );

        const result: EnumResponse[] = [];
        // Cache member objects so a member shared by several enums is read only once.
        const cache: Record<string, ioBroker.Object | null | false> = {};

        for (const row of enums.rows) {
            const enumObj = row.value as ioBroker.EnumObject;
            const common = (enumObj.common || {}) as AnyCommon;
            const oneEnum: EnumResponse = {
                id: enumObj._id,
                name: (language ? getText(common.name, language) : common.name) || enumObj._id.split('.').pop() || '',
                color: common.color,
                icon: withIcons ? common.icon : undefined,
                items: [],
            };
            result.push(oneEnum);

            for (const member of common.members || []) {
                let obj = cache[member];
                if (obj === undefined) {
                    try {
                        cache[member] =
                            (await this.adapter.getForeignObjectAsync(member, { user: this.defaultUser })) || false;
                    } catch {
                        cache[member] = false;
                    }
                    obj = cache[member];
                }
                if (obj) {
                    const c = (obj.common || {}) as AnyCommon;
                    oneEnum.items.push({
                        id: member,
                        type: obj.type,
                        name: (language ? getText(c.name, language) : c.name) || member.split('.').pop() || '',
                        color: c.color,
                        icon: withIcons ? c.icon : undefined,
                        stateType: c.type,
                        min: c.min,
                        max: c.max,
                        unit: c.unit,
                        role: c.role,
                        step: c.step,
                    });
                }
            }
        }
        return result;
    }

    /** Write a state, coercing the value to the state's declared type (boolean/number/string). */
    private async setState(id: string, value: unknown, ack: boolean): Promise<ioBroker.StateValue> {
        const obj = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
        const stateType = (obj?.common as AnyCommon | undefined)?.type;
        const coerced = McpServer.coerceValue(value, stateType);
        await this.adapter.setForeignStateAsync(id, coerced, ack, { user: this.defaultUser });
        return coerced;
    }

    /** Coerce an arbitrary value to the given ioBroker state type. */
    private static coerceValue(value: unknown, type: ioBroker.CommonType | undefined): ioBroker.StateValue {
        if (value === null || value === undefined) {
            return value as ioBroker.StateValue;
        }
        if (type === 'number') {
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'boolean') {
                return value ? 1 : 0;
            }
            if (typeof value === 'string') {
                const n = parseFloat(value);
                return isNaN(n) ? (value as ioBroker.StateValue) : n;
            }
            return value as ioBroker.StateValue;
        }
        if (type === 'boolean') {
            if (typeof value === 'boolean') {
                return value;
            }
            if (typeof value === 'number') {
                return !!value;
            }
            if (typeof value === 'string') {
                return value.toLowerCase() === 'true' || value === '1';
            }
            return value as ioBroker.StateValue;
        }
        if (type === 'string') {
            if (typeof value === 'string') {
                return value;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return value.toString();
            }
            return JSON.stringify(value);
        }
        return value as ioBroker.StateValue;
    }

    /** Read a file from an adapter file storage. */
    private async readFile(
        path: string,
        base64?: boolean,
    ): Promise<{ path: string; mimeType?: string; encoding: 'utf8' | 'base64'; content: string }> {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data = await this.adapter.readFileAsync(adapterName, fileName, { user: this.defaultUser });
        const file = (data as { file: string | Buffer })?.file;
        const mimeType = (data as { mimeType?: string })?.mimeType;
        if (base64 || typeof file !== 'string') {
            return { path, mimeType, encoding: 'base64', content: Buffer.from(file as Buffer | string).toString('base64') };
        }
        return { path, mimeType, encoding: 'utf8', content: file };
    }

    /** Write a file to an adapter file storage. */
    private async writeFile(path: string, content: string, base64?: boolean): Promise<void> {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data: string | Buffer = base64 ? Buffer.from(content, 'base64') : content;
        await this.adapter.writeFileAsync(adapterName, fileName, data, { user: this.defaultUser });
    }

    /** Create or update an object, merging common/native into an existing object (n8n `setIobObject`). */
    private async setObject(id: string, obj: Partial<ioBroker.Object>): Promise<{ id: string }> {
        let existing = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
        if (existing) {
            if (obj.common) {
                existing.common = { ...existing.common, ...obj.common } as ioBroker.ObjectCommon;
            }
            if (obj.native) {
                existing.native = { ...existing.native, ...obj.native };
            }
        } else {
            existing = obj as ioBroker.Object;
        }
        return this.adapter.setForeignObjectAsync(id, existing, { user: this.defaultUser });
    }

    /** Split a file path "<adapter>/<dir>/<file>" into adapter name and file name. */
    private static parseFilePath(path: string): { adapterName: string; fileName: string } {
        const [adapterName, ...rest] = path.replace(/^\//, '').split('/');
        if (!adapterName) {
            throw new Error('Path must start with an adapter name, e.g. "vis-2.0/main/vis-views.json"');
        }
        const fileName = rest.join('/');
        if (!fileName) {
            throw new Error('Path must contain a file name after the adapter, e.g. "vis-2.0/main/vis-views.json"');
        }
        return { adapterName, fileName };
    }

    // --- helpers ---

    /** Resolve the member ids of a room/function enum matched by id or (localized) name. */
    private async getEnumMembers(prefix: string, nameOrId: string): Promise<string[]> {
        const enums = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'enum', { user: this.defaultUser });
        const needle = nameOrId.toLowerCase();
        for (const [id, obj] of Object.entries(enums || {})) {
            if (id.toLowerCase() === needle || this.getName(obj?.common?.name).toLowerCase() === needle) {
                return (obj?.common?.members as string[]) || [];
            }
        }
        return [];
    }

    /** Normalize an ioBroker name (string or {en, de, ...}) to a plain string. */
    private getName(name: ioBroker.StringOrTranslated | undefined): string {
        if (!name) {
            return '';
        }
        if (typeof name === 'string') {
            return name;
        }
        return name.en || Object.values(name)[0] || '';
    }

    /** Parse an interval like "15m", "1h", "30s" into milliseconds. */
    private parseInterval(interval: string): number | undefined {
        const m = interval.match(/^(\d+)\s*(s|m|h|d)$/i);
        if (!m) {
            return undefined;
        }
        const value = parseInt(m[1], 10);
        const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()]!;
        return value * unit;
    }

    unload(): void {
        try {
            this.adapter.removeListener('log', this.onLog);
        } catch {
            // ignore
        }
        for (const session of Object.values(this.sessions)) {
            try {
                void session.transport.close();
            } catch {
                // ignore
            }
        }
        this.adapter.log.info('MCP server unloading');
    }
}
