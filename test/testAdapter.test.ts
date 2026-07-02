import path from 'node:path';
import assert from 'node:assert';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { tests, type IntegrationTestHarness } from '@iobroker/testing';

// The MCP SDK ships a CommonJS build (dist/cjs/**) that these tests are compiled against. `Client`
// uses the dedicated "./client" export. The transport has no dedicated export, so it resolves through
// the SDK's "./*" -> "./dist/cjs/*" map, which is a literal substitution — Node's "exports" resolution
// does NOT append ".js", so the ".js" suffix on the streamableHttp specifier is mandatory here.
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HOST = '127.0.0.1';

type McpClient = { client: Client; transport: StreamableHTTPClientTransport };

/** Connect a fresh MCP client to the running adapter over the Streamable HTTP transport. */
async function connectClient(port: number, requestInit?: RequestInit): Promise<McpClient> {
    const url = new URL(`http://${HOST}:${port}/mcp`);
    let lastError: unknown;
    // The adapter sets info.connection only inside the listen() callback, so the socket is ready
    // by then. A short retry still guards against any rare accept-race on slow CI machines.
    for (let attempt = 0; attempt < 5; attempt++) {
        // `requestInit` lets a test attach auth headers to every transport request.
        const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
        const client = new Client({ name: 'iobroker-mcp-integration-test', version: '1.0.0' });
        try {
            await client.connect(transport);
            return { client, transport };
        } catch (e) {
            lastError = e;
            try {
                await transport.close();
            } catch {
                // ignore
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    throw lastError;
}

/** Tools return a single JSON text block; parse it back into the plain object the adapter produced. */
function parseToolResult(result: any): any {
    assert.ok(Array.isArray(result.content) && result.content.length > 0, 'tool result has a content array');
    const first = result.content[0];
    assert.strictEqual(first.type, 'text', 'tool result content is text');
    return JSON.parse(first.text);
}

/** Assert that every expected entry is present in the actual array. */
function assertIncludesAll(actual: string[], expected: string[], message: string): void {
    for (const item of expected) {
        assert.ok(actual.includes(item), `${message}: expected to include "${item}" (got ${actual.join(', ')})`);
    }
}

// --- Raw HTTP helpers for the authentication suite -------------------------------------------------
// The auth tests deliberately bypass the MCP SDK client and speak the Streamable HTTP transport with
// bare fetch calls, so we can assert on HTTP status codes (e.g. 401) and attach arbitrary credentials
// exactly the way an external script (like the one from issue #44) would.

const INITIALIZE_REQUEST = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'iobroker-mcp-auth-test', version: '1.0.0' },
    },
};

