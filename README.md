# ioBroker.mcp

MCP server for ioBroker

## Description

This adapter provides a simple web server for ioBroker that can be used as a basis for MCP (Model Context Protocol) server implementation.

## Features

- Configurable HTTP/HTTPS web server
- Configurable port and bind address
- Optional basic authentication
- Optional SSL/TLS support
- Simple REST API endpoints

## Configuration

The adapter can be configured through the ioBroker admin interface using JSONConfig:

### Server Configuration
- **Port**: The port on which the web server will listen (default: 8093)
- **Bind Address**: IP address to bind the server to (default: 0.0.0.0 for all interfaces)

### Authentication
- **Enable Authentication**: Enable basic authentication for the web server
- **Username**: Username for basic authentication
- **Password**: Password for basic authentication

### SSL/TLS Configuration
- **Enable HTTPS**: Enable HTTPS/SSL for secure connections
- **Public Certificate**: Path to the public certificate file
- **Private Key**: Path to the private key file
- **Chained Certificate**: Path to the chained certificate file (optional)

## API Endpoints

The server provides the following endpoints:

- `GET /` - Basic server information
- `GET /status` - Server status and uptime
- `GET /api/info` - Adapter information
- `GET /api/capabilities` - List of supported MCP capabilities

## Installation

```bash
npm install iobroker.mcp
```

Or install via ioBroker admin interface.

## Changelog

### 0.0.1 (2025-01-03)
- Initial release with basic web server functionality
- Configurable port, bind address, authentication, and SSL

## License

MIT License

Copyright (c) 2025 ioBroker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
