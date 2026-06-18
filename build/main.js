"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const webserver_1 = require("@iobroker/webserver");
const express_1 = __importDefault(require("express"));
const mcp_server_1 = __importStar(require("@iobroker/mcp-server"));
class Mcp extends adapter_core_1.Adapter {
    webServer;
    /** Pending self-terminate timer used when running embedded in a web instance. */
    terminateTimer;
    constructor(options = {}) {
        super({
            ...options,
            name: 'mcp',
            logTransporter: true,
            stateChange: (id, state) => this.webServer?.mcpServer?.stateChange(id, state),
            objectChange: (id, obj) => this.webServer?.mcpServer?.objectChange(id, obj),
            ready: () => this.main(),
        });
        this.webServer = {
            app: null,
            server: null,
            mcpServer: null,
        };
    }
    onUnload(callback) {
        try {
            if (this.terminateTimer) {
                this.clearTimeout(this.terminateTimer);
                this.terminateTimer = undefined;
            }
            void this.setState('info.connection', false, true);
            this.log.info(`terminating http${this.config.secure ? 's' : ''} server on port ${this.config.port}`);
            if (this.webServer?.mcpServer) {
                this.webServer.mcpServer.unload();
                try {
                    if (this.webServer.server) {
                        this.webServer.server.close();
                        this.webServer.server = null;
                    }
                }
                catch (error) {
                    // ignore
                    console.error(`Cannot close server: ${error}`);
                }
                callback();
            }
            else {
                if (this.webServer?.server) {
                    this.webServer.server.close();
                    this.webServer.server = null;
                }
                callback();
            }
        }
        catch (error) {
            console.error(`Cannot close server: ${error}`);
            callback();
        }
    }
    async initWebServer() {
        this.config.port = parseInt(this.config.port, 10);
        this.webServer.app = (0, express_1.default)();
        // Standalone mode: we own the web server. Pass `null` as instanceSettings so the
        // McpServer runs in standalone mode (as a web extension the web adapter passes the
        // instance object here instead).
        this.webServer.mcpServer = new mcp_server_1.default(this.webServer.server, this.config, this, null, this.webServer.app);
        if (this.config.port) {
            if (this.config.secure && !this.config.certificates) {
                return;
            }
            try {
                const webserver = new webserver_1.WebServer({
                    app: this.webServer.app,
                    adapter: this,
                    secure: this.config.secure,
                });
                this.webServer.server = await webserver.init();
            }
            catch (err) {
                this.log.error(`Cannot create webserver: ${err}`);
                this.terminate(adapter_core_1.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
        }
        else {
            this.log.error('port missing');
            this.terminate(adapter_core_1.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
        }
        if (this.webServer.server) {
            let serverListening = false;
            let serverPort = this.config.port;
            this.webServer.server.on('error', e => {
                if (e.toString().includes('EACCES') && serverPort <= 1024) {
                    this.log.error(`node.js process has no rights to start server on the port ${serverPort}.\n` +
                        `Do you know that on linux you need special permissions for ports under 1024?\n` +
                        `You can call in shell following script to allow it for node.js: "iobroker fix"`);
                }
                else {
                    this.log.error(`Cannot start server on ${this.config.bind || '0.0.0.0'}:${serverPort}: ${e}`);
                }
                if (!serverListening) {
                    this.terminate?.(adapter_core_1.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });
            this.getPort(this.config.port, !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined, port => {
                if (port !== this.config.port) {
                    this.log.error(`port ${this.config.port} already in use`);
                    this.terminate?.(adapter_core_1.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                    return;
                }
                serverPort = port;
                this.webServer.server.listen(port, !this.config.bind || this.config.bind === '0.0.0.0' ? undefined : this.config.bind || undefined, async () => {
                    await this.setStateAsync('info.connection', true, true);
                    this.log.info(`http${this.config.secure ? 's' : ''} server listening on port ${port}`);
                    serverListening = true;
                });
            });
        }
    }
    main() {
        if (this.config.webInstance) {
            console.log('Adapter runs as a part of web service');
            this.log.warn('Adapter runs as a part of web service');
            this.setForeignState(`system.adapter.${this.namespace}.alive`, false, true, () => {
                // Tracked timer so onUnload can cancel it; otherwise an early unload would
                // race with terminate() and leave a dangling timer behind.
                this.terminateTimer = this.setTimeout(() => this.terminate(adapter_core_1.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION), 1000);
            });
        }
        else {
            if (this.config.secure) {
                // Load certificates
                this.getCertificates(undefined, undefined, undefined, (err, certificates, leConfig) => {
                    this.config.certificates = certificates;
                    this.config.leConfig = leConfig;
                    void this.initWebServer();
                });
            }
            else {
                void this.initWebServer();
            }
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode. Assigning `module.exports` replaces the exports object,
    // so every additional named export must be re-attached here (see `McpServer` / `createInProcessMcp`).
    module.exports = (options) => new Mcp(options);
    module.exports.McpServer = mcp_server_1.default;
    module.exports.createInProcessMcp = mcp_server_1.createInProcessMcp;
}
else {
    // otherwise start the instance directly
    (() => new Mcp())();
}
//# sourceMappingURL=main.js.map