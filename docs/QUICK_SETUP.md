# CodeAtlas AI — Quick Setup Guide

This guide will help you get CodeAtlas AI up and running in minutes.

## Prerequisites

- **Node.js** v20.0.0 or higher
- **npm** or **pnpm** (recommended)
- **Oracle Instant Client** (optional — for Thick Mode database connectivity)

## Installation

### 1. Clone and Install

```bash
git clone https://github.com/giauphan/codeatlas-ai.git
cd codeatlas-ai
pnpm install
pnpm run build
```

### 2. Environment Configuration

Copy the example environment file and fill in your details:

```bash
cp .env.example .env
```

Required variables:
```
ORACLE_PASSWORD=your_oracle_password
ORACLE_CONN_STRING=your_oracle_connection_string
```

Optional variables:
```
PORT=8080
CODEATLAS_API_KEY=your_api_key
NVIDIA_API_KEY=nvapi-your_nvidia_key
CODEATLAS_MULTI_TENANT=true
```

### 3. Set Up Oracle Instant Client (if using Thick Mode)

Download [Oracle Instant Client](https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html) Basic Light package and extract it:

```bash
mkdir -p /opt/oracle
cd /opt/oracle
unzip instantclient-basiclite-linux.x64-21.16.0.0.0dbru.zip
# Set the library path
export LD_LIBRARY_PATH=/opt/oracle/instantclient_21_16:$LD_LIBRARY_PATH
```

### 4. Initialize Database

```bash
npm run db-init
```

### 5. Start the Server

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

The server will start at **http://localhost:8080**.

## AI Editor Integration

### Cursor / Windsurf

Add to `.cursor/mcp.json` or `mcp_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "url": "http://localhost:8080/sse"
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "node",
      "args": ["path/to/codeatlas-ai/dist/src/index.js"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Use the SSE endpoint directly via the MCP protocol.

## Running with PM2

```bash
npm install -g pm2
pm2 start dist/src/index.js --name codeatlas-enterprise
pm2 save
pm2 startup
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
node --experimental-test-coverage --import tsx --test tests/**/*.test.ts
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/sse` | GET | SSE endpoint for MCP |
| `/messages` | POST | Message endpoint for MCP |
| `/api/projects` | GET | List projects |
| `/api/projects/sync` | POST | Sync analysis data |
| `/api/analysis` | GET | Get analysis data |
| `/api/projects/settings` | GET/POST | Project settings |

## Troubleshooting

**Q: `ORA-12514` TNS listener error?**
A: Verify your `ORACLE_CONN_STRING` format: `host:port/service_name`

**Q: `LD_LIBRARY_PATH` not found?**
A: Ensure Oracle Instant Client is downloaded and `LD_LIBRARY_PATH` is set correctly.

**Q: Port already in use?**
A: Change the `PORT` environment variable or kill the existing process.
