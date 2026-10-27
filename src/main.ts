import { EXIT_CODES, Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { WebServer } from '@iobroker/webserver';
import express, { type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import McpServer, { createInProcessMcp, type McpConfig } from '@iobroker/mcp-server';

type Server = HttpServer | HttpsServer;

class Mcp extends Adapter {
    declare config: McpConfig;
    private readonly webServer: {
        mcpServer: McpServer | null;
        server: Server | null;
        app: Express | null;
    };
    /** Pending self-terminate timer used when running embedded in a web instance. */
    private terminateTimer?: ioBroker.Timeout;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'mcp',
            logTransporter: true,
            stateChange: (id, state) => this.webServer?.mcpServer?.stateChange(id, state),
            objectChange: (id, obj) => this.webServer?.mcpServer?.objectChange(id, obj),
            ready: () => this.main(),
            // js-controller calls only this option on stop, not a method `onUnload`
            unload: callback => this.onUnload(callback),
        });

        this.webServer = {
            app: null,
            server: null,
            mcpServer: null,
        };
    }

    onUnload(callback: () => void): void {
        try {
            if (this.terminateTimer) {
                this.clearTimeout(this.terminateTimer);
                this.terminateTimer = undefined;
            }
            void this.setState('info.connection', false, true);

            // Ends the MCP sessions, so the clients learn that the server is gone
            this.webServer.mcpServer?.unload();
            if (this.webServer.server) {
                this.log.info(`terminating http${this.config.secure ? 's' : ''} server on port ${this.config.port}`);
                // close() only stops accepting connections and waits for the open ones, e.g. the event
                // streams (GET /mcp) of connected clients, which stay open until the client disconnects
                this.webServer.server.close();
                this.webServer.server.closeAllConnections();
                this.webServer.server = null;
            }
        } catch (error) {
            this.log.error(`Cannot close server: ${error}`);
        }
        callback();
    }

    async initWebServer(): Promise<void> {
        this.config.port = parseInt(this.config.port as string, 10);

        this.webServer.app = express();

        // Standalone mode: we own the web server. Pass `null` as instanceSettings so the
        // McpServer runs in standalone mode (as a web extension the web adapter passes the
        // instance object here instead).
        this.webServer.mcpServer = new McpServer(this.webServer.server, this.config, this, null, this.webServer.app);

        if (this.config.port) {
            if (this.config.secure && !this.config.certificates) {
                return;
            }

            try {
                const webserver = new WebServer({
                    app: this.webServer.app,
                    adapter: this,
                    secure: this.config.secure,
                    http2: false,
                });

                this.webServer.server = await webserver.init();
            } catch (err) {
                this.log.error(`Cannot create webserver: ${err}`);
                this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
        } else {
            this.log.error('port missing');
            this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
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
                    this.terminate?.(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });

            this.getPort(
                this.config.port,
                !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined,
                port => {
                    if (port !== this.config.port) {
                        this.log.error(`port ${this.config.port} already in use`);
                        this.terminate?.(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                        return;
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
        if (this.config.webInstance) {
            console.log('Adapter runs as a part of web service');
            this.log.warn('Adapter runs as a part of web service');
            this.setForeignState(`system.adapter.${this.namespace}.alive`, false, true, () => {
                // Tracked timer so onUnload can cancel it; otherwise an early unload would
                // race with terminate() and leave a dangling timer behind.
                this.terminateTimer = this.setTimeout(
                    () => this.terminate(EXIT_CODES.ADAPTER_REQUESTED_TERMINATION),
                    1000,
                );
            });
        } else {
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
}

if (require.main !== module) {
    // Export the constructor in compact mode. Assigning `module.exports` replaces the exports object,
    // so every additional named export must be re-attached here (see `McpServer` / `createInProcessMcp`).
    module.exports = (options: Partial<AdapterOptions> | undefined) => new Mcp(options);
    module.exports.McpServer = McpServer;
    module.exports.createInProcessMcp = createInProcessMcp;
} else {
    // otherwise start the instance directly
    (() => new Mcp())();
}
