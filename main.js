'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

const utils = require('@iobroker/adapter-core');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

class Mcp extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'mcp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.app = null;
        this.server = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize the adapter
        this.log.info('Starting MCP server adapter');

        // Create Express app
        this.app = express();

        // Basic middleware
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // Authentication middleware
        if (this.config.auth) {
            this.app.use((req, res, next) => {
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
        this.app.use((req, res, next) => {
            this.log.debug(`${req.method} ${req.url} from ${req.ip}`);
            next();
        });

        // Basic routes
        this.app.get('/', (req, res) => {
            res.json({
                name: 'ioBroker MCP Server',
                version: '0.0.1',
                status: 'running'
            });
        });

        this.app.get('/status', (req, res) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now()
            });
        });

        this.app.get('/api/info', (req, res) => {
            res.json({
                adapter: 'mcp',
                version: '0.0.1',
                secure: this.config.secure,
                auth: this.config.auth
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Not Found',
                path: req.url
            });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            this.log.error(`Server error: ${err.message}`);
            res.status(500).json({
                error: 'Internal Server Error',
                message: err.message
            });
        });

        // Start the server
        try {
            await this.startServer();
        } catch (err) {
            this.log.error(`Failed to start server: ${err.message}`);
        }
    }

    /**
     * Start HTTP or HTTPS server
     */
    async startServer() {
        const port = this.config.port || 8093;
        const bind = this.config.bind || '0.0.0.0';

        return new Promise((resolve, reject) => {
            if (this.config.secure) {
                // HTTPS server
                let options;
                try {
                    options = {
                        key: fs.readFileSync(this.config.certPrivate),
                        cert: fs.readFileSync(this.config.certPublic)
                    };

                    if (this.config.certChained) {
                        options.ca = fs.readFileSync(this.config.certChained);
                    }
                } catch (err) {
                    this.log.error(`Failed to read SSL certificates: ${err.message}`);
                    return reject(err);
                }

                this.server = https.createServer(options, this.app);
                this.server.listen(port, bind, () => {
                    this.log.info(`HTTPS server listening on https://${bind}:${port}`);
                    resolve();
                });
            } else {
                // HTTP server
                this.server = http.createServer(this.app);
                this.server.listen(port, bind, () => {
                    this.log.info(`HTTP server listening on http://${bind}:${port}`);
                    resolve();
                });
            }

            this.server.on('error', (err) => {
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
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.server) {
                this.server.close(() => {
                    this.log.info('Server closed');
                    callback();
                });
            } else {
                callback();
            }
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Mcp(options);
} else {
    // otherwise start the instance directly
    new Mcp();
}
