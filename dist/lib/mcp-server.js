"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const node_crypto_1 = require("node:crypto");
const node_os_1 = __importDefault(require("node:os"));
const zod_1 = require("zod");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const devices_1 = require("./devices");
const iob_uri_1 = require("./iob-uri");
const SERVER_NAME = 'iobroker-mcp';
const SERVER_VERSION = '0.0.1';
/** Map the human-friendly aggregation names from the manifest to ioBroker history values. */
const AGG_MAP = {
    raw: 'none',
    min: 'min',
    max: 'max',
    avg: 'average',
    sum: 'total',
};
const WEB_EXTENSION_PREFIX = 'mcp/';
/** Languages offered for localized names. */
const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
/** Localize an ioBroker name to a plain string for the given language. */
function getText(text, language) {
    if (!text) {
        return '';
    }
    if (typeof text === 'string') {
        return text;
    }
    return text[language] || text.en || '';
}
/** URI prefix for the (non-standard, ioBroker-specific) log stream resource. */
const LOG_URI_PREFIX = 'ioblog://';
/** How many recent log lines to keep for `ioblog://` resource reads. */
const LOG_BUFFER_SIZE = 200;
class McpServer {
    adapter;
    app;
    /** Active sessions keyed by session id. */
    sessions = {};
    /** Ref-count of adapter-level subscriptions across all sessions, keyed by "<type>:<address>" or "log". */
    subscriptionCounts = {};
    /** Recent log lines kept for `ioblog://` resource reads (filled while there are log subscribers). */
    logBuffer = [];
    config;
    namespace;
    extension;
    routerPrefix;
    /** The ioBroker user whose permissions every MCP request runs with. */
    defaultUser;
    /** Default language used to localize device/room/function names. */
    language;
    constructor(server, webSettings, adapter, instanceSettings, app) {
        this.app = app;
        this.adapter = adapter;
        this.config = instanceSettings ? instanceSettings.native : adapter.config;
        this.namespace = instanceSettings
            ? instanceSettings._id.substring('system.adapter.'.length)
            : this.adapter.namespace;
        this.extension = !!instanceSettings;
        this.routerPrefix = this.extension ? `/${WEB_EXTENSION_PREFIX}` : '/';
        // Determine the ioBroker user whose permissions all MCP requests run with.
        // Prefer this adapter's own setting; when embedded fall back to the host web server's
        // default user; finally to "admin". Always normalize to the "system.user." prefix.
        const rawUser = (this.config.defaultUser || webSettings.defaultUser || 'admin');
        this.defaultUser = (rawUser.startsWith('system.user.') ? rawUser : `system.user.${rawUser}`);
        this.config.defaultUser = this.defaultUser;
        this.language = webSettings.language || 'en';
        // Permission toggles: state writes are allowed by default, object/file changes are not.
        this.config.allowSetState = this.config.allowSetState !== false;
        this.config.allowObjectChange = this.config.allowObjectChange === true;
        // Receive ioBroker log messages (only forwarded once a session subscribes via requireLog).
        this.adapter.on('log', this.onLog);
        this.initRoutes();
    }
    initRoutes() {
        // The MCP endpoint. In standalone mode this is `/mcp`; as a web extension we own the
        // `/<adapter>/` namespace (e.g. `/mcp/`) within the shared web server. `.replace` strips
        // the trailing slash so the route matches both `/mcp` and `/mcp/` (Express, non-strict).
        const mcpPath = this.extension ? this.routerPrefix.replace(/\/$/, '') : '/mcp';
        // The MCP transport needs a parsed JSON body; apply the parser per-route so we never
        // touch the body handling of the web adapter or other extensions when running embedded.
        const jsonParser = express_1.default.json({ limit: '4mb' });
        // Health endpoint inside our own namespace (`/status` standalone, `/mcp/status` embedded).
        this.app.get(`${this.routerPrefix}status`, (_req, res) => {
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
            this.app.use((req, _res, next) => {
                this.adapter.log.debug(`${req.method} ${req.url} from ${req.ip}`);
                next();
            });
            this.app.get('/', (_req, res) => {
                res.json({
                    name: 'ioBroker MCP Server',
                    version: SERVER_VERSION,
                    status: 'running',
                    mcpEndpoint: '/mcp',
                });
            });
            this.app.get('/api/info', (_req, res) => {
                res.json({
                    adapter: 'mcp',
                    version: SERVER_VERSION,
                    secure: this.config.secure,
                    auth: this.config.auth,
                });
            });
        }
        // --- MCP Streamable HTTP transport ---
        this.app.post(mcpPath, jsonParser, (req, res) => {
            void this.handleMcpPost(req, res);
        });
        this.app.get(mcpPath, (req, res) => {
            void this.handleMcpSessionRequest(req, res);
        });
        this.app.delete(mcpPath, (req, res) => {
            void this.handleMcpSessionRequest(req, res);
        });
        // Catch-all 404 + error handlers only in standalone mode; the web adapter provides its own.
        if (!this.extension) {
            this.app.use((req, res) => {
                res.status(404).json({ error: 'Not Found', path: req.url });
            });
            this.app.use((err, _req, res, _next) => {
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
    welcomePage() {
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
    async handleMcpPost(req, res) {
        const sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? this.sessions[sessionId]?.transport : undefined;
        if (!transport) {
            // No session yet: only an "initialize" request may create one.
            if (sessionId || !(0, types_js_1.isInitializeRequest)(req.body)) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                    id: null,
                });
                return;
            }
            const subscriptions = new Set();
            const server = this.createServer(subscriptions);
            transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: () => (0, node_crypto_1.randomUUID)(),
                onsessioninitialized: (sid) => {
                    this.sessions[sid] = { transport: transport, server, subscriptions };
                    this.adapter.log.debug(`MCP session initialized: ${sid}`);
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
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
    async handleMcpSessionRequest(req, res) {
        const sessionId = req.headers['mcp-session-id'];
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
    stateChange(id, _state) {
        this.notifySubscribers('state', id);
    }
    /**
     * Forward an ioBroker object change to subscribed sessions. Called by our own adapter
     * (standalone) or automatically by the host web adapter (extension mode).
     */
    objectChange(id, _obj) {
        this.notifySubscribers('object', id);
    }
    /** Push `resources/updated` to every session subscribed to the given state/object id. */
    notifySubscribers(type, id) {
        for (const sid of Object.keys(this.sessions)) {
            const session = this.sessions[sid];
            for (const uri of session.subscriptions) {
                if (uri.startsWith(LOG_URI_PREFIX)) {
                    continue;
                }
                const parsed = (0, iob_uri_1.iobUriParse)(uri);
                if (parsed.type === type && parsed.address === id) {
                    session.server.server.sendResourceUpdated({ uri }).catch(e => {
                        this.adapter.log.debug(`Cannot notify session ${sid} about ${uri}: ${e}`);
                    });
                }
            }
        }
    }
    /** Receive an ioBroker log line: buffer it and push `resources/updated` to ioblog subscribers. */
    onLog = (message) => {
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
    uriKind(uri) {
        if (uri.startsWith(LOG_URI_PREFIX)) {
            return { kind: 'log', address: uri.substring(LOG_URI_PREFIX.length) || 'all', key: 'log' };
        }
        const { type, address } = (0, iob_uri_1.iobUriParse)(uri);
        if (type === 'state' || type === 'object') {
            return { kind: type, address, key: `${type}:${address}` };
        }
        return { kind: 'other', address: '', key: '' };
    }
    /** Add an adapter-level subscription, subscribing on the adapter only on the first reference. */
    async refSubscribe(uri) {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other') {
            return;
        }
        if (!this.subscriptionCounts[key]) {
            this.subscriptionCounts[key] = 0;
            if (kind === 'log') {
                await this.adapter.requireLog?.(true);
            }
            else if (kind === 'object') {
                await this.adapter.subscribeForeignObjectsAsync(address);
            }
            else {
                await this.adapter.subscribeForeignStatesAsync(address);
            }
        }
        this.subscriptionCounts[key]++;
    }
    /** Drop an adapter-level subscription, unsubscribing on the adapter when the last reference goes. */
    async refUnsubscribe(uri) {
        const { kind, address, key } = this.uriKind(uri);
        if (kind === 'other' || !this.subscriptionCounts[key]) {
            return;
        }
        this.subscriptionCounts[key]--;
        if (this.subscriptionCounts[key] <= 0) {
            delete this.subscriptionCounts[key];
            if (kind === 'log') {
                await this.adapter.requireLog?.(false);
            }
            else if (kind === 'object') {
                await this.adapter.unsubscribeForeignObjectsAsync(address);
            }
            else {
                await this.adapter.unsubscribeForeignStatesAsync(address);
            }
        }
    }
    /** Release all subscriptions held by a session (on close). */
    async cleanupSession(session) {
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
    createServer(subscriptions) {
        const server = new mcp_js_1.McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {}, resources: { subscribe: true } } });
        const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
        const fail = (error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.adapter.log.warn(`MCP tool error: ${message}`);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
        };
        server.registerTool('get_states', {
            description: 'Retrieve the current value of one or multiple states',
            inputSchema: { ids: zod_1.z.array(zod_1.z.string()).describe('Array of state IDs') },
        }, async ({ ids }) => {
            try {
                return ok({ ok: true, data: { states: await this.getStates(ids) } });
            }
            catch (e) {
                return fail(e);
            }
        });
        if (this.config.allowSetState) {
            server.registerTool('set_state', {
                description: 'Set the value of a state. The value is coerced to the state type (boolean/number/string).',
                inputSchema: {
                    id: zod_1.z.string().describe('State ID'),
                    value: zod_1.z.any().describe('New value (type depends on the state)'),
                    options: zod_1.z
                        .object({ ack: zod_1.z.boolean().default(false), expire: zod_1.z.number().int().nullable().optional() })
                        .optional(),
                },
            }, async ({ id, value, options }) => {
                try {
                    const written = await this.setState(id, value, options?.ack ?? false);
                    return ok({ ok: true, data: { id, value: written } });
                }
                catch (e) {
                    return fail(e);
                }
            });
        }
        server.registerTool('get_logs', {
            description: 'Retrieve system logs',
            inputSchema: {
                level: zod_1.z.array(zod_1.z.enum(['error', 'warn', 'info', 'debug'])).optional(),
                from_ts: zod_1.z.number().int().optional(),
                limit: zod_1.z.number().int().default(200),
                adapter: zod_1.z.string().optional(),
            },
        }, async (args) => {
            try {
                return ok({ ok: true, data: { logs: await this.getLogs(args) } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('system_info', { description: 'Get system and js-controller information' }, async () => {
            try {
                return ok({ ok: true, data: await this.getSystemInfo() });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('search_objects', {
            description: 'Search objects and states by keywords',
            inputSchema: {
                query: zod_1.z.string().describe('Keyword to search for'),
                role: zod_1.z.string().optional(),
                room: zod_1.z.string().optional(),
                limit: zod_1.z.number().int().default(50),
            },
        }, async (args) => {
            try {
                return ok({ ok: true, data: { results: await this.searchObjects(args) } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('list_devices', {
            description: 'List detected devices grouped by room. Uses the ioBroker type-detector to turn ' +
                'raw states/channels/devices into functional devices with named controls.',
            inputSchema: {
                language: zod_1.z
                    .enum(['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'])
                    .optional()
                    .describe('Language for device/room/function names (defaults to the adapter language)'),
                room: zod_1.z.string().optional().describe('Filter the result to a single room (by name)'),
            },
        }, async (args) => {
            try {
                return ok({ ok: true, data: { rooms: await this.listDevices(args) } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('history_query', {
            description: 'Query historical values of a state (requires a history adapter)',
            inputSchema: {
                id: zod_1.z.string(),
                from: zod_1.z.string().optional().describe('Start time (ISO8601)'),
                to: zod_1.z.string().optional().describe('End time (ISO8601)'),
                agg: zod_1.z.enum(['raw', 'min', 'max', 'avg', 'sum']).default('raw'),
                interval: zod_1.z.string().optional().describe('Aggregation interval, e.g. 15m, 1h'),
                limit: zod_1.z.number().int().default(1000),
            },
        }, async (args) => {
            try {
                return ok({ ok: true, data: await this.historyQuery(args) });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('list_instances', { description: 'List all adapter instances with their status' }, async () => {
            try {
                return ok({ ok: true, data: { instances: await this.listInstances() } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('list_hosts', { description: 'List all ioBroker hosts with their status' }, async () => {
            try {
                return ok({ ok: true, data: { hosts: await this.listHosts() } });
            }
            catch (e) {
                return fail(e);
            }
        });
        const enumInput = {
            language: zod_1.z.enum(LANGUAGES).optional().describe('Language for names (defaults to the adapter language)'),
            withIcons: zod_1.z.boolean().optional().describe('Include the icons of the enum and its members'),
        };
        server.registerTool('list_rooms', { description: 'List all rooms (enum.rooms.*) with their members and metadata', inputSchema: enumInput }, async ({ language, withIcons }) => {
            try {
                return ok({ ok: true, data: { rooms: await this.readEnums('rooms', language, withIcons) } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('list_functions', {
            description: 'List all functions (enum.functions.*) with their members and metadata',
            inputSchema: enumInput,
        }, async ({ language, withIcons }) => {
            try {
                return ok({
                    ok: true,
                    data: { functions: await this.readEnums('functions', language, withIcons) },
                });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('get_object', {
            description: 'Read a single ioBroker object by its ID',
            inputSchema: { id: zod_1.z.string().describe('Object ID, e.g. system.adapter.admin.0 or hm-rpc.0.ABC') },
        }, async ({ id }) => {
            try {
                const object = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
                return ok({ ok: true, data: { object: object ?? null } });
            }
            catch (e) {
                return fail(e);
            }
        });
        server.registerTool('read_file', {
            description: 'Read a file from an adapter file storage, e.g. "vis-2.0/main/vis-views.json"',
            inputSchema: {
                path: zod_1.z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                base64: zod_1.z.boolean().optional().describe('Return binary content base64-encoded'),
            },
        }, async ({ path, base64 }) => {
            try {
                return ok({ ok: true, data: await this.readFile(path, base64) });
            }
            catch (e) {
                return fail(e);
            }
        });
        // Always-on log writing (does not change states or objects).
        server.registerTool('write_log', {
            description: 'Write a message to the ioBroker log',
            inputSchema: {
                message: zod_1.z.string(),
                level: zod_1.z.enum(['error', 'warn', 'info', 'debug']).default('info'),
            },
        }, ({ message, level }) => {
            try {
                this.adapter.log[level](message);
                return Promise.resolve(ok({ ok: true, data: { message, level } }));
            }
            catch (e) {
                return Promise.resolve(fail(e));
            }
        });
        // Object/file changes are gated behind the "allowObjectChange" option (off by default).
        if (this.config.allowObjectChange) {
            server.registerTool('set_object', {
                description: 'Create or update an ioBroker object. An existing object is updated by merging the ' +
                    'provided common/native; a missing one is created from the provided object.',
                inputSchema: {
                    id: zod_1.z.string().describe('Object ID'),
                    obj: zod_1.z
                        .record(zod_1.z.string(), zod_1.z.any())
                        .describe('Partial object, e.g. { "type": "state", "common": {...}, "native": {...} }'),
                },
            }, async ({ id, obj }) => {
                try {
                    const result = await this.setObject(id, obj);
                    return ok({ ok: true, data: result });
                }
                catch (e) {
                    return fail(e);
                }
            });
            server.registerTool('write_file', {
                description: 'Write a file to an adapter file storage, e.g. "vis-2.0/main/vis-views.json"',
                inputSchema: {
                    path: zod_1.z.string().describe('Path as "<adapter>/<dir>/<file>"'),
                    content: zod_1.z.string().describe('File content (UTF-8, or base64 when base64=true)'),
                    base64: zod_1.z.boolean().optional().describe('Treat content as base64-encoded binary'),
                },
            }, async ({ path, content, base64 }) => {
                try {
                    await this.writeFile(path, content, base64);
                    return ok({ ok: true, data: { path } });
                }
                catch (e) {
                    return fail(e);
                }
            });
        }
        // --- Resources: expose states and objects via the canonical ioBroker URI scheme ---
        // States as `iobstate://<id>`, objects as `iobobject://<id>`. On change the server pushes a
        // `notifications/resources/updated` over the session's SSE stream and the client re-reads.
        server.registerResource('state', new mcp_js_1.ResourceTemplate('iobstate://{id}', { list: undefined }), {
            title: 'ioBroker state',
            description: 'A single ioBroker state value, addressed as iobstate://<id>',
            mimeType: 'application/json',
        }, async (uri, variables) => {
            const id = decodeURIComponent(String(variables.id));
            const state = await this.adapter.getForeignStateAsync(id, { user: this.defaultUser });
            const body = state
                ? { id, val: state.val, ack: state.ack, ts: state.ts, lc: state.lc, q: state.q }
                : { id, val: null };
            return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
        });
        server.registerResource('object', new mcp_js_1.ResourceTemplate('iobobject://{id}', { list: undefined }), {
            title: 'ioBroker object',
            description: 'A single ioBroker object, addressed as iobobject://<id>',
            mimeType: 'application/json',
        }, async (uri, variables) => {
            const id = decodeURIComponent(String(variables.id));
            const obj = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
            return {
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(obj ?? null) }],
            };
        });
        // Log stream: `ioblog://all` for every source, or `ioblog://<source>` (e.g. ioblog://admin.0).
        // Subscribe to receive `resources/updated` on each new log line, then re-read for recent lines.
        server.registerResource('log', new mcp_js_1.ResourceTemplate(`${LOG_URI_PREFIX}{source}`, { list: undefined }), {
            title: 'ioBroker log stream',
            description: 'Recent log lines, addressed as ioblog://all or ioblog://<source>',
            mimeType: 'application/json',
        }, (uri, variables) => {
            const source = decodeURIComponent(String(variables.source)) || 'all';
            const logs = this.logBuffer
                .filter(m => source === 'all' || m.from === source)
                .map(m => ({ ts: m.ts, level: m.severity, source: m.from, message: m.message }));
            return Promise.resolve({
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ source, logs }) }],
            });
        });
        // Manual subscribe/unsubscribe handlers (the high-level McpServer does not provide them).
        // Subscriptions are stored as the full canonical URI; supported for states and objects.
        server.server.setRequestHandler(types_js_1.SubscribeRequestSchema, async (request) => {
            const uri = request.params.uri;
            if (this.uriKind(uri).kind !== 'other' && !subscriptions.has(uri)) {
                subscriptions.add(uri);
                await this.refSubscribe(uri);
            }
            return {};
        });
        server.server.setRequestHandler(types_js_1.UnsubscribeRequestSchema, async (request) => {
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
    async getStates(ids) {
        const states = [];
        for (const id of ids) {
            try {
                const state = await this.adapter.getForeignStateAsync(id, { user: this.defaultUser });
                if (state) {
                    const entry = { id, value: state.val, ack: state.ack, ts: state.ts };
                    if (state.lc !== state.ts) {
                        entry.lc = state.lc;
                    }
                    states.push(entry);
                }
                else {
                    states.push({ id, value: null, ack: false, ts: Date.now() });
                }
            }
            catch (e) {
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
    getLogs(params) {
        return new Promise((resolve, reject) => {
            const message = { data: { size: params.limit || 200 } };
            if (params.from_ts !== undefined) {
                message.data.from_ts = params.from_ts;
            }
            if (params.adapter !== undefined) {
                message.data.source = params.adapter;
            }
            this.adapter.sendToHost(this.adapter.host || null, 'getLogs', message, (result) => {
                if (!result || result.error) {
                    reject(new Error(result?.error || 'Failed to retrieve logs'));
                    return;
                }
                let logs = result.list || [];
                if (params.level && params.level.length > 0) {
                    logs = logs.filter(log => params.level.includes(log.severity));
                }
                resolve(logs.map(log => ({
                    ts: log.ts,
                    level: log.severity,
                    source: log.from,
                    message: log.message,
                    host: this.adapter.host,
                })));
            });
        });
    }
    async getSystemInfo() {
        const hostObj = await this.adapter.getForeignObjectAsync(`system.host.${this.adapter.host}`, {
            user: this.defaultUser,
        });
        const jsControllerVersion = hostObj?.common?.installedVersion || 'unknown';
        const totalMem = Math.round(node_os_1.default.totalmem() / (1024 * 1024));
        const freeMem = Math.round(node_os_1.default.freemem() / (1024 * 1024));
        const instanceObjs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.defaultUser,
        });
        return {
            js_controller: jsControllerVersion,
            hostname: node_os_1.default.hostname(),
            platform: node_os_1.default.platform(),
            node: process.version.substring(1),
            cpu_load: parseFloat((node_os_1.default.loadavg()[0] || 0).toFixed(2)),
            mem: { total_mb: totalMem, used_mb: totalMem - freeMem },
            uptime_sec: Math.round(node_os_1.default.uptime()),
            instances: Object.keys(instanceObjs || {}).length,
        };
    }
    async searchObjects(params) {
        const { query = '', role, room, limit = 100 } = params;
        const result = await this.adapter.getObjectListAsync({
            startkey: '',
            endkey: '\u9999',
        }, { sorted: true, user: this.defaultUser });
        const allObjects = result.rows;
        const roomMembers = room ? await this.getEnumMembers('enum.rooms.', room) : null;
        const results = [];
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
    async listDevices(params) {
        const lang = params.language || this.language;
        const rooms = await (0, devices_1.getAiFriendlyStructure)(this.adapter, lang, { user: this.defaultUser });
        if (params.room) {
            const needle = params.room.toLowerCase();
            return rooms.filter(r => r.roomName.toLowerCase() === needle);
        }
        return rooms;
    }
    async historyQuery(params) {
        const options = {
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
        options.user = this.defaultUser;
        const res = await this.adapter.getHistoryAsync(params.id, options);
        return { id: params.id, values: res?.result || [] };
    }
    async listInstances() {
        const objs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance', {
            user: this.defaultUser,
        });
        const result = [];
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
    async listHosts() {
        const objs = await this.adapter.getForeignObjectsAsync('system.host.*', 'host', { user: this.defaultUser });
        const result = [];
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
    async readEnums(type, language, withIcons) {
        const enums = await this.adapter.getObjectViewAsync('system', 'enum', { startkey: `enum.${type}.`, endkey: `enum.${type}.香` }, { user: this.defaultUser });
        const result = [];
        // Cache member objects so a member shared by several enums is read only once.
        const cache = {};
        for (const row of enums.rows) {
            const enumObj = row.value;
            const common = (enumObj.common || {});
            const oneEnum = {
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
                    }
                    catch {
                        cache[member] = false;
                    }
                    obj = cache[member];
                }
                if (obj) {
                    const c = (obj.common || {});
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
    async setState(id, value, ack) {
        const obj = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
        const stateType = obj?.common?.type;
        const coerced = McpServer.coerceValue(value, stateType);
        await this.adapter.setForeignStateAsync(id, coerced, ack, { user: this.defaultUser });
        return coerced;
    }
    /** Coerce an arbitrary value to the given ioBroker state type. */
    static coerceValue(value, type) {
        if (value === null || value === undefined) {
            return value;
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
            return value;
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
            return value;
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
        return value;
    }
    /** Read a file from an adapter file storage. */
    async readFile(path, base64) {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data = await this.adapter.readFileAsync(adapterName, fileName, { user: this.defaultUser });
        const file = data?.file;
        const mimeType = data?.mimeType;
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
    async writeFile(path, content, base64) {
        const { adapterName, fileName } = McpServer.parseFilePath(path);
        const data = base64 ? Buffer.from(content, 'base64') : content;
        await this.adapter.writeFileAsync(adapterName, fileName, data, { user: this.defaultUser });
    }
    /** Create or update an object, merging common/native into an existing object (n8n `setIobObject`). */
    async setObject(id, obj) {
        let existing = await this.adapter.getForeignObjectAsync(id, { user: this.defaultUser });
        if (existing) {
            if (obj.common) {
                existing.common = { ...existing.common, ...obj.common };
            }
            if (obj.native) {
                existing.native = { ...existing.native, ...obj.native };
            }
        }
        else {
            existing = obj;
        }
        return this.adapter.setForeignObjectAsync(id, existing, { user: this.defaultUser });
    }
    /** Split a file path "<adapter>/<dir>/<file>" into adapter name and file name. */
    static parseFilePath(path) {
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
    async getEnumMembers(prefix, nameOrId) {
        const enums = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'enum', { user: this.defaultUser });
        const needle = nameOrId.toLowerCase();
        for (const [id, obj] of Object.entries(enums || {})) {
            if (id.toLowerCase() === needle || this.getName(obj?.common?.name).toLowerCase() === needle) {
                return obj?.common?.members || [];
            }
        }
        return [];
    }
    /** Normalize an ioBroker name (string or {en, de, ...}) to a plain string. */
    getName(name) {
        if (!name) {
            return '';
        }
        if (typeof name === 'string') {
            return name;
        }
        return name.en || Object.values(name)[0] || '';
    }
    /** Parse an interval like "15m", "1h", "30s" into milliseconds. */
    parseInterval(interval) {
        const m = interval.match(/^(\d+)\s*(s|m|h|d)$/i);
        if (!m) {
            return undefined;
        }
        const value = parseInt(m[1], 10);
        const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
        return value * unit;
    }
    unload() {
        try {
            this.adapter.removeListener('log', this.onLog);
        }
        catch {
            // ignore
        }
        for (const session of Object.values(this.sessions)) {
            try {
                void session.transport.close();
            }
            catch {
                // ignore
            }
        }
        this.adapter.log.info('MCP server unloading');
    }
}
exports.default = McpServer;
//# sourceMappingURL=mcp-server.js.map