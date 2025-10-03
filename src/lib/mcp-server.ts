import type { Express, Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { McpAdapter } from './types';

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
                } else if (method === 'list_adapters') {
                    await this.handleListAdapters(params, res);
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

    private async handleListAdapters(params: any, res: Response): Promise<void> {
        try {
            // Get all adapter instances
            const objects = await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance');

            const adapters = [];
            for (const [id, obj] of Object.entries(objects)) {
                if (!obj || obj.type !== 'instance') {
                    continue;
                }

                // Get the instance state to check if it's alive
                const aliveId = `${id}.alive`;
                const connectedId = `${id}.connected`;
                const uptimeId = `${id}.uptime`;

                const [aliveState, connectedState, uptimeState] = await Promise.all([
                    this.adapter.getForeignStateAsync(aliveId).catch(() => null),
                    this.adapter.getForeignStateAsync(connectedId).catch(() => null),
                    this.adapter.getForeignStateAsync(uptimeId).catch(() => null),
                ]);

                // Extract adapter name and instance number from id (e.g., "system.adapter.zigbee.0" -> "zigbee.0")
                const instanceId = id.replace('system.adapter.', '');

                adapters.push({
                    id: instanceId,
                    name: obj.common.name,
                    version: obj.common.version || '0.0.0',
                    enabled: obj.common.enabled === true,
                    alive: aliveState?.val === true,
                    connected: connectedState?.val === true,
                    uptime: typeof uptimeState?.val === 'number' ? uptimeState.val : 0,
                    loglevel: obj.common.loglevel || 'info',
                });
            }

            res.json({
                ok: true,
                data: {
                    adapters,
                },
            });
        } catch (error) {
            this.adapter.log.error(`Error getting adapters: ${error}`);
            res.status(500).json({
                ok: false,
                error: 'Internal Server Error',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    unload(): void {
        // Cleanup if needed
        this.adapter.log.info('MCP server unloading');
    }
}
