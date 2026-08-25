# CodeAtlas AI — Quick Setup Guide

This guide will help you get CodeAtlas AI up and running in minutes.

## Prerequisites

- **Node.js** v20.0.0 or higher
- **npm** or **pnpm** (recommended)
- **SQLite + sqlite-vec** (included; no external database server required)

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

Optional variables:
```
PORT=3381
CODEATLAS_API_KEY=your_api_key
NVIDIA_API_KEY=nvapi-your_nvidia_key
CODEATLAS_MULTI_TENANT=true
```

### 3. Initialize SQLite

SQLite + sqlite-vec is configured by default. No external database setup is required.

```bash
npm run db-init
```

### 4. Start the Server

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

The server will start at **http://localhost:3381**.

## AI Editor Integration

### Cursor / Windsurf

Add to `.cursor/mcp.json` or `mcp_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "url": "http://localhost:3381/sse"
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
pm2 start dist/src/index.js --name codeatlas-ai
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


**Q: Port already in use?**
A: Change the `PORT` environment variable or kill the existing process.

## Second Brain Hooks (Optional)

Claude Code can auto-load memory context and auto-save learnings via the brain hooks. See [AI-MEMORY-SETUP.md](./AI-MEMORY-SETUP.md) → **Second Brain Hooks (Claude Code)** for setup, verification, and uninstall instructions.
