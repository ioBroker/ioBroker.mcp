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