/** POST an MCP `initialize` request and return the HTTP status, the session id header and the body. */
async function rawInitialize(
    port: number,
    extraHeaders: Record<string, string> = {},
): Promise<{ status: number; sessionId: string | null; body: string }> {
    const res = await fetch(`http://${HOST}:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...extraHeaders,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
    });
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: await res.text() };
}

/** POST an MCP `tools/call` request on an existing session and return the HTTP status and body. */
async function rawToolCall(
    port: number,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://${HOST}:${port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            ...extraHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: res.status, body: await res.text() };
}

/** Extract and parse the JSON-RPC payload from a Streamable HTTP SSE response body (`data:` line). */
function parseSseData(body: string): any {
    const line = body.split('\n').find(l => l.startsWith('data:'));
    assert.ok(line, `expected an SSE "data:" line, got: ${body}`);
    return JSON.parse(line!.slice('data:'.length).trim());
}

/** HTTP Basic auth header value for the given credentials. */
function basicAuth(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Build an ioBroker-compatible password hash (`pbkdf2$<iterations>$<hash>$<salt>`), matching
 * js-controller's `password` helper, so a test user can be authenticated by the adapter.
 */
function ioBrokerPasswordHash(plain: string): string {
    const iterations = 10_000;
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(plain, salt, iterations, 256, 'sha256').toString('hex');
    return `pbkdf2$${iterations}$${hash}$${salt}`;
}

/** Create (or overwrite) an ioBroker user object with a known password, tolerant of the DB client API. */
async function createUserWithPassword(harness: IntegrationTestHarness, user: string, password: string): Promise<void> {
    const id = `system.user.${user}`;
    const obj = {
        type: 'user',
        common: { name: user, enabled: true, password: ioBrokerPasswordHash(password) },
        native: {},
        _id: id,
    };
    const objects = (harness as any).objects;
    if (typeof objects.setObjectAsync === 'function') {
        await objects.setObjectAsync(id, obj);
    } else {
        await new Promise<void>((resolve, reject) =>
            objects.setObject(id, obj, (err: Error | null | undefined) => (err ? reject(err) : resolve())),
        );
    }
}

// Run the standard ioBroker package & startup tests, then our MCP-specific integration tests.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        // --- All tools available: state & object writing enabled ----------------------------------
        suite('MCP server (write enabled)', getHarness => {
            const PORT = 18293;
            const TEST_STATE = '0_userdata.0.mcpIntegrationTest';
            let harness: IntegrationTestHarness;
            let client: Client;
            let transport: StreamableHTTPClientTransport;

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        port: PORT,
                        bind: HOST,
                        secure: false,
                        auth: false,
                        defaultUser: 'admin',
                        allowSetState: true,
                        allowObjectChange: true,
                    },
                });
                // Wait for info.connection === true => the HTTP server is listening.
                await harness.startAdapterAndWait(true);
                ({ client, transport } = await connectClient(PORT));
            });

            after(async function () {
                this.timeout(20000);
                try {
                    await client?.close();
                } catch {
                    // ignore
                }
                try {
                    await transport?.close();
                } catch {
                    // ignore
                }
                await harness?.stopAdapter();
            });

            it('handshakes and reports the server info', async function () {
                this.timeout(15000);
                const info = client.getServerVersion();
                assert.ok(info, 'server version info present after connect');
                assert.strictEqual(info!.name, 'iobroker-mcp');
            });

            it('exposes the documented tools', async function () {
                this.timeout(15000);
                const { tools } = await client.listTools();
                const names = tools.map(t => t.name);
                assertIncludesAll(
                    names,
                    [
                        'get_states',
                        'set_state',
                        'set_states',
                        'get_logs',
                        'system_info',
                        'search_objects',
                        'list_devices',
                        'history_query',
                        'list_instances',
                        'list_adapters',
                        'list_hosts',
                        'list_rooms',
                        'list_functions',
                        'get_object',
                        'read_file',
                        'list_files',
                        'file_exists',
                        'write_log',
                        'set_object',
                        'delete_object',
                        'create_state',
                        'create_scene',
                        'write_file',
                        'delete_file',
                        'rename_file',
                        'mkdir',
                    ],
                    'tool list',
                );
            });

            it('system_info returns controller and host data', async function () {
                this.timeout(15000);
                const res = parseToolResult(await client.callTool({ name: 'system_info', arguments: {} }));
                assert.strictEqual(res.ok, true);
                assert.ok(typeof res.data.hostname === 'string' && res.data.hostname.length > 0, 'hostname present');
                assert.ok(typeof res.data.node === 'string', 'node version present');
                assert.ok(res.data.instances >= 1, 'at least one instance counted');
            });

            it('list_instances lists the running mcp instance as alive', async function () {
                this.timeout(15000);
                const res = parseToolResult(await client.callTool({ name: 'list_instances', arguments: {} }));
                assert.strictEqual(res.ok, true);
                const mcp = res.data.instances.find((i: any) => i.id === `${harness.adapterName}.0`);
                assert.ok(mcp, `${harness.adapterName}.0 present in instance list`);
                assert.strictEqual(mcp.alive, true, 'mcp instance is alive');
            });

            it('list_hosts returns the host running the controller', async function () {
                this.timeout(15000);
                const res = parseToolResult(await client.callTool({ name: 'list_hosts', arguments: {} }));
                assert.strictEqual(res.ok, true);
                assert.ok(Array.isArray(res.data.hosts) && res.data.hosts.length >= 1, 'at least one host');
            });

            it('get_states reads the adapter connection state', async function () {
                this.timeout(15000);
                // info.connection lives under the adapter namespace (mcp.0.info.connection), NOT under
                // the controller-managed instance object (system.adapter.mcp.0.* holds .alive etc.).
                const id = `${harness.adapterName}.0.info.connection`;
                const res = parseToolResult(await client.callTool({ name: 'get_states', arguments: { ids: [id] } }));
                assert.strictEqual(res.ok, true);
                const state = res.data.states[0];
                assert.strictEqual(state.id, id);
                assert.strictEqual(state.value, true, 'info.connection is true while server runs');
            });

            it('get_object reads the connection state object', async function () {
                this.timeout(15000);
                const id = `${harness.adapterName}.0.info.connection`;
                const res = parseToolResult(await client.callTool({ name: 'get_object', arguments: { id } }));
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.object._id, id);
                assert.strictEqual(res.data.object.common.type, 'boolean');
            });

            it('set_object + set_state + get_states round-trip', async function () {
                this.timeout(15000);
                const created = parseToolResult(
                    await client.callTool({
                        name: 'set_object',
                        arguments: {
                            id: TEST_STATE,
                            obj: {
                                type: 'state',
                                common: {
                                    name: 'MCP integration test',
                                    type: 'boolean',
                                    role: 'switch',
                                    read: true,
                                    write: true,
                                    def: false,
                                },
                                native: {},
                            },
                        },
                    }),
                );
                assert.strictEqual(created.ok, true, 'object created');

                const written = parseToolResult(
                    await client.callTool({ name: 'set_state', arguments: { id: TEST_STATE, value: true } }),
                );
                assert.strictEqual(written.ok, true);
                assert.strictEqual(written.data.value, true, 'set_state echoes the coerced value');

                const read = parseToolResult(
                    await client.callTool({ name: 'get_states', arguments: { ids: [TEST_STATE] } }),
                );
                assert.strictEqual(read.data.states[0].value, true, 'state was persisted');
            });

            it('set_state coerces values to the declared state type', async function () {
                this.timeout(15000);
                // The state created above is boolean; the string "false" must become boolean false.
                const written = parseToolResult(
                    await client.callTool({ name: 'set_state', arguments: { id: TEST_STATE, value: 'false' } }),
                );
                assert.strictEqual(written.data.value, false, 'string "false" coerced to boolean false');
            });

            it('get_states expands wildcard patterns', async function () {
                this.timeout(15000);
                const pattern = `${harness.adapterName}.0.info.*`;
                const res = parseToolResult(
                    await client.callTool({ name: 'get_states', arguments: { ids: [pattern] } }),
                );
                assert.strictEqual(res.ok, true);
                const ids = res.data.states.map((s: any) => s.id);
                assert.ok(
                    ids.includes(`${harness.adapterName}.0.info.connection`),
                    `wildcard expanded to info.connection (got ${ids.join(', ')})`,
                );
            });

            it('set_states writes multiple states in one call', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({
                        name: 'set_states',
                        arguments: { states: [{ id: TEST_STATE, value: true }] },
                    }),
                );
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.results[0].id, TEST_STATE);
                assert.strictEqual(res.data.results[0].value, true, 'bulk write echoes the coerced value');

                const read = parseToolResult(
                    await client.callTool({ name: 'get_states', arguments: { ids: [TEST_STATE] } }),
                );
                assert.strictEqual(read.data.states[0].value, true, 'state was persisted');
            });

            it('set_states reports per-item errors without aborting the rest', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({
                        name: 'set_states',
                        arguments: {
                            states: [
                                { id: TEST_STATE, value: false },
                                { id: 'this.state.does.not.exist', value: 1 },
                            ],
                        },
                    }),
                );
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.results.length, 2, 'one result per requested state');
                assert.strictEqual(res.data.results[0].value, false, 'valid state written');
            });

            it('create_state + delete_object round-trip', async function () {
                this.timeout(15000);
                const id = '0_userdata.0.mcpCreateStateTest';
                const created = parseToolResult(
                    await client.callTool({
                        name: 'create_state',
                        arguments: { id, type: 'number', role: 'value.temperature', unit: '°C', def: 21.5 },
                    }),
                );
                assert.strictEqual(created.ok, true, 'state created');

                const obj = parseToolResult(await client.callTool({ name: 'get_object', arguments: { id } }));
                assert.strictEqual(obj.data.object.common.type, 'number');
                assert.strictEqual(obj.data.object.common.unit, '°C');

                const value = parseToolResult(
                    await client.callTool({ name: 'get_states', arguments: { ids: [id] } }),
                );
                assert.strictEqual(value.data.states[0].value, 21.5, 'initial value written');

                // Creating the same state again must fail (use set_object to modify).
                const again = parseToolResult(
                    await client.callTool({ name: 'create_state', arguments: { id, type: 'number' } }),
                );
                assert.strictEqual(again.ok, false, 'duplicate create rejected');

                const deleted = parseToolResult(
                    await client.callTool({ name: 'delete_object', arguments: { id } }),
                );
                assert.strictEqual(deleted.ok, true, 'object deleted');

                const gone = parseToolResult(await client.callTool({ name: 'get_object', arguments: { id } }));
                assert.strictEqual(gone.data.object, null, 'object no longer exists');
            });

            it('delete_object reports an error for an unknown object', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({ name: 'delete_object', arguments: { id: 'no.such.object.here' } }),
                );
                assert.strictEqual(res.ok, false, 'deleting a missing object fails');
            });

            it('create_scene fails with a helpful error when no scene adapter is installed', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({
                        name: 'create_scene',
                        arguments: { name: 'test_scene', members: [{ id: TEST_STATE, value: true }] },
                    }),
                );
                assert.strictEqual(res.ok, false, 'scene creation fails without the scenes adapter');
                assert.ok(/scene/i.test(res.error), 'error mentions the scene adapter');
            });

            it('file tools: mkdir, write, list, exists, rename, read, delete', async function () {
                this.timeout(15000);
                const dir = '0_userdata.0/mcp-test';

                const mk = parseToolResult(await client.callTool({ name: 'mkdir', arguments: { path: dir } }));
                assert.strictEqual(mk.ok, true, 'mkdir succeeded');

                const written = parseToolResult(
                    await client.callTool({
                        name: 'write_file',
                        arguments: { path: `${dir}/hello.txt`, content: 'hello mcp' },
                    }),
                );
                assert.strictEqual(written.ok, true, 'file written');

                const listed = parseToolResult(
                    await client.callTool({ name: 'list_files', arguments: { path: dir } }),
                );
                assert.strictEqual(listed.ok, true);
                const names = listed.data.files.map((f: any) => f.file);
                assert.ok(names.includes('hello.txt'), `directory listing contains hello.txt (got ${names.join(', ')})`);

                const exists = parseToolResult(
                    await client.callTool({ name: 'file_exists', arguments: { path: `${dir}/hello.txt` } }),
                );
                assert.strictEqual(exists.data.exists, true, 'file_exists finds the file');

                const renamed = parseToolResult(
                    await client.callTool({
                        name: 'rename_file',
                        arguments: { path: `${dir}/hello.txt`, new_path: `${dir}/renamed.txt` },
                    }),
                );
                assert.strictEqual(renamed.ok, true, 'file renamed');

                const read = parseToolResult(
                    await client.callTool({ name: 'read_file', arguments: { path: `${dir}/renamed.txt` } }),
                );
                assert.strictEqual(read.data.content, 'hello mcp', 'renamed file keeps its content');

                const deleted = parseToolResult(
                    await client.callTool({ name: 'delete_file', arguments: { path: `${dir}/renamed.txt` } }),
                );
                assert.strictEqual(deleted.ok, true, 'file deleted');

                const goneCheck = parseToolResult(
                    await client.callTool({ name: 'file_exists', arguments: { path: `${dir}/renamed.txt` } }),
                );
                assert.strictEqual(goneCheck.data.exists, false, 'file no longer exists');
            });

            it('list_adapters includes this adapter', async function () {
                this.timeout(15000);
                const res = parseToolResult(await client.callTool({ name: 'list_adapters', arguments: {} }));
                assert.strictEqual(res.ok, true);
                const entry = res.data.adapters.find((a: any) => a.name === harness.adapterName);
                assert.ok(entry, `${harness.adapterName} present in adapter list`);
                assert.ok(typeof entry.version === 'string' && entry.version.length > 0, 'version present');
            });

            it('search_objects filters by object type', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({
                        name: 'search_objects',
                        arguments: { query: harness.adapterName, type: 'instance' },
                    }),
                );
                assert.strictEqual(res.ok, true);
                assert.ok(res.data.results.length >= 1, 'at least the mcp instance found');
                assert.ok(
                    res.data.results.every((r: any) => r.type === 'instance'),
                    'all results are instances',
                );
            });

            it('search_objects finds the created test state', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({ name: 'search_objects', arguments: { query: 'mcpIntegrationTest' } }),
                );
                assert.strictEqual(res.ok, true);
                const ids = res.data.results.map((r: any) => r.id);
                assert.ok(ids.includes(TEST_STATE), 'created state found by search');
            });

            it('list_rooms / list_functions / list_devices return structured data', async function () {
                this.timeout(15000);
                const rooms = parseToolResult(await client.callTool({ name: 'list_rooms', arguments: {} }));
                assert.strictEqual(rooms.ok, true);
                assert.ok(Array.isArray(rooms.data.rooms), 'rooms is an array');

                const functions = parseToolResult(await client.callTool({ name: 'list_functions', arguments: {} }));
                assert.strictEqual(functions.ok, true);
                assert.ok(Array.isArray(functions.data.functions), 'functions is an array');

                const devices = parseToolResult(await client.callTool({ name: 'list_devices', arguments: {} }));
                assert.strictEqual(devices.ok, true);
                assert.ok(Array.isArray(devices.data.rooms), 'devices grouped into rooms array');
            });

            it('exposes an iobstate resource that can be read', async function () {
                this.timeout(15000);
                const id = `${harness.adapterName}.0.info.connection`;
                const res = await client.readResource({ uri: `iobstate://${id}` });
                const body = JSON.parse(res.contents[0].text as string);
                assert.strictEqual(body.id, id);
                assert.strictEqual(body.val, true);
            });

            it('exposes an iobobject resource that can be read', async function () {
                this.timeout(15000);
                const id = `${harness.adapterName}.0.info.connection`;
                const res = await client.readResource({ uri: `iobobject://${id}` });
                const body = JSON.parse(res.contents[0].text as string);
                assert.strictEqual(body._id, id);
            });

            it('write_log accepts a message', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({
                        name: 'write_log',
                        arguments: { message: 'integration test log line', level: 'info' },
                    }),
                );
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.level, 'info');
            });

            it('reports a tool error for an unknown object instead of throwing', async function () {
                this.timeout(15000);
                const result = await client.callTool({
                    name: 'get_object',
                    arguments: { id: 'this.object.does.not.exist' },
                });
                const body = parseToolResult(result);
                // Unknown object resolves to null (ok:true, object null) rather than an error.
                assert.strictEqual(body.ok, true);
                assert.strictEqual(body.data.object, null);
            });
        });

        // --- Permission gating: writing states & objects disabled ---------------------------------
        suite('MCP server (write disabled)', getHarness => {
            const PORT = 18294;
            let harness: IntegrationTestHarness;
            let client: Client;
            let transport: StreamableHTTPClientTransport;

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        port: PORT,
                        bind: HOST,
                        secure: false,
                        auth: false,
                        defaultUser: 'admin',
                        allowSetState: false,
                        allowObjectChange: false,
                    },
                });
                await harness.startAdapterAndWait(true);
                ({ client, transport } = await connectClient(PORT));
            });

            after(async function () {
                this.timeout(20000);
                try {
                    await client?.close();
                } catch {
                    // ignore
                }
                try {
                    await transport?.close();
                } catch {
                    // ignore
                }
                await harness?.stopAdapter();
            });

            it('hides the write tools but keeps read & log tools', async function () {
                this.timeout(15000);
                const { tools } = await client.listTools();
                const names = tools.map(t => t.name);

                // Read-only and always-on tools remain available.
                assertIncludesAll(
                    names,
                    ['get_states', 'get_object', 'search_objects', 'write_log', 'list_files', 'file_exists'],
                    'read tools',
                );

                // Mutating tools must be gated off.
                for (const tool of [
                    'set_state',
                    'set_states',
                    'set_object',
                    'delete_object',
                    'create_state',
                    'create_scene',
                    'write_file',
                    'delete_file',
                    'rename_file',
                    'mkdir',
                ]) {
                    assert.ok(!names.includes(tool), `${tool} hidden when writing is disabled`);
                }
            });

            it('still serves read tools', async function () {
                this.timeout(15000);
                const id = `${harness.adapterName}.0.info.connection`;
                const res = parseToolResult(await client.callTool({ name: 'get_states', arguments: { ids: [id] } }));
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.states[0].value, true);
            });
        });

        // --- Authentication: the endpoint must reject unauthenticated access (issue #44) -----------
        suite('MCP server (auth enabled)', getHarness => {
            const PORT = 18295;
            const AUTH_USER = 'mcpauthtester';
            const AUTH_PASS = 'McpTest123';
            let harness: IntegrationTestHarness;

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        port: PORT,
                        bind: HOST,
                        secure: false,
                        auth: true,
                        defaultUser: 'admin',
                        allowSetState: true,
                        allowObjectChange: false,
                    },
                });
                // A dedicated user with a known password so we can prove the authenticated path works.
                await createUserWithPassword(harness, AUTH_USER, AUTH_PASS);
                await harness.startAdapterAndWait(true);
            });

            after(async function () {
                this.timeout(20000);
                await harness?.stopAdapter();
            });

            it('rejects an unauthenticated initialize with 401 (issue #44)', async function () {
                this.timeout(15000);
                const res = await rawInitialize(PORT);
                assert.strictEqual(res.status, 401, 'anonymous request must be rejected');
                assert.strictEqual(res.sessionId, null, 'no session is handed out to an anonymous client');
            });

            it('rejects wrong credentials with 401', async function () {
                this.timeout(15000);
                const res = await rawInitialize(PORT, { Authorization: basicAuth(AUTH_USER, 'wrong-password') });
                assert.strictEqual(res.status, 401, 'invalid password must be rejected');
            });

            it('keeps the /status health endpoint public', async function () {
                this.timeout(15000);
                const res = await fetch(`http://${HOST}:${PORT}/status`);
                assert.strictEqual(res.status, 200, 'status endpoint stays reachable without credentials');
                const body = (await res.json()) as { status?: string };
                assert.strictEqual(body.status, 'ok');
            });

            it('the MCP SDK client cannot connect without credentials', async function () {
                this.timeout(20000);
                await assert.rejects(connectClient(PORT), 'connecting without auth must fail');
            });

            it('accepts HTTP Basic auth and returns the requested state', async function () {
                this.timeout(20000);
                const auth = { Authorization: basicAuth(AUTH_USER, AUTH_PASS) };

                const init = await rawInitialize(PORT, auth);
                assert.strictEqual(init.status, 200, 'authenticated initialize succeeds');
                assert.ok(init.sessionId, 'a session id is issued to an authenticated client');

                const id = `${harness.adapterName}.0.info.connection`;
                const call = await rawToolCall(PORT, init.sessionId!, 'get_states', { ids: [id] }, auth);
                assert.strictEqual(call.status, 200, 'authenticated tool call succeeds');
                const payload = parseSseData(call.body);
                const tool = JSON.parse(payload.result.content[0].text);
                assert.strictEqual(tool.ok, true);
                assert.strictEqual(tool.data.states[0].value, true, 'authenticated client reads the state value');
            });

            it('issues a Bearer token via /oauth/token that authorizes the endpoint', async function () {
                this.timeout(20000);
                const tokenRes = await fetch(`http://${HOST}:${PORT}/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'password',
                        username: AUTH_USER,
                        password: AUTH_PASS,
                    }).toString(),
                });
                assert.strictEqual(tokenRes.status, 200, '/oauth/token issues a token for valid credentials');
                const token = (await tokenRes.json()) as { access_token?: string };
                assert.ok(token.access_token, 'response carries an access_token');

                const init = await rawInitialize(PORT, { Authorization: `Bearer ${token.access_token}` });
                assert.strictEqual(init.status, 200, 'the bearer token authorizes the MCP endpoint');
                assert.ok(init.sessionId, 'a session id is issued to the bearer-authenticated client');
            });
        });
    },
});
