const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');

// The MCP SDK ships a CommonJS build (dist/cjs/**) so it can be required from these CommonJS test
// files; we drive the adapter with the real MCP client + Streamable HTTP transport.
//
// IMPORTANT: keep the exact specifiers below. `Client` uses the dedicated "./client" export. The
// transport has no dedicated export, so it resolves through the SDK's "./*" -> "./dist/cjs/*" map,
// which is a literal substitution. Node's "exports" resolution does NOT append ".js", so dropping
// the extension makes it look for ".../dist/cjs/client/streamableHttp" and fail with
// "Cannot find module". The ".js" suffix is therefore mandatory here.
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const HOST = '127.0.0.1';

/** Connect a fresh MCP client to the running adapter over the Streamable HTTP transport. */
async function connectClient(port) {
    const url = new URL(`http://${HOST}:${port}/mcp`);
    let lastError;
    // The adapter sets info.connection only inside the listen() callback, so the socket is ready
    // by then. A short retry still guards against any rare accept-race on slow CI machines.
    for (let attempt = 0; attempt < 5; attempt++) {
        const transport = new StreamableHTTPClientTransport(url);
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
function parseToolResult(result) {
    assert.ok(Array.isArray(result.content) && result.content.length > 0, 'tool result has a content array');
    const first = result.content[0];
    assert.strictEqual(first.type, 'text', 'tool result content is text');
    return JSON.parse(first.text);
}

/** Assert that every expected entry is present in the actual array. */
function assertIncludesAll(actual, expected, message) {
    for (const item of expected) {
        assert.ok(actual.includes(item), `${message}: expected to include "${item}" (got ${actual.join(', ')})`);
    }
}

// Run the standard ioBroker package & startup tests, then our MCP-specific integration tests.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        // --- All tools available: state & object writing enabled ----------------------------------
        suite('MCP server (write enabled)', getHarness => {
            const PORT = 18293;
            const TEST_STATE = '0_userdata.0.mcpIntegrationTest';
            let harness;
            let client;
            let transport;

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
                assert.strictEqual(info.name, 'iobroker-mcp');
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
                        'get_logs',
                        'system_info',
                        'search_objects',
                        'list_devices',
                        'history_query',
                        'list_instances',
                        'list_hosts',
                        'list_rooms',
                        'list_functions',
                        'get_object',
                        'read_file',
                        'write_log',
                        'set_object',
                        'write_file',
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
                const mcp = res.data.instances.find(i => i.id === `${harness.adapterName}.0`);
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
                const id = `system.adapter.${harness.adapterName}.0.info.connection`;
                const res = parseToolResult(await client.callTool({ name: 'get_states', arguments: { ids: [id] } }));
                assert.strictEqual(res.ok, true);
                const state = res.data.states[0];
                assert.strictEqual(state.id, id);
                assert.strictEqual(state.value, true, 'info.connection is true while server runs');
            });

            it('get_object reads the connection state object', async function () {
                this.timeout(15000);
                const id = `system.adapter.${harness.adapterName}.0.info.connection`;
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

            it('search_objects finds the created test state', async function () {
                this.timeout(15000);
                const res = parseToolResult(
                    await client.callTool({ name: 'search_objects', arguments: { query: 'mcpIntegrationTest' } }),
                );
                assert.strictEqual(res.ok, true);
                const ids = res.data.results.map(r => r.id);
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
                const id = `system.adapter.${harness.adapterName}.0.info.connection`;
                const res = await client.readResource({ uri: `iobstate://${id}` });
                const body = JSON.parse(res.contents[0].text);
                assert.strictEqual(body.id, id);
                assert.strictEqual(body.val, true);
            });

            it('exposes an iobobject resource that can be read', async function () {
                this.timeout(15000);
                const id = `system.adapter.${harness.adapterName}.0.info.connection`;
                const res = await client.readResource({ uri: `iobobject://${id}` });
                const body = JSON.parse(res.contents[0].text);
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
            let harness;
            let client;
            let transport;

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
                assertIncludesAll(names, ['get_states', 'get_object', 'search_objects', 'write_log'], 'read tools');

                // Mutating tools must be gated off.
                assert.ok(!names.includes('set_state'), 'set_state hidden when allowSetState=false');
                assert.ok(!names.includes('set_object'), 'set_object hidden when allowObjectChange=false');
                assert.ok(!names.includes('write_file'), 'write_file hidden when allowObjectChange=false');
            });

            it('still serves read tools', async function () {
                this.timeout(15000);
                const id = `system.adapter.${harness.adapterName}.0.info.connection`;
                const res = parseToolResult(await client.callTool({ name: 'get_states', arguments: { ids: [id] } }));
                assert.strictEqual(res.ok, true);
                assert.strictEqual(res.data.states[0].value, true);
            });
        });
    },
});
