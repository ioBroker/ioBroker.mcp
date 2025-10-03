import { EXIT_CODES, Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { WebServer } from '@iobroker/webserver';
import express, { type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import McpServer from './lib/mcp-server';
import type { McpAdapterConfig } from './lib/types';

type Server = HttpServer | HttpsServer;

class Mcp extends Adapter {
    declare config: McpAdapterConfig;
    private readonly webServer: {
        mcpServer: McpServer | null;
        server: Server | null;
        app: Express | null;
    };

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'mcp',
            ready: () => this.main(),
        });

        this.webServer = {
            app: null,
            server: null,
            mcpServer: null,
        };
    }

    onUnload(callback: () => void): void {
        try {
            void this.setState('info.connection', false, true);

            this.log.info(`terminating http${this.config.secure ? 's' : ''} server on port ${this.config.port}`);
            if (this.webServer?.mcpServer) {
                this.webServer.mcpServer.unload();
                try {
                    if (this.webServer.server) {
                        this.webServer.server.close();
                        this.webServer.server = null;
                    }
                } catch (error) {
                    // ignore
                    console.error(`Cannot close server: ${error}`);
                }
                callback();
            } else {
                if (this.webServer?.server) {
                    this.webServer.server.close();
                    this.webServer.server = null;
                }
                callback();
            }
        } catch (error) {
            console.error(`Cannot close server: ${error}`);
            callback();
        }
    }

    async initWebServer(): Promise<void> {
        this.config.port = parseInt(this.config.port as string, 10);

        this.webServer.app = express();

        this.webServer.mcpServer = new McpServer(this.webServer.server!, this as any, this.webServer.app);

        if (this.config.port) {
            if (this.config.secure && !this.config.certificates) {
                return;
            }

            try {
                const webserver = new WebServer({
                    app: this.webServer.app,
                    adapter: this,
                    secure: this.config.secure,
                });

                this.webServer.server = await webserver.init();
            } catch (err) {
                this.log.error(`Cannot create webserver: ${err}`);
                this.terminate ? this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(1);
                return;
            }
        } else {
            this.log.error('port missing');
            process.exit(1);
        }

        if (this.webServer.server) {
            let serverListening = false;
            let serverPort = this.config.port;

            this.webServer.server.on('error', e => {
                if (e.toString().includes('EACCES') && serverPort <= 1024) {
                    this.log.error(
                        `node.js process has no rights to start server on the port ${serverPort}.\n` +
                            `Do you know that on linux you need special permissions for ports under 1024?\n` +
                            `You can call in shell following script to allow it for node.js: "iobroker fix"`,
                    );
                } else {
                    this.log.error(`Cannot start server on ${this.config.bind || '0.0.0.0'}:${serverPort}: ${e}`);
                }
                if (!serverListening) {
                    this.terminate ? this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(1);
                }
            });

            this.getPort(
                this.config.port,
                !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined,
                port => {
                    if (port !== this.config.port) {
                        this.log.error(`port ${this.config.port} already in use`);
                        process.exit(1);
                    }
                    serverPort = port;

                    this.webServer.server!.listen(
                        port,
                        !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined,
                        async () => {
                            await this.setStateAsync('info.connection', true, true);
                            this.log.info(`http${this.config.secure ? 's' : ''} server listening on port ${port}`);
                            serverListening = true;
                        },
                    );
                },
            );
        }
    }

    main(): void {
        if (this.config.secure) {
            // Load certificates
            this.getCertificates(
                undefined,
                undefined,
                undefined,
                (
                    err: Error | null | undefined,
                    certificates: ioBroker.Certificates | undefined,
                    leConfig: boolean | undefined,
                ): void => {
                    this.config.certificates = certificates;
                    this.config.leConfig = leConfig;
                    void this.initWebServer();
                },
            );
        } else {
            void this.initWebServer();
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
