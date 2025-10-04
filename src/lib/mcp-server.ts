import type { Express, Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import os from 'node:os';
import type { McpAdapter } from './types';
import { listDevices } from './devices-utils';

type Server = HttpServer | HttpsServer;

export default class McpServer {
    private adapter: McpAdapter;
    private server: Server;
    private app: Express;

    constructor(server: Server, adapter: McpAdapter, app: Express) {
        this.adapter = adapter;
        this.server = server;
        this.app = app;

        this.initRoutes();
    }

    private initRoutes(): void {
        // Add JSON body parser
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    try {
                        (req as any).body = JSON.parse(body);
                    } catch {
                        (req as any).body = {};
                    }
                    next();
                });
            } else {
                next();
            }
        });

        // Add request logging
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            this.adapter.log.debug(`${req.method} ${req.url} from ${req.ip}`);
            next();
        });

        // Basic routes
        this.app.get('/', (_req: Request, res: Response) => {
            res.json({
                name: 'ioBroker MCP Server',
                version: '0.0.1',
                status: 'running',
            });
        });

        this.app.get('/status', (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now(),
            });
        });

        this.app.get('/api/info', (_req: Request, res: Response) => {
            res.json({
                adapter: 'mcp',
                version: '0.0.1',
                secure: this.adapter.config.secure,
                auth: this.adapter.config.auth,
            });
        });

        this.app.get('/api/capabilities', (_req: Request, res: Response) => {
            res.json({
                server: 'iobroker-mcp',
                version: '1.0.0',
                capabilities: [
                    'list_devices',
                    'get_states',
                    'set_state',
                    'history_query',
                    'list_instances',
                    'list_hosts',
                    'get_logs',
                    'system_info',
                    'search_objects',
                    'list_rooms',
                    'list_functions',
                ],
            });
        });

        // RPC endpoint for method-based API calls
        this.app.post('/api/rpc', async (req: Request, res: Response) => {
            try {
                const { method, params } = (req as any).body;

                if (!method) {
                    res.status(400).json({
                        ok: false,
                        error: 'Method is required',
                    });
                    return;
                }

                if (method === 'get_states') {
                    await this.handleGetStates(params, res);
                } else if (method === 'get_logs') {
                    this.handleGetLogs(params, res);
                } else if (method === 'set_state') {
                    await this.handleSetState(params, res);
                } else if (method === 'system_info') {
                    await this.handleSystemInfo(params, res);
                } else if (method === 'search_objects') {
                    await this.handleSearchObjects(params, res);
                } else if (method === 'list_devices') {
                    await this.handleListDevices(params, res);
                } else {
                    res.status(400).json({
                        ok: false,
                        error: `Unknown method: ${method}`,
                    });
                }
            } catch (error: any) {
                this.adapter.log.error(`RPC error: ${error.message}`);
                res.status(500).json({
                    ok: false,
                    error: error.message,
                });
            }
        });

        // 404 handler
        this.app.use((req: Request, res: Response) => {
            res.status(404).json({
                error: 'Not Found',
                path: req.url,
            });
        });

        // Error handler
        this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
            this.adapter.log.error(`Server error: ${err.message}`);
            res.status(500).json({
                error: 'Internal Server Error',
                message: err.message,
            });
        });
    }

    private async handleGetStates(params: any, res: Response): Promise<void> {
        if (!params || !params.ids || !Array.isArray(params.ids)) {
            res.status(400).json({
                ok: false,
                error: 'Invalid params: ids array is required',
            });
            return;
        }

        const states = [];
        for (const id of params.ids) {
            try {
                const state = await this.adapter.getForeignStateAsync(id);
                if (state) {
                    const stateData: any = {
                        id: id,
                        value: state.val,
                        ack: state.ack,
                        ts: state.ts,
                    };
                    // Only include lc if it's different from ts
                    if (state.lc !== state.ts) {
                        stateData.lc = state.lc;
                    }
                    states.push(stateData);
                } else {
                    // State doesn't exist, but we can still include it with null value
                    states.push({
                        id: id,
                        value: null,
                        ack: false,
                        ts: Date.now(),
                    });
                }
            } catch (error: any) {
                this.adapter.log.error(`Error getting state ${id}: ${error.message}`);
                // Include the state with error info
                states.push({
                    id: id,
                    value: null,
                    ack: false,
                    ts: Date.now(),
                    error: error.message,
                });
            }
        }

        res.json({
            ok: true,
            data: {
                states: states,
            },
        });
    }

    private handleGetLogs(params: any, res: Response): void {
        try {
            const { level, from_ts, limit, adapter } = params || {};

            // Prepare the message for sendToHost
            const message: any = {
                data: {
                    size: limit || 200,
                },
            };

            // Add timestamp filter if provided
            if (from_ts !== undefined) {
                message.data.from_ts = from_ts;
            }

            // Add adapter filter if provided
            if (adapter !== undefined) {
                message.data.source = adapter;
            }

            // Use sendToHost to get logs from the host
            this.adapter.sendToHost(this.adapter.host || null, 'getLogs', message, (result: any) => {
                if (!result || result.error) {
                    res.status(500).json({
                        ok: false,
                        error: result?.error || 'Failed to retrieve logs',
                    });
                    return;
                }

                // Filter and format the logs
                let logs = result.list || [];

                // Filter by level if specified
                if (level && Array.isArray(level) && level.length > 0) {
                    logs = logs.filter((log: any) => level.includes(log.severity));
                }

                // Map to the required format
                const formattedLogs = logs.map((log: any) => ({
                    ts: log.ts,
                    level: log.severity,
                    source: log.from,
                    message: log.message,
                    host: this.adapter.host,
                }));

                res.json({
                    ok: true,
                    data: {
                        logs: formattedLogs,
                    },
                });
            });
        } catch (error: any) {
            this.adapter.log.error(`Error in get_logs: ${error.message}`);
            res.status(500).json({
                ok: false,
                error: error.message || 'Internal server error',
            });
        }
    }

    private async handleSetState(params: any, res: Response): Promise<void> {
        if (!params || !params.id) {
            res.status(400).json({
                ok: false,
                error: 'Missing required parameter: id',
            });
            return;
        }

        const { id, value, options } = params;
        const ack = options?.ack !== undefined ? options.ack : false;

        try {
            // Set the state using ioBroker adapter
            await this.adapter.setForeignStateAsync(id, value, ack);

            res.json({
                ok: true,
                data: {
                    id,
                    value,
                },
            });
        } catch (error: any) {
            this.adapter.log.error(`Error setting state: ${error.message}`);
            res.status(500).json({
                ok: false,
                error: 'Failed to set state',
                message: error.message,
            });
        }
    }

    private async handleSystemInfo(_params: any, res: Response): Promise<void> {
        try {
            // Get js-controller version
            const hostObj = await this.adapter.getForeignObjectAsync(`system.host.${this.adapter.host}`);
            const jsControllerVersion = hostObj?.common?.installedVersion || 'unknown';

            // Get hostname
            const hostname = os.hostname();

            // Get platform
            const platform = os.platform();

            // Get Node.js version
            const nodeVersion = process.version.substring(1); // Remove 'v' prefix

            // Get CPU load (1 minute average)
            const loadAvg = os.loadavg();
            const cpuLoad = loadAvg[0]; // 1 minute average

            // Get memory information
            const totalMem = Math.round(os.totalmem() / (1024 * 1024)); // Convert to MB
            const freeMem = Math.round(os.freemem() / (1024 * 1024)); // Convert to MB
            const usedMem = totalMem - freeMem;

            // Get system uptime in seconds
            const uptimeSec = Math.round(os.uptime());

            // Get number of instances
            const instanceObjs = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance');
            const instances = Object.keys(instanceObjs || {}).length;

            res.json({
                ok: true,
                data: {
                    js_controller: jsControllerVersion,
                    hostname,
                    platform,
                    node: nodeVersion,
                    cpu_load: parseFloat(cpuLoad.toFixed(2)),
                    mem: {
                        total_mb: totalMem,
                        used_mb: usedMem,
                    },
                    uptime_sec: uptimeSec,
                    instances,
                },
            });
        } catch (error: any) {
            this.adapter.log.error(`Error getting system info: ${error.message}`);
            res.status(500).json({
                ok: false,
                error: 'Failed to get system information',
            });
        }
    }

    private async handleSearchObjects(params: any, res: Response): Promise<void> {
        try {
            const query = params?.query || '';
            const role = params?.role;
            const room = params?.room;
            const limit = params?.limit || 100;

            // Get all objects of type 'state' and 'channel'
            const allObjects = await this.adapter.getForeignObjectsAsync('*', 'state');

            // Get room enums if room filter is specified
            let roomObjects: string[] = [];
            if (room) {
                const enums = await this.adapter.getForeignObjectsAsync('enum.rooms.*', 'enum');
                for (const [, enumObj] of Object.entries(enums || {})) {
                    if (
                        enumObj?.common?.name &&
                        (typeof enumObj.common.name === 'string'
                            ? enumObj.common.name.toLowerCase() === room.toLowerCase()
                            : Object.values(enumObj.common.name).some(
                                  (n: any) => typeof n === 'string' && n.toLowerCase() === room.toLowerCase(),
                              ))
                    ) {
                        roomObjects = enumObj.common?.members || [];
                        break;
                    }
                }
            }

            const results = [];
            for (const [id, obj] of Object.entries(allObjects || {})) {
                // Apply query filter (search in object ID)
                if (query && !id.toLowerCase().includes(query.toLowerCase())) {
                    continue;
                }

                // Apply role filter
                if (role && obj?.common?.role !== role) {
                    continue;
                }

                // Apply room filter
                if (room && !roomObjects.includes(id)) {
                    continue;
                }

                // Extract adapter name from object ID (e.g., "alias.0" from "alias.0.rooms.bedroom.temperature")
                const adapterMatch = id.match(/^([^.]+\.\d+)/);
                const adapter = adapterMatch ? adapterMatch[1] : '';

                results.push({
                    id: id,
                    type: obj?.type || 'state',
                    role: obj?.common?.role || '',
                    path: id,
                    adapter: adapter,
                });

                // Apply limit
                if (results.length >= limit) {
                    break;
                }
            }

            res.json({
                ok: true,
                data: {
                    results: results,
                },
            });
        } catch (error: any) {
            this.adapter.log.error(`Error searching objects: ${error.message}`);
            res.status(500).json({
                ok: false,
                error: 'Failed to search objects',
            });
        }
    }

    private async handleListDevices(params: any, res: Response): Promise<void> {
        try {
            const room = params?.room;
            const limit = params?.limit || 100;
            const offset = params?.offset || 0;

            const result = await listDevices(this.adapter, { room, limit, offset });

            res.json({
                ok: true,
                data: result,
            });
        } catch (error: any) {
            this.adapter.log.error(`Error listing devices: ${error.message}`);
            res.status(500).json({
                ok: false,
                error: 'Failed to list devices',
            });
        }
    }

    unload(): void {
        // Cleanup if needed
        this.adapter.log.info('MCP server unloading');
    }
}
