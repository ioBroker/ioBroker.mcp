import express, { type Express, type Request, type Response, type NextFunction } from 'express';
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
        this.app.use(express.json());

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

        this.app.post('/api/get_logs', (req: Request, res: Response) => {
            try {
                const { level, from_ts, limit, adapter } = req.body;

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

    unload(): void {
        // Cleanup if needed
        this.adapter.log.info('MCP server unloading');
    }
}
