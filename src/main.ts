import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';

type Server = HttpServer | HttpsServer;

interface McpAdapterConfig extends ioBroker.AdapterConfig {
    port: number;
    bind: string;
    auth: boolean;
    username: string;
    password: string;
    secure: boolean;
    certPublic: string;
    certPrivate: string;
    certChained: string;
}

class Mcp extends Adapter {
    declare config: McpAdapterConfig;
    private app: Express | null = null;
    private server: Server | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'mcp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Initialize the adapter
        this.log.info('Starting MCP server adapter');

        // Create Express app
        this.app = express();

        // Basic middleware
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // Authentication middleware
        if (this.config.auth) {
            this.app.use((req: Request, res: Response, next: NextFunction) => {
                const auth = req.headers.authorization;

                if (!auth) {
                    res.setHeader('WWW-Authenticate', 'Basic realm="MCP Server"');
                    return res.status(401).send('Authentication required');
                }

                const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
                const username = credentials[0];
                const password = credentials[1];

                if (username === this.config.username && password === this.config.password) {
                    next();
                } else {
                    res.setHeader('WWW-Authenticate', 'Basic realm="MCP Server"');
                    return res.status(401).send('Invalid credentials');
                }
            });
        }

        // Add request logging
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            this.log.debug(`${req.method} ${req.url} from ${req.ip}`);
            next();
        });

        // Basic routes
        this.app.get('/', (req: Request, res: Response) => {
            res.json({
                name: 'ioBroker MCP Server',
                version: '0.0.1',
                status: 'running',
            });
        });

        this.app.get('/status', (req: Request, res: Response) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now(),
            });
        });

        this.app.get('/api/info', (req: Request, res: Response) => {
            res.json({
                adapter: 'mcp',
                version: '0.0.1',
                secure: this.config.secure,
                auth: this.config.auth,
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
            this.log.error(`Server error: ${err.message}`);
            res.status(500).json({
                error: 'Internal Server Error',
                message: err.message,
            });
        });

        // Start the server
        try {
            await this.startServer();
        } catch (err) {
            this.log.error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Start HTTP or HTTPS server
     */
    private async startServer(): Promise<void> {
        const port = this.config.port || 8093;
        const bind = this.config.bind || '0.0.0.0';

        return new Promise((resolve, reject) => {
            if (this.config.secure) {
                // HTTPS server
                let options: { key: Buffer; cert: Buffer; ca?: Buffer };
                try {
                    options = {
                        key: readFileSync(this.config.certPrivate),
                        cert: readFileSync(this.config.certPublic),
                    };

                    if (this.config.certChained) {
                        options.ca = readFileSync(this.config.certChained);
                    }
                } catch (err) {
                    this.log.error(
                        `Failed to read SSL certificates: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    return reject(new Error(err instanceof Error ? err.message : String(err)));
                }

                this.server = createHttpsServer(options, this.app!);
                this.server.listen(port, bind, () => {
                    this.log.info(`HTTPS server listening on https://${bind}:${port}`);
                    resolve();
                });
            } else {
                // HTTP server
                this.server = createHttpServer(this.app!);
                this.server.listen(port, bind, () => {
                    this.log.info(`HTTP server listening on http://${bind}:${port}`);
                    resolve();
                });
            }

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    this.log.error(`Port ${port} is already in use`);
                } else {
                    this.log.error(`Server error: ${err.message}`);
                }
                reject(err);
            });
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            if (this.server) {
                this.server.close(() => {
                    this.log.info('Server closed');
                    callback();
                });
            } else {
                callback();
            }
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new Mcp(options);
} else {
    // otherwise start the instance directly
    (() => new Mcp())();
}
