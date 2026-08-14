# CodeAtlas Platform

[![CI](https://github.com/giauphan/codeatlas-platform/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giauphan/codeatlas-platform/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codeatlas-ai.svg)](https://www.npmjs.com/package/codeatlas-ai)
[![GitHub release](https://img.shields.io/github/v/release/giauphan/codeatlas-platform)](https://github.com/giauphan/codeatlas-platform/releases)

AI-powered codebase intelligence platform — MCP Server, AST analysis, Knowledge Graph, and semantic memory with Oracle 26ai.

Ship a secure, multi-tenant codebase intelligence backend without rebuilding authentication, MCP tooling, semantic memory, and knowledge graph infrastructure from scratch. CodeAtlas Platform is an open-source foundation for developers who want a clear starting point for AI-native code analysis services.

> [!IMPORTANT]
> This repository is a foundation, not a substitute for a threat model. Review [Known limitations](#known-limitations) and adapt the defaults to your infrastructure before serving production traffic.

## Why this platform?

| Concern | Included foundation |
| --- | --- |
| **MCP Server** | 30+ tools via stdio or SSE transport (Claude, Cursor, VSCode) |
| **Semantic memory** | Dream memory store with Oracle 26ai vector search |
| **Knowledge graph** | Genome DNA + immune system patterns, consolidation engine |
| **Multi-tenant** | Tenant isolation via `authStorage.run` + Firebase auth |
| **AST analysis** | TypeScript/Python/JS parsing via `@typescript-eslint/typescript-estree` and `py-ast` |
| **Security scanner** | Enterprise vulnerability scanning built-in |
| **A2A protocol** | Agent-to-agent orchestration with registry |
| **Dashboard** | React + Vite management UI for API keys and projects |

## Architecture

```
AI IDE (Claude/Cursor) → MCP (stdio/SSE) → Platform :3381 → Oracle 26ai + Firebase + NVIDIA
```

| Layer | Components |
|---|---|
| **Presentation** | Express HTTP, MCP SSE, A2A Agent Protocol, REST API |
| **Services** | Dream Memory, Genome DNA, Second Brain, Consolidation Engine, Security Scanner |
| **Data** | Oracle 26ai Autonomous DB, Firebase Firestore, NVIDIA NIM embeddings |

### Architecture diagrams

| Diagram | File |
|---|---|
| System architecture | [`diagrams/system.mmd`](docs/diagrams/system.mmd) |
| Second Brain flow | [`diagrams/second-brain.mmd`](docs/diagrams/second-brain.mmd) |
| Dream lifecycle | [`diagrams/dreams.mmd`](docs/diagrams/dreams.mmd) |
| Genome + Immune system | [`diagrams/genome.mmd`](docs/diagrams/genome.mmd) |
| MCP architecture | [`architecture/mcp.md`](docs/architecture/mcp.md) |
| Deployment | [`diagrams/deployment.mmd`](docs/diagrams/deployment.mmd) |
| A2A + Sync | [`diagrams/a2a-sync.mmd`](docs/diagrams/a2a-sync.mmd) |

## Quick start

### Requirements

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@9 --activate`)
- Oracle 26ai (Autonomous Database or self-hosted)
- Firebase service account (for multi-tenant auth)
- NVIDIA NIM API key (for embeddings)

### 1. Clone and install

```bash
git clone https://github.com/giauphan/codeatlas-platform.git
cd codeatlas-platform
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Oracle, Firebase, and NVIDIA credentials
```

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) or [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full env var reference.

### 3. Build

```bash
pnpm run build
```

### 4. Initialize database

```bash
pnpm run db-init
```

### 5. Start the server

```bash
# Production mode (SSE on :3381)
PORT=3381 pnpm start

# Development mode (hot reload)
pnpm run dev

# Stdio mode (for Claude Desktop — leave PORT unset)
pnpm start
```

Server runs at `http://localhost:3381`. Health check: `GET /health`.

## MCP integration

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "codeatlas-ai"],
      "env": {
        "CODEATLAS_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Cursor / VSCode (SSE)

```json
{
  "mcpServers": {
    "codeatlas": {
      "url": "http://localhost:3381/sse"
    }
  }
}
```

See [`docs/API_EXAMPLES.md`](docs/API_EXAMPLES.md) for full curl flows and transport modes.

## MCP tools (30+)

| Category | Tools |
|---|---|
| Dreams | `save_dream_memory`, `query_dream_memories`, `sync_dreams` |
| Genome | `search_genome`, `save_genome`, `scan_immune` |
| Skills | `search_skills`, `get_skill`, `install_skill` |
| Scanner | `scan_enterprise_vulnerabilities` |
| Code | `code_search`, `search_files`, `read_file` |
| Projects | `list_projects`, `get_project_structure`, `get_dependencies` |
| Architecture | `generate_system_flow`, `generate_feature_flow_diagram`, `trace_feature_flow` |

Full tool reference: [`docs/architecture/mcp.md`](docs/architecture/mcp.md).

## Documentation

| Guide | Purpose |
|---|---|
| [Development](docs/DEVELOPMENT.md) | Local dev setup, env vars, troubleshooting |
| [Deployment](docs/DEPLOYMENT.md) | PM2, systemd, Nginx TLS reverse proxy |
| [API examples](docs/API_EXAMPLES.md) | curl flows, MCP configs, REST endpoints |
| [Architecture overview](docs/architecture/overview.md) | Layers, services, integrations |
| [MCP architecture](docs/architecture/mcp.md) | Tool registration, transports, request flow |
| [Quick setup](docs/QUICK_SETUP.md) | Legacy condensed guide |

## Known limitations

- **Oracle dependency**: Requires Oracle 26ai with VECTOR support. Not portable to PostgreSQL/MySQL without migration.
- **Firebase auth**: Multi-tenant mode requires Firebase Admin SDK + service account. API-key-only mode supported for single-tenant.
- **NVIDIA embeddings**: Vector search depends on NVIDIA NIM API. Without `NVIDIA_API_KEY`, queries fall back to date-ordered results.
- **Local indexing**: Pure cloud deployments cannot index local code — run the `codeatlas-enterprise` client locally to sync AST data.
- **Oracle Instant Client**: Thick mode requires downloading Oracle Instant Client separately (not bundled due to license).
- **Dashboard**: Management UI ships separately in `dashboard/` — build and deploy independently.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Bug reports, documentation fixes, tests, and focused feature contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then look for issues labeled `good first issue` or `help wanted`.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

Distributed under the [MIT License](LICENSE). Maintained by [@giauphan](https://github.com/giauphan).
