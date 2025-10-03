import type { Express, Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import os from 'node:os';
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

        this.app.post('/api/system_info', async (_req: Request, res: Response) => {
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
            } catch (error) {
                this.adapter.log.error(`Error getting system info: ${error}`);
                res.status(500).json({
                    ok: false,
                    error: 'Failed to get system information',
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
