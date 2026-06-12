import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { McpServer as McpSdkServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    isInitializeRequest,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAiFriendlyStructure, type Room } from './devices';
import { iobUriParse } from './iob-uri';
import type { McpAdapterConfig } from './types';
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
    count: 'count',
    minmax: 'minmax',
    percentile: 'percentile',
    quantile: 'quantile',
    integral: 'integral',
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
    private readonly adapter: ioBroker.Adapter;
    /** The Express app we attach routes to. Undefined in embedded in-process mode (no HTTP). */
    private readonly app?: Express;
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
        server: HttpServer | HttpsServer | null,
        webSettings: {
            // `secure`/`port`/`auth` are accepted for backwards compatibility but not read here;
            // the HTTP specifics come from the adapter config. `defaultUser` accepts a plain user
            // name or a fully qualified `system.user.*` id — it is normalized below either way.
            secure?: boolean;
            port?: number | string;
            defaultUser?: string;
            auth?: boolean;
            language?: ioBroker.Languages;
            /** Explicit override for the `set_state`/`set_states` permission (embedded mode). */
            allowSetState?: boolean;
            /** Explicit override for the object/file-changing tool permission (embedded mode). */
            allowObjectChange?: boolean;
        },
        adapter: ioBroker.Adapter,
        instanceSettings: ioBroker.InstanceObject | null,
        app?: Express,
    ) {
        this.app = app;
        this.adapter = adapter;
        // Clone the source config so we never mutate the host adapter's config object — important in
        // embedded in-process mode, where `adapter` is a foreign adapter (e.g. admin), not mcp itself.
        this.config = {
            ...((instanceSettings ? instanceSettings.native : adapter.config) as McpAdapterConfig),
        };
        this.namespace = instanceSettings
            ? instanceSettings._id.substring('system.adapter.'.length)
            : this.adapter.namespace;
        this.extension = !!instanceSettings;
        this.routerPrefix = this.extension ? `/${WEB_EXTENSION_PREFIX}` : '/';

        // Determine the ioBroker user whose permissions all MCP requests run with.
        // Prefer this adapter's own setting; when embedded, fall back to the host web server's
        // default user; finally to "admin". Always normalize to the "system.user." prefix.
        const rawUser = this.config.defaultUser || webSettings.defaultUser || 'admin';
        this.defaultUser = (
            rawUser.startsWith('system.user.') ? rawUser : `system.user.${rawUser}`
        ) as `system.user.${string}`;
        this.config.defaultUser = this.defaultUser;
        this.language = webSettings.language || 'en';

        // Embedded callers may set the permission toggles explicitly (they don't read the mcp config).
        if (webSettings.allowSetState !== undefined) {
            this.config.allowSetState = webSettings.allowSetState;
        }
        if (webSettings.allowObjectChange !== undefined) {
            this.config.allowObjectChange = webSettings.allowObjectChange;
        }
        // Permission toggles: state writes are allowed by default, object/file changes are not.
        this.config.allowSetState = this.config.allowSetState !== false;
        this.config.allowObjectChange = this.config.allowObjectChange === true;

        // Receive ioBroker log messages (only forwarded once a session subscribes via requireLog).
        this.adapter.on('log', this.onLog);

        // Wire HTTP routes only when we own/share an Express app. In embedded in-process mode (no app)
        // the server is reached over an in-memory transport instead, see createInProcessServer().
        this.initRoutes();
    }

    /**
     * Build a fresh MCP SDK server with all ioBroker tools registered, ready to be connected to an
     * arbitrary transport. Used for in-process embedding (e.g. by ioBroker.admin) over an
     * InMemoryTransport, where there is no HTTP server/session layer. The caller owns the lifecycle
     * of the returned server (connect it to a transport, and `close()` it when done).
     */
    createInProcessServer(): McpSdkServer {
        return this.createServer(new Set<string>());
    }

    /**
     * Convenience factory for embedding the MCP server inside another adapter's process (no HTTP).
     * The returned instance is not wired to any Express app; obtain a tool server via
     * {@link createInProcessServer} and connect it to an in-memory transport.
     *
     * @param options embedding options (host adapter, default user, language, permission toggles)
     * @param options.adapter The host adapter into which the MCP server is embedded. Used for receiving state/object changes and logs, and for performing actions with the host adapter's permissions.
     * @param options.defaultUser Default user
     * @param options.language Language
     * @param options.allowSetState Is the state creation available
     * @param options.allowObjectChange If the object change available
     */
    static createEmbedded(options: {
        adapter: ioBroker.Adapter;
        defaultUser?: `system.user.${string}`;
        language?: ioBroker.Languages;
        allowSetState?: boolean;
        allowObjectChange?: boolean;
    }): McpServer {
        return new McpServer(
            null,
            {
                secure: false,
                port: 0,
                defaultUser: options.defaultUser,
                language: options.language,
                allowSetState: options.allowSetState,
                allowObjectChange: options.allowObjectChange,
            },
            options.adapter,
            null,
        );
    }

    private initRoutes(): void {
        const app = this.app;
        if (!app) {
            // Embedded in-process mode: no HTTP transport, so there is nothing to route.
            return;
        }
        // The MCP endpoint. In standalone mode this is `/mcp`; as a web extension we own the
        // `/<adapter>/` namespace (e.g. `/mcp/`) within the shared web server. `.replace` strips
        // the trailing slash so the route matches both `/mcp` and `/mcp/` (Express, non-strict).
        const mcpPath = this.extension ? this.routerPrefix.replace(/\/$/, '') : '/mcp';
        // The MCP transport needs a parsed JSON body; apply the parser per-route so we never
        // touch the body handling of the web adapter or other extensions when running embedded.
        const jsonParser = express.json({ limit: '4mb' });

        // Health endpoint inside our own namespace (`/status` standalone, `/mcp/status` embedded).
        app.get(`${this.routerPrefix}status`, (_req: Request, res: Response) => {
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
            app.use((req: Request, _res: Response, next: NextFunction) => {
                this.adapter.log.debug(`${req.method} ${req.url} from ${req.ip}`);
                next();
            });

            app.get('/', (_req: Request, res: Response) => {
                res.json({
                    name: 'ioBroker MCP Server',
                    version: SERVER_VERSION,
                    status: 'running',
                    mcpEndpoint: '/mcp',
                });
            });

            app.get('/api/info', (_req: Request, res: Response) => {
                res.json({
                    adapter: 'mcp',
                    version: SERVER_VERSION,
                    secure: this.config.secure,
                    auth: this.config.auth,
                });
            });
        }

        // --- MCP Streamable HTTP transport ---
        app.post(mcpPath, jsonParser, (req: Request, res: Response) => {
            void this.handleMcpPost(req, res);
        });
        app.get(mcpPath, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });
        app.delete(mcpPath, (req: Request, res: Response) => {
            void this.handleMcpSessionRequest(req, res);
        });

        // Catch-all 404 + error handlers only in standalone mode; the web adapter provides its own.
        if (!this.extension) {
            app.use((req: Request, res: Response) => {
                res.status(404).json({ error: 'Not Found', path: req.url });
            });

            app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
                description:
                    'Retrieve the current value of one or multiple states. IDs may contain wildcards, ' +
                    'e.g. "hue.0.*.brightness" expands to all matching states.',
                inputSchema: { ids: z.array(z.string()).describe('Array of state IDs (wildcards "*" allowed)') },
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
                    description:
                        'Set the value of a state. The value is coerced to the state type (boolean/number/string).',
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

            server.registerTool(
                'set_states',
                {
                    description:
                        'Set multiple states in one call (e.g. for scenes or group actions like "all lights off"). ' +
                        'Each value is coerced to its state type. Failures of single states do not abort the rest.',
                    inputSchema: {
                        states: z
                            .array(
                                z.object({
                                    id: z.string().describe('State ID'),
                                    value: z.any().describe('New value (type depends on the state)'),
                                    ack: z.boolean().optional().describe('Acknowledge flag (default false)'),
                                }),
                            )
                            .describe('Array of state/value pairs to write'),
                    },
                },
                async ({ states }) => {
                    try {
                        return ok({ ok: true, data: { results: await this.setStates(states) } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );
        }

        server.registerTool(
            'get_logs',
            {
                description:
                    'Retrieve recent ioBroker log lines from the host log file. Each entry has {ts, level, ' +
                    'source, message}. Optionally filter by `level` (error/warn/info/debug), by `adapter` ' +
                    '(source, e.g. "hm-rpc.0" or "hm-rpc"), or from `from_ts` (ms). When a level filter is set, ' +
                    'a larger window of the log is scanned so errors/warnings are not hidden behind debug spam.',
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

        server.registerTool(
            'ping_host',
            {
                description:
                    'Check whether a network device is reachable — useful to diagnose adapter connection ' +
                    'errors (e.g. a "connect ETIMEDOUT 192.168.10.5:2001"). Runs an ICMP ping to `host` and, ' +
                    'if `port` is given, also a TCP connect to that port (which tests the actual service, not ' +
                    'just the host). `host` may be an IP or hostname. Returns ICMP reachability/latency and, ' +
                    'when requested, whether the TCP port is open.',
                inputSchema: {
                    host: z.string(),
                    port: z.number().int().min(1).max(65535).optional(),
                    count: z.number().int().min(1).max(10).default(2),
                    timeout: z.number().int().min(100).max(20000).default(2000),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: await this.pingHost(args) });
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
                description:
                    'Search objects and states by keyword (matched against ID and name) with optional ' +
                    'filters for object type, role, room and source adapter instance',
                inputSchema: {
                    query: z.string().describe('Keyword to search for in object IDs and names'),
                    type: z
                        .string()
                        .optional()
                        .describe('Filter by object type, e.g. state, channel, device, enum, script, instance'),
                    role: z.string().optional(),
                    room: z.string().optional(),
                    adapter: z.string().optional().describe('Filter by source adapter instance, e.g. "hue.0"'),
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
                    agg: z
                        .enum([
                            'raw',
                            'min',
                            'max',
                            'avg',
                            'sum',
                            'count',
                            'minmax',
                            'percentile',
                            'quantile',
                            'integral',
                        ])
                        .default('raw'),
                    percentile: z
                        .number()
                        .min(0)
                        .max(100)
                        .optional()
                        .describe('Percentile (0-100), only used with agg=percentile'),
                    quantile: z
                        .number()
                        .min(0)
                        .max(1)
                        .optional()
                        .describe('Quantile (0-1), only used with agg=quantile'),
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

        server.registerTool(
            'list_adapters',
            {
                description:
                    'List all installed adapters with metadata (version, title, description, keywords). ' +
                    'Unlike list_instances this lists what is installed, not what is running.',
                inputSchema: {
                    language: z
                        .enum(LANGUAGES)
                        .optional()
                        .describe('Language for title/description (defaults to the adapter language)'),
                },
            },
            async ({ language }) => {
                try {
                    return ok({ ok: true, data: { adapters: await this.listAdapters(language) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'search_adapter_repository',
            {
                description:
                    'Search the ioBroker adapter REPOSITORY (all installable adapters, not just the ' +
                    'installed ones) by keyword, matched against the adapter name, title, description and ' +
                    'keywords. Use this to recommend which adapter to install for a device or service. ' +
                    'Reads the already-downloaded repository object (fast, no network).',
                inputSchema: {
                    query: z.string().describe('Keyword to search for, e.g. "philips hue", "zigbee", "mqtt"'),
                    type: z
                        .string()
                        .optional()
                        .describe('Filter by adapter category/type, e.g. "lighting", "climate-control", "hardware"'),
                    onlyNotInstalled: z
                        .boolean()
                        .optional()
                        .describe('If true, return only adapters that are not installed yet'),
                    language: z.enum(LANGUAGES).optional().describe('Language for title/description'),
                    limit: z.number().int().default(20),
                },
            },
            async args => {
                try {
                    return ok({ ok: true, data: { adapters: await this.searchAdapterRepository(args) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

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
            {
                description: 'List all functions (enum.functions.*) with their members and metadata',
                inputSchema: enumInput,
            },
            async ({ language, withIcons }) => {
                try {
                    return ok({
                        ok: true,
                        data: { functions: await this.readEnums('functions', language, withIcons) },
                    });
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

        server.registerTool(
            'list_files',
            {
                description: 'List a directory in an adapter file storage, e.g. "vis-2.0/main" or "0_userdata.0"',
                inputSchema: { path: z.string().describe('Path as "<adapter>[/<dir>]"') },
            },
            async ({ path }) => {
                try {
                    return ok({ ok: true, data: { path, files: await this.listFiles(path) } });
                } catch (e) {
                    return fail(e);
                }
            },
        );

        server.registerTool(
            'file_exists',
            {
                description: 'Check whether a file exists in an adapter file storage',
                inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>/<file>"') },
            },
            async ({ path }) => {
                try {
                    const { adapterName, fileName } = McpServer.parseFilePath(path);
                    const exists = await this.adapter.fileExistsAsync(adapterName, fileName, {
                        user: this.defaultUser,
                    });
                    return ok({ ok: true, data: { path, exists: !!exists } });
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
            ({ message, level }): Promise<ToolResult> => {
                try {
                    this.adapter.log[level](message);
                    return Promise.resolve(ok({ ok: true, data: { message, level } }));
                } catch (e) {
                    return Promise.resolve(fail(e));
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
                'delete_object',
                {
                    description:
                        'Delete an ioBroker object (and optionally all its children). ' +
                        'Be careful: deleting objects that were not created by the user can break adapters.',
                    inputSchema: {
                        id: z.string().describe('Object ID'),
                        recursive: z.boolean().optional().describe('Also delete all child objects'),
                    },
                },
                async ({ id, recursive }) => {
                    try {
                        await this.deleteObject(id, recursive);
                        return ok({ ok: true, data: { id, deleted: true } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'create_state',
                {
                    description:
                        'Create a new state object (e.g. under "0_userdata.0."). Fails if the object already ' +
                        'exists - use set_object to modify existing objects.',
                    inputSchema: {
                        id: z.string().describe('Full state ID, e.g. "0_userdata.0.myState"'),
                        name: z.string().optional().describe('Display name (defaults to the last ID segment)'),
                        type: z
                            .enum(['boolean', 'number', 'string', 'array', 'object', 'mixed'])
                            .default('mixed')
                            .describe('Value type of the state'),
                        role: z.string().default('state').describe('Role, e.g. switch.light, value.temperature'),
                        read: z.boolean().default(true),
                        write: z.boolean().default(true),
                        unit: z.string().optional(),
                        min: z.number().optional(),
                        max: z.number().optional(),
                        step: z.number().optional(),
                        def: z.any().optional().describe('Initial value (written with ack=true)'),
                        desc: z.string().optional().describe('Description'),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.createState(args) });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'create_scene',
                {
                    description:
                        'Create or update a scene for the ioBroker "scenes" adapter: a named collection of ' +
                        'state/value pairs applied together (e.g. "movie night" dims lights and closes blinds). ' +
                        'Activate the scene by setting its state to true. Requires an installed scene instance.',
                    inputSchema: {
                        name: z.string().describe('Scene name, becomes part of the ID (e.g. "movie_night")'),
                        members: z
                            .array(
                                z.object({
                                    id: z.string().describe('State ID to set'),
                                    value: z.any().describe('Value applied when the scene is activated'),
                                }),
                            )
                            .describe('State/value pairs that define the scene'),
                        instance: z.string().optional().describe('Scene adapter instance (default "scene.0")'),
                        description: z.string().optional(),
                    },
                },
                async args => {
                    try {
                        return ok({ ok: true, data: await this.createScene(args) });
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

            server.registerTool(
                'delete_file',
                {
                    description: 'Delete a file from an adapter file storage',
                    inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>/<file>"') },
                },
                async ({ path }) => {
                    try {
                        const { adapterName, fileName } = McpServer.parseFilePath(path);
                        await this.adapter.delFileAsync(adapterName, fileName, { user: this.defaultUser });
                        return ok({ ok: true, data: { path, deleted: true } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'rename_file',
                {
                    description:
                        'Rename or move a file/directory within the same adapter file storage, ' +
                        'e.g. "vis-2.0/main/a.json" -> "vis-2.0/backup/a.json"',
                    inputSchema: {
                        path: z.string().describe('Current path as "<adapter>/<dir>/<file>"'),
                        new_path: z.string().describe('New path as "<adapter>/<dir>/<file>" (same adapter)'),
                    },
                },
                async ({ path, new_path }) => {
                    try {
                        await this.renameFile(path, new_path);
                        return ok({ ok: true, data: { path: new_path } });
                    } catch (e) {
                        return fail(e);
                    }
                },
            );

            server.registerTool(
                'mkdir',
                {
                    description: 'Create a directory in an adapter file storage, e.g. "0_userdata.0/my-folder"',
                    inputSchema: { path: z.string().describe('Path as "<adapter>/<dir>"') },
                },
                async ({ path }) => {
                    try {
                        const { adapterName, dirName } = McpServer.parseDirPath(path);
                        if (!dirName) {
                            throw new Error(
                                'Path must contain a directory after the adapter, e.g. "0_userdata.0/my-folder"',
                            );
                        }
                        await this.adapter.mkdirAsync(adapterName, dirName, { user: this.defaultUser });
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
                return {
                    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(obj ?? null) }],
                };
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
            (uri, variables) => {
                const source = decodeURIComponent(String(variables.source)) || 'all';
                const logs = this.logBuffer
                    .filter(m => source === 'all' || m.from === source)
                    .map(m => ({ ts: m.ts, level: m.severity, source: m.from, message: m.message }));
                return Promise.resolve({
                    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ source, logs }) }],
                });
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

    /** Build the result entry for one state. */
    private static stateEntry(id: string, state: ioBroker.State | null | undefined): Record<string, unknown> {
        if (!state) {
            return { id, value: null, ack: false, ts: Date.now() };
        }
        const entry: Record<string, unknown> = { id, value: state.val, ack: state.ack, ts: state.ts };
        if (state.lc !== state.ts) {
            entry.lc = state.lc;
        }
        return entry;
    }

    private async getStates(ids: string[]): Promise<Record<string, unknown>[]> {
        const states: Record<string, unknown>[] = [];
        for (const id of ids) {
            try {
                if (id.includes('*')) {
                    // Wildcard pattern: expand to all matching states.
                    const matches = await this.adapter.getForeignStatesAsync(id, { user: this.defaultUser });
                    for (const matchId of Object.keys(matches || {})) {
                        states.push(McpServer.stateEntry(matchId, matches[matchId]));
                    }
                } else {
                    const state = await this.adapter.getForeignStateAsync(id, { user: this.defaultUser });
                    states.push(McpServer.stateEntry(id, state));
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

    /** Write multiple states; failures of single states are reported per item and do not abort the rest. */
    private async setStates(
        items: { id: string; value: unknown; ack?: boolean }[],
    ): Promise<Record<string, unknown>[]> {
        const results: Record<string, unknown>[] = [];
        for (const item of items) {
            try {
                const written = await this.setState(item.id, item.value, item.ack ?? false);
                results.push({ id: item.id, value: written });
            } catch (e) {
                results.push({ id: item.id, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return results;
    }

    /**
     * Parse the raw log-file lines returned by the host `getLogs` into structured entries.
     *
     * The host replies with an array of raw strings (the file size is appended as the last, numeric
     * element). Lines carry ANSI color codes and look like
     * `2026-06-12 11:46:39.802  - error: hm-rpc.0 (1234) Init not possible…`. This mirrors the admin
     * `LogsWorker` parsing: strip the color codes, then split timestamp / level / rest, and treat lines
     * without a leading timestamp as continuations (e.g. stack traces) of the previous entry.
     */
    private parseLogLines(rawLines: unknown[]): { ts: number; level: string; source: string; message: string }[] {
        const entries: { ts: number; level: string; source: string; message: string }[] = [];
        for (const raw of rawLines) {
            if (typeof raw !== 'string') {
                continue;
            }
            // Also strip the trailing CR: the host splits the CRLF log file on \n only, leaving a \r
            // that would otherwise break the `$` anchor of the line regex below.
            const clean = raw.replace(/\x1b\[\d+m/g, '').replace(/\r$/, ''); // eslint-disable-line no-control-regex
            const match = clean.match(
                /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+-\s+(silly|debug|info|warn|error):\s*(.*)$/,
            );
            if (match) {
                const rest = match[3];
                const fromMatch = rest.match(/^(host\.[^\s]+|[-\w]+\.\d+)/);
                entries.push({
                    ts: new Date(match[1].replace(' ', 'T')).getTime(),
                    level: match[2],
                    source: fromMatch ? fromMatch[1] : '',
                    message: rest,
                });
            } else if (entries.length && clean.trim() && !/^\d+$/.test(clean.trim())) {
                // Continuation line (e.g. a stack trace). The trailing file-size element is a bare number,
                // which the `\d+` guard skips.
                entries[entries.length - 1].message += `\n${clean}`;
            }
        }
        return entries;
    }

    private getLogs(params: {
        level?: string[];
        from_ts?: number;
        limit?: number;
        adapter?: string;
    }): Promise<Record<string, unknown>[]> {
        const limit = Math.max(1, params.limit || 200);
        const filtering = !!((params.level && params.level.length) || params.adapter || params.from_ts !== undefined);
        // The host `getLogs` returns the tail of the log file (≈150 bytes per requested line). When a
        // filter is active, scan a much larger window so error/warn lines are not pushed out by a flood
        // of debug lines from a chatty adapter.
        const fetchLines = filtering ? Math.min(Math.max(limit * 10, 3000), 20000) : limit;

        return new Promise((resolve, reject) => {
            // The controller expects the line count as the plain message (a number) and replies with an
            // ARRAY of raw string lines — NOT an object with a `list` property.
            this.adapter.sendToHost(this.adapter.host || null, 'getLogs', fetchLines, (result: any) => {
                const rawList: unknown = Array.isArray(result) ? result : result?.list;
                if (!Array.isArray(rawList)) {
                    if (result && result.error) {
                        reject(new Error(result.error));
                    } else {
                        resolve([]);
                    }
                    return;
                }
                let logs = this.parseLogLines(rawList);
                if (params.level && params.level.length) {
                    logs = logs.filter(log => params.level!.includes(log.level));
                }
                if (params.from_ts !== undefined) {
                    logs = logs.filter(log => log.ts >= params.from_ts!);
                }
                if (params.adapter) {
                    const adapter = params.adapter;
                    logs = logs.filter(log => log.source === adapter || log.source.startsWith(`${adapter}.`));
                }
                // Return the most recent `limit` matching lines.
                if (logs.length > limit) {
                    logs = logs.slice(logs.length - limit);
                }
                resolve(
                    logs.map(log => ({
                        ts: log.ts,
                        level: log.level,
                        source: log.source,
                        message: log.message,
                        host: this.adapter.host,
                    })),
                );
            });
        });
    }

    /**
     * Diagnose whether a network device/service is reachable: an ICMP ping to `host` and, if `port`
     * is given, a TCP connect to that port. Used to investigate adapter connection errors.
     */
    private async pingHost(params: {
        host: string;
        port?: number;
        count?: number;
        timeout?: number;
    }): Promise<Record<string, unknown>> {
        const host = (params.host || '').trim();
        // Only allow plausible IP/hostname characters — and never a leading "-" — so the value can't be
        // injected as an option to the `ping` executable.
        if (!host || host.startsWith('-') || !/^[a-zA-Z0-9._:-]+$/.test(host)) {
            throw new Error(`Invalid host: ${params.host}`);
        }
        const count = Math.min(Math.max(params.count || 2, 1), 10);
        const timeout = Math.min(Math.max(params.timeout || 2000, 100), 20000);

        const resolvedIp = await new Promise<string | undefined>(resolve =>
            dns.lookup(host, (err, address) => resolve(err ? undefined : address)),
        );

        const result: Record<string, unknown> = {
            host,
            ...(resolvedIp && resolvedIp !== host ? { resolved_ip: resolvedIp } : {}),
            icmp: await this.icmpPing(host, count, timeout),
        };
        if (params.port !== undefined) {
            result.tcp = await this.tcpProbe(host, params.port, timeout);
        }
        return result;
    }

    /** ICMP ping via the OS `ping` command (no elevated privileges needed). */
    private icmpPing(host: string, count: number, timeout: number): Promise<Record<string, unknown>> {
        const isWin = process.platform === 'win32';
        // Windows: -n count, -w timeout(ms per reply). Unix: -c count, -W timeout(s per reply).
        const args = isWin
            ? ['-n', String(count), '-w', String(timeout), host]
            : ['-c', String(count), '-W', String(Math.max(1, Math.round(timeout / 1000))), host];
        return new Promise(resolve => {
            execFile('ping', args, { timeout: timeout * count + 3000, windowsHide: true }, (_err, stdout, stderr) => {
                const out = `${stdout || ''}${stderr || ''}`;
                // Number of received replies (Windows "Received = N", Unix "N received").
                const received = isWin
                    ? Number(out.match(/Received = (\d+)/)?.[1] ?? out.match(/Empfangen = (\d+)/)?.[1] ?? 0)
                    : Number(out.match(/(\d+) (?:packets )?received/)?.[1] ?? 0);
                // Average round-trip time, if reported.
                const avg = isWin
                    ? (out.match(/Average = (\d+)ms/)?.[1] ?? out.match(/Mittelwert = (\d+)ms/)?.[1])
                    : out.match(/=\s*[\d.]+\/([\d.]+)\//)?.[1];
                resolve({
                    reachable: received > 0,
                    sent: count,
                    received,
                    ...(avg ? { avg_ms: Math.round(parseFloat(avg)) } : {}),
                });
            });
        });
    }

    /** TCP connect probe — tests whether a specific service port accepts connections. */
    private tcpProbe(host: string, port: number, timeout: number): Promise<Record<string, unknown>> {
        return new Promise(resolve => {
            const start = Date.now();
            const socket = new net.Socket();
            let settled = false;
            const done = (open: boolean, error?: string): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                resolve({ port, open, latency_ms: Date.now() - start, ...(error ? { error } : {}) });
            };
            socket.setTimeout(timeout);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false, 'timeout'));
            socket.once('error', (e: Error) => done(false, e.message));
            socket.connect(port, host);
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
        type?: string;
        role?: string;
        room?: string;
        adapter?: string;
        limit?: number;
    }): Promise<Record<string, unknown>[]> {
        const { query = '', type, role, room, adapter, limit = 100 } = params;
        const result = await this.adapter.getObjectListAsync(
            {
                startkey: '',
                endkey: '\u9999',
            },
            { sorted: true, user: this.defaultUser },
        );
        const allObjects = result.rows;
        const roomMembers = room ? await this.getEnumMembers('enum.rooms.', room) : null;
        const needle = query.toLowerCase();

        const results: Record<string, unknown>[] = [];
        for (const obj of allObjects) {
            const o = obj.value;
            const name = this.getName(o?.common?.name);
            if (needle && !obj.value._id.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) {
                continue;
            }
            if (type && o?.type !== type) {
                continue;
            }
            if (role && o?.common?.role !== role) {
                continue;
            }
            if (roomMembers && !roomMembers.includes(obj.value._id)) {
                continue;
            }
            const sourceAdapter = obj.value._id.match(/^([^.]+\.\d+)/)?.[1] || '';
            if (adapter && sourceAdapter !== adapter) {
                continue;
            }
            results.push({
                id: obj.value._id,
                type: o?.type || 'state',
                role: o?.common?.role || '',
                name,
                adapter: sourceAdapter,
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
        percentile?: number;
        quantile?: number;
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
        if (params.percentile !== undefined) {
            (options as Record<string, unknown>).percentile = params.percentile;
        }
        if (params.quantile !== undefined) {
            (options as Record<string, unknown>).quantile = params.quantile;
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

    /** List installed adapters (system.adapter.<name> objects, no instances). */
    private async listAdapters(language?: ioBroker.Languages): Promise<Record<string, unknown>[]> {
        const lang = language || this.language;
        const view = await this.adapter.getObjectViewAsync(
            'system',
            'adapter',
            { startkey: 'system.adapter.', endkey: 'system.adapter.香' },
            { user: this.defaultUser },
        );
        return view.rows.map(row => {
            const common = (row.value?.common || {}) as Record<string, any>;
            return {
                name: common.name || row.id.replace('system.adapter.', ''),
                version: common.version || '',
                title: getText(common.titleLang || common.title, lang),
                description: getText(common.desc, lang),
                keywords: common.keywords || [],
                mode: common.mode || '',
            };
        });
    }

    /**
     * Search the adapter repository (all installable adapters) by keyword. Reads the already-downloaded
     * repository object `system.repositories` — fast, no network — and matches against name, title,
     * description and keywords, with an optional category `type` filter and an `installed` flag.
     */
    private async searchAdapterRepository(params: {
        query?: string;
        type?: string;
        onlyNotInstalled?: boolean;
        language?: ioBroker.Languages;
        limit?: number;
    }): Promise<Record<string, unknown>[]> {
        const lang = params.language || this.language;
        const needle = (params.query || '').toLowerCase();
        const limit = params.limit ?? 20;

        const reposObj = await this.adapter.getForeignObjectAsync('system.repositories', { user: this.defaultUser });
        const repositories = (reposObj?.native?.repositories || {}) as Record<string, { json?: Record<string, any> }>;

        // Prefer the active repository; fall back to the first repository that has content.
        const sysCfg = await this.adapter.getForeignObjectAsync('system.config', { user: this.defaultUser });
        const active = sysCfg?.common?.activeRepo;
        const activeNames = Array.isArray(active) ? active : active ? [active] : [];

        // Merge the JSON of ALL active repositories (or all repositories if none is marked active). An
        // adapter present in several repos is kept once (first/active repo wins). This matters when the
        // user has custom repos active next to the default one (their adapters are not in stable).
        const activeWithJson = activeNames.filter(name => repositories[name]?.json);
        const sources = (
            activeWithJson.length ? activeWithJson.map(name => repositories[name]) : Object.values(repositories)
        )
            .map(repo => repo?.json)
            .filter((j): j is Record<string, any> => !!j);
        const json: Record<string, any> = {};
        for (const src of sources) {
            for (const key of Object.keys(src)) {
                if (!(key in json)) {
                    json[key] = src[key];
                }
            }
        }
        if (!Object.keys(json).length) {
            return [];
        }

        // Determine which adapters are already installed.
        const installedView = await this.adapter.getObjectViewAsync(
            'system',
            'adapter',
            { startkey: 'system.adapter.', endkey: 'system.adapter.香' },
            { user: this.defaultUser },
        );
        const installed = new Set(
            installedView.rows.map(row => row.value?.common?.name || row.id.replace('system.adapter.', '')),
        );

        const results: Record<string, unknown>[] = [];
        for (const [name, entry] of Object.entries(json)) {
            if (name.startsWith('_')) {
                continue; // skip _repoInfo and similar meta keys
            }
            const e = entry as Record<string, any>;
            const title = getText(e.titleLang || e.title, lang);
            const desc = getText(e.desc, lang);
            const keywords: string[] = Array.isArray(e.keywords) ? e.keywords : [];
            const type = (e.type as string) || '';

            if (params.type && type !== params.type) {
                continue;
            }
            const isInstalled = installed.has(name);
            if (params.onlyNotInstalled && isInstalled) {
                continue;
            }
            if (needle && !`${name} ${title} ${desc} ${keywords.join(' ')}`.toLowerCase().includes(needle)) {
                continue;
            }
            results.push({
                name,
                title,
                description: desc,
                keywords,
                type,
                version: (e.version as string) || '',
                installed: isInstalled,
            });
            if (results.length >= limit) {
                break;
            }
        }
        return results;
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
            const enumObj = row.value;
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
                return isNaN(n) ? value : n;
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
            return {
                path,
                mimeType,
                encoding: 'base64',
                content: Buffer.from(file).toString('base64'),
            };
        }
        return { path, mimeType, encoding: 'utf8', content: file };
    }

    /** Write a file to an adapter file storage. */
    private async writeFile(path: string, content: string, base64?: boolean): Promise<void> {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data: string | Buffer = base64 ? Buffer.from(content, 'base64') : content;
        await this.adapter.writeFileAsync(adapterName, fileName, data, { user: this.defaultUser });
    }

    /** List a directory in an adapter file storage. */
    private async listFiles(path: string): Promise<Record<string, unknown>[]> {
        const { adapterName, dirName } = McpServer.parseDirPath(path);
        const entries = await this.adapter.readDirAsync(adapterName, dirName, { user: this.defaultUser });
        return (entries || []).map(entry => ({
            file: entry.file,
            isDir: !!entry.isDir,
            size: entry.stats?.size,
            modified: entry.modifiedAt,
        }));
    }

    /** Rename/move a file within the same adapter file storage. */
    private async renameFile(path: string, newPath: string): Promise<void> {
        const from = McpServer.parseFilePath(path);
        const to = McpServer.parseFilePath(newPath);
        if (from.adapterName !== to.adapterName) {
            throw new Error('Renaming across adapter storages is not supported; both paths must share the adapter');
        }
        await this.adapter.renameAsync(from.adapterName, from.fileName, to.fileName, { user: this.defaultUser });
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

    /** Split a directory path "<adapter>[/<dir>]" into adapter name and (possibly empty) directory. */
    private static parseDirPath(path: string): { adapterName: string; dirName: string } {
        const [adapterName, ...rest] = path.replace(/^\//, '').replace(/\/$/, '').split('/');
        if (!adapterName) {
            throw new Error('Path must start with an adapter name, e.g. "vis-2.0/main" or "0_userdata.0"');
        }
        return { adapterName, dirName: rest.join('/') };
    }

    /** Delete an object, optionally with all its children. */
    private async deleteObject(id: string, recursive?: boolean): Promise<void> {
        const existing = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
        if (!existing) {
            throw new Error(`Object "${id}" does not exist`);
        }
        await this.adapter.delForeignObjectAsync(id, { user: this.defaultUser, recursive: !!recursive });
    }

    /** Create a new state object; refuses to overwrite an existing object. */
    private async createState(params: {
        id: string;
        name?: string;
        type?: ioBroker.CommonType;
        role?: string;
        read?: boolean;
        write?: boolean;
        unit?: string;
        min?: number;
        max?: number;
        step?: number;
        def?: unknown;
        desc?: string;
    }): Promise<{ id: string }> {
        const existing = await this.adapter.getForeignObjectAsync(params.id, { user: this.defaultUser });
        if (existing) {
            throw new Error(`Object "${params.id}" already exists - use set_object to modify it`);
        }
        const common: ioBroker.StateCommon = {
            name: params.name || params.id.split('.').pop() || params.id,
            type: params.type || 'mixed',
            role: params.role || 'state',
            read: params.read !== false,
            write: params.write !== false,
        };
        if (params.unit !== undefined) {
            common.unit = params.unit;
        }
        if (params.min !== undefined) {
            common.min = params.min;
        }
        if (params.max !== undefined) {
            common.max = params.max;
        }
        if (params.step !== undefined) {
            common.step = params.step;
        }
        if (params.desc !== undefined) {
            common.desc = params.desc;
        }
        await this.adapter.setForeignObjectAsync(
            params.id,
            { type: 'state', common, native: {} },
            { user: this.defaultUser },
        );
        if (params.def !== undefined) {
            const coerced = McpServer.coerceValue(params.def, common.type);
            await this.adapter.setForeignStateAsync(params.id, coerced, true, { user: this.defaultUser });
        }
        return { id: params.id };
    }

    /** Create or update a scene object for the ioBroker "scenes" adapter. */
    private async createScene(params: {
        name: string;
        members: { id: string; value: unknown }[];
        instance?: string;
        description?: string;
    }): Promise<{ id: string; members: number }> {
        const instance = params.instance || 'scene.0';
        const instanceObj = await this.adapter.getForeignObjectAsync(`system.adapter.${instance}`, {
            user: this.defaultUser,
        });
        if (!instanceObj) {
            throw new Error(
                `Scene adapter instance "${instance}" is not installed. Install the ioBroker "scenes" adapter first.`,
            );
        }
        // Scene IDs may not contain the characters that are forbidden in ioBroker IDs.
        const sceneName = params.name.replace(/[\s.*?"'[\]]/g, '_');
        const id = `${instance}.${sceneName}`;

        const sceneObj: ioBroker.SettableObject = {
            type: 'state',
            common: {
                name: params.name,
                type: 'boolean',
                role: 'scene.state',
                desc: params.description || '',
                read: true,
                write: true,
                def: false,
                engine: `system.adapter.${instance}`,
                enabled: true,
            } as ioBroker.StateCommon,
            native: {
                onTrue: { trigger: {}, cron: null, astro: null },
                onFalse: { enabled: false, trigger: {}, cron: null, astro: null },
                members: params.members.map(member => ({
                    id: member.id,
                    setIfTrue: member.value,
                    setIfFalse: null,
                    stopAllDelays: true,
                    delay: 0,
                    disabled: false,
                })),
                burstInterval: 0,
            },
        };
        await this.adapter.setForeignObjectAsync(id, sceneObj, { user: this.defaultUser });
        return { id, members: params.members.length };
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
