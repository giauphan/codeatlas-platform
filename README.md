<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/CodeAtlas-00F0FF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjAgM0wzNyAxMEwxMCAyMEwzNyAzMEwyMCAzNyIgc3Ryb2tlPSIjMDBGMEZGIiBzdHJva2Utd2lkdGg9IjIiLz48cGF0aCBkPSJNMjAgMTBMMzAgMTVMMjAgMjVMMTAgMTV6IiBmaWxsPSIjMDBGMEZGIi8+PC9zdmc+">
    <img alt="CodeAtlas AI" src="https://img.shields.io/badge/CodeAtlas-00F0FF?style=for-the-badge">
  </picture>
</p>

<h1 align="center">🗺️ CodeAtlas AI</h1>

<p align="center">
  <strong>AI-Powered Codebase Intelligence Platform</strong><br>
  MCP Server · AST Code Analysis · Knowledge Graph · Oracle 26ai Memory
</p>

<p align="center">
  <a href="https://github.com/giauphan/codeatlas-ai/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#"><img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js" alt="Node.js 20+"></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript" alt="TypeScript 5.4"></a>
  <a href="https://www.oracle.com/database/"><img src="https://img.shields.io/badge/Oracle-26ai%20Native-red?logo=oracle" alt="Oracle 26ai"></a>
  <a href="https://www.npmjs.com/package/codeatlas-enterprise"><img src="https://img.shields.io/npm/v/codeatlas-enterprise?label=MCP%20Server&logo=npm" alt="MCP Server"></a>
  <a href="https://github.com/giauphan/codeatlas-ai/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/giauphan/codeatlas-ai/ci.yml?branch=main&logo=github" alt="CI"></a>
  <a href="#"><img src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite" alt="Vite 5"></a>
</p>

---

<p align="center">
  <b>CodeAtlas AI</b> transforms your codebase into a living <b>Knowledge Graph</b> — powered by <b>Oracle 26ai</b> vector search, property graphs, and AI embeddings. It provides deep architectural reasoning, automated security scanning, persistent AI memory, and seamless integration with every major AI code editor via the <b>Model Context Protocol (MCP)</b>.
</p>

---

## 📖 Table of Contents

- [✨ Features](#-features)
- [🏗️ Architecture](#️-architecture)
- [🚀 Quick Start](#-quick-start)
  - [Prerequisites](#1-prerequisites)
  - [Installation](#2-installation)
  - [Environment Configuration](#3-environment-configuration)
  - [Running the Server](#4-running-the-server)
- [🔌 AI Editor Integration](#-ai-editor-integration)
  - [Claude Desktop / Code](#claude-desktop--code)
  - [Cursor AI](#cursor-ai)
  - [VS Code (Cline / Continue)](#vs-code-cline--continue)
  - [Windsurf](#windsurf)
  - [Custom MCP Clients](#custom-mcp-clients)
- [🛠️ MCP Tools Reference](#️-mcp-tools-reference)
  - [Code Analysis & Discovery](#-code-analysis--discovery)
  - [Dependency & Flow Visualization](#-dependency--flow-visualization)
  - [AI Memory & Knowledge Graph](#-ai-memory--knowledge-graph)
  - [Security & Architecture Scanning](#-security--architecture-scanning)
- [🌐 REST API Reference](#-rest-api-reference)
- [📁 Project Structure](#-project-structure)
- [🧠 Memory Architecture](#-memory-architecture)
- [🏠 Multi-Tenant Architecture](#-multi-tenant-architecture)
- [📊 Dashboard](#-dashboard)
- [🧪 Testing](#-testing)
- [📄 License](#-license)
- [🤝 Contributing](#-contributing)

---

## ✨ Features

### 🏗️ Knowledge Graph Reasoning
- **Architectural Smell Detection** — Automatically detect circular dependencies, God objects, and dead code using Oracle 26ai SQL Property Graph queries (`GRAPH_TABLE` match recursion).
- **Tri-Layer Memory** — Episodic (business rules & change logs), Semantic (vector embeddings via NVIDIA NIM), and Relational (property graph) all stored natively in Oracle 26ai.
- **AI Vector Search** — Semantic code search using 4096-dimensional embeddings and `VECTOR_DISTANCE` cosine similarity.

### 🛡️ Security Scanner
- **Hardcoded Secrets Detection** — Identifies potential API keys, tokens, passwords, and credentials in variable declarations with intelligent false-positive suppression.
- **Unsafe Function Detection** — Flags dangerous calls (`eval`, `exec`, `system`, `child_process`, etc.) at CRITICAL severity.
- **SQL Injection Risk Analysis** — Detects dynamic query construction patterns with database context verification.
- **Enterprise Security Scoring** — Cross-project vulnerability scoring with risk-level classification (LOW / HIGH / CRITICAL).

### 🔍 AST Code Analysis
- **Multi-Language Support** — Analyzes **JavaScript/TypeScript**, **Python**, **PHP**, and more via AST parsing.
- **Entity Extraction** — Discovers modules, classes, functions, variables, and their relationships (imports, calls, containment, inheritance).
- **Smart Filtering** — Automatically excludes `node_modules`, `venv`, `.venv`, and `site-packages` for clean, actionable results.
- **Fuzzy Search** — Search entities by name with partial matching across entire projects.

### 🧠 AI Semantic Memory
- **Dreaming Memory System** — Persist learned patterns, mistakes, user preferences, and project knowledge as "dreams" with importance scoring (1–10).
- **NVIDIA NIM Embeddings** — Enterprise-grade vector embeddings via `nvidia/nv-embed-v1` for semantic code understanding.
- **Oracle 26ai Native Vectors** — Native `VECTOR(4096, FLOAT32)` data type for high-performance similarity search.
- **Auto-Synced Documentation** — Automatically sync business rules and change logs to the Oracle Knowledge Graph.

### 📊 Interactive Dashboard
- **Force-Directed Knowledge Graph** — Interactive SVG canvas with physics simulation, zoom/pan, node dragging, and glow effects.
- **Real-Time Analysis** — View project statistics, entity counts, and dependency metrics.
- **Glassmorphic UI** — Premium design system with frosted glass panels, neon cyan accents, and dark space theme.
- **Full-Screen Mode** — Immersive codebase visualization with native HTML5 Fullscreen API.

### 🔌 MCP Protocol Integration
- **Dual Transport** — Supports both **stdio** (local IDE integration) and **SSE** (remote server deployment) transports.
- **Dynamic Session Isolation** — Per-connection MCP server instances for zero-contention concurrent access.
- **Works With** — Claude Desktop/Code, Cursor AI, VS Code (Cline, Continue), Windsurf, and any MCP-compatible client.

### 🌐 REST API
- **Full HTTP API** — Express-based REST endpoints for project management, analysis, settings, dreams, and memory.
- **Rate Limiting** — Built-in per-tenant rate limiter (60 req/min) to protect against abuse.
- **CORS Support** — Configurable cross-origin policies for dashboard and remote access.

### 🏠 Multi-Tenant Support
- **Oracle VPD/RLS** — Row-level security using Oracle Virtual Private Database for complete tenant data isolation.
- **Firestore Isolation** — Tenant-scoped telemetry documents (`${tenantId}_${projectName}`) in Firebase.
- **Sandboxed Workspaces** — Each tenant operates within their own directory sandbox (`tenants/{tenantId}/`).

---

## 🏗️ Architecture

CodeAtlas AI follows a **Clean Architecture** pattern with clear separation of concerns:

```
┌──────────────────────────────────────────────────┐
│                   MCP Clients                     │
│  Claude  Cursor  VS Code  Windsurf  Custom CLI   │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│              Presentation Layer                    │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   MCP Server     │  │  Express HTTP API    │  │
│  │  (stdio / SSE)   │  │  (REST Endpoints)    │  │
│  │  mcpServer.ts    │  │  httpServer.ts       │  │
│  │  mcpTools.ts     │  │  dreamingRoutes.ts   │  │
│  └──────────────────┘  └──────────────────────┘  │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│               Service Layer                       │
│  ┌────────────┐ ┌──────────┐ ┌────────────────┐  │
│  │  Project   │ │ Memory   │ │  Security      │  │
│  │  Service   │ │ Service  │ │  Scanner       │  │
│  │            │ │          │ │                │  │
│  │ project    │ │ Oracle   │ │ Security       │  │
│  │ Service.ts │ │ Memory   │ │ Scanner.ts     │  │
│  │            │ │ Service  │ │                │  │
│  └────────────┘ │ .ts      │ │                │  │
│                  │          │ └────────────────┘  │
│  ┌────────────┐ │ ┌──────┐ │                     │
│  │ Dreaming   │ │ │Embed │ │                     │
│  │ Service    │ │ │-ding │ │                     │
│  │            │ │ │Service││                     │
│  │ dreaming  │ │ │.ts   ││                     │
│  │ Service.ts │ │ └──────┘ │                     │
│  └────────────┘ └──────────┘                     │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│              Infrastructure Layer                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Oracle   │ │ Firebase │ │ File System      │  │
│  │ 26ai DB  │ │ Admin    │ │ (codeatlas/       │  │
│  │          │ │          │ │  analysis.json)   │  │
│  │ .connect │ │ .auth    │ │                  │  │
│  │ .memory  │ │ .firestore│ │ projectService   │  │
│  │ .schema  │ │          │ │ .ts              │  │
│  └──────────┘ └──────────┘ └──────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Data Flow

```
1. User opens IDE (Claude / Cursor / VS Code)
2. IDE connects to CodeAtlas via MCP (stdio or SSE)
3. MCP tools query local .codeatlas/analysis.json AST data
4. sync_system_memory pushes embeddings & relationships to Oracle 26ai
5. Dashboard fetches analysis results via REST API
6. Security Scanner runs against analysis data for vulnerability detection
7. Knowledge Graph queries (Oracle Property Graph) identify architectural smells
```

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js**: v20.0.0 or higher
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **npm** (comes with Node.js) or **pnpm** (recommended)
  ```bash
  npm install -g pnpm
  ```
- **Oracle Instant Client** — Required for Thick Mode connectivity to Oracle 26ai. Download from [Oracle Instant Client Downloads](https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html) and extract to `/opt/oracle/instantclient`.
- **Firebase Project** — For API key authentication and telemetry storage.
- **NVIDIA API Key** — For embedding generation (sign up at [NVIDIA AI Foundation](https://build.nvidia.com/explore/discover)).

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/giauphan/codeatlas-ai.git
cd codeatlas-ai

# Install dependencies
pnpm install

# Build the TypeScript project
pnpm run build
```

### 3. Environment Configuration

Create a `.env` file in the project root:

```bash
# Server Configuration
PORT=8080
NODE_ENV=production
LOG_LEVEL=info

# Authentication
CODEATLAS_API_KEY=your_admin_secret_key
GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json

# Oracle 26ai Database (Thick Mode)
ORACLE_USER=admin
ORACLE_PASSWORD=your_password
ORACLE_CONN_STRING=your_db_connection_string
ORACLE_LIB_DIR=/opt/oracle/instantclient
ORACLE_WALLET_DIR=/opt/oracle/wallet   # For mTLS connections

# NVIDIA Embeddings
NVIDIA_API_KEY=nvapi-your-key-here

# Multi-Tenant (optional)
CODEATLAS_MULTI_TENANT=false
CODEATLAS_PROJECTS_ROOT=./tenants

# CORS (optional, defaults to localhost origins)
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

### 4. Running the Server

#### Development Mode (with hot reload)
```bash
pnpm run dev
```

#### Production Mode
```bash
pnpm run build
pnpm run start
```

#### PM2 (Production Process Manager)
```bash
npm install -g pm2
pm2 start dist/src/index.js --name codeatlas-ai
pm2 save
pm2 startup
```

#### Initialize Oracle Database Schema
```bash
pnpm run db-init
```

The server auto-detects the runtime mode:
- If `PORT` is set → starts in **SSE Mode** (remote HTTP server)
- If `PORT` is unset → starts in **Stdio Mode** (local MCP server for IDE integration)

---

## 🔌 AI Editor Integration

CodeAtlas AI works with any MCP-compatible AI coding assistant. Choose your editor below:

### Claude Desktop / Code

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "codeatlas-enterprise"],
      "env": {
        "CODEATLAS_API_KEY": "your-api-key",
        "ORACLE_CONN_STRING": "...",
        "NVIDIA_API_KEY": "nvapi-..."
      }
    }
  }
}
```

Or for remote SSE mode:

```json
{
  "mcpServers": {
    "codeatlas": {
      "type": "sse",
      "url": "https://your-server.com/sse?apiKey=YOUR_API_KEY_HERE"
    }
  }
}
```

### Cursor AI

Create `.cursor/rules/codeatlas.mdc` in your project:

```markdown
---
description: CodeAtlas AI codebase intelligence
globs: *
---
An MCP server named `codeatlas` is available with code analysis tools.
Always use it before manual file searches for faster results.
```

Configure in Cursor Settings → MCP Servers:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "codeatlas-enterprise"],
      "env": {
        "CODEATLAS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code (Cline / Continue)

Add to your VS Code MCP settings:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "codeatlas-enterprise"],
      "env": {
        "CODEATLAS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Windsurf

Create `.windsurfrules` in your project:

```markdown
Use CodeAtlas MCP tools for codebase analysis before making changes.
Tools: list_projects, get_project_structure, search_entities, get_dependencies,
generate_system_flow, trace_feature_flow, sync_system_memory
```

### Custom MCP Clients

Any MCP client can connect directly via stdio:

```bash
npx -y codeatlas-enterprise
```

Or via SSE:

```bash
curl -N https://your-server.com/sse?apiKey=YOUR_API_KEY
```

---

## 🛠️ MCP Tools Reference

CodeAtlas AI exposes **14 MCP tools** for comprehensive codebase intelligence. Run `list_projects` first to discover analyzed projects, then use the rest.

### 📂 Code Analysis & Discovery

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_projects` | List all analyzed projects with names, paths, and last analysis timestamps | _None_ |
| `get_project_structure` | Get all entities (modules, classes, functions, variables) in a project | `project`, `type` (all/module/class/function/variable), `limit` |
| `get_file_entities` | Get all entities defined in a specific file | `project`, `filePath` (partial match) |
| `search_entities` | Fuzzy search for functions, classes, modules, or variables by name | `project`, `query`, `type` |
| `get_insights` | AI-generated code quality insights (refactoring, security, maintainability) | _None_ |

### 🔗 Dependency & Flow Visualization

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_dependencies` | Get import/call/containment/implements relationships between entities | `project`, `source`, `target`, `relationship`, `limit` |
| `generate_system_flow` | Generate a **Mermaid flowchart** showing system architecture (module imports) | `project`, `scope` (full/modules-only/feature), `feature`, `maxNodes` |
| `generate_feature_flow_diagram` | Generate a **Mermaid diagram** of feature execution flow (call chains: entry point → controller → service → model → database) | `project`, `keyword`, `diagramType` (flowchart/sequence), `depth`, `maxNodes` |
| `trace_feature_flow` | Trace the complete execution flow of a feature through the codebase, ordered by dependency chain | `project`, `keyword`, `depth` |

### 🧠 AI Memory & Knowledge Graph

| Tool | Description | Parameters |
|------|-------------|------------|
| `sync_system_memory` | Sync code entities & relationships to Oracle 26ai Knowledge Graph. Creates auto-generated system documentation with business rules and change logs | `project`, `businessRule`, `changeDescription`, `enableEnterpriseSync` |
| `get_system_memory` | Retrieve episodic memories (business rules, change logs) from Oracle 26ai | `project`, `eventType` (all/BUSINESS_RULE/CHANGE_LOG) |
| `save_dream_memory` | Save a learned pattern, mistake, preference, or knowledge to the Dreaming Memory system | `memory_type`, `content`, `importance` (1–10), `session_id`, `project` |
| `query_dream_memories` | Search Dream Memories by semantic similarity using vector search | `query`, `project`, `limit` |
| `detect_architectural_smells` | Use Oracle 26ai Property Graph to detect circular dependencies, God objects, and dead code | `project` |

### 🛡️ Security & Architecture Scanning

| Tool | Description | Parameters |
|------|-------------|------------|
| `scan_enterprise_vulnerabilities` | Enterprise vulnerability scanner — auto-scans all projects for hardcoded secrets, unsafe functions, SQL injection risks, and architectural issues with security scoring | `maxProjects` |

---

## 🌐 REST API Reference

In addition to MCP, CodeAtlas AI provides a full REST API for remote access and dashboard integration.

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|:---:|
| `GET` | `/api/projects` | List all discovered projects | ✅ |
| `DELETE` | `/api/projects` | Remove a project and its data | ✅ |
| `GET` | `/api/projects/memory` | Get episodic memories for a project | ✅ |
| `GET` | `/api/projects/settings` | Get indexing settings | ✅ |
| `POST` | `/api/projects/settings` | Update indexing settings | ✅ |
| `POST` | `/api/dreams/save` | Save a dreaming memory | ✅ |
| `GET` | `/api/dreams/query` | Query dreaming memories | ✅ |
| `DELETE` | `/api/dreams/delete` | Delete a dreaming memory | ✅ |
| `GET` | `/api/docs/quick-setup` | Get quick setup guide (markdown) | ✅ |
| `GET` | `/api/docs/memory-setup` | Get AI memory setup guide (markdown) | ✅ |

**Authentication**: API requests require either:
- **Firebase ID Token**: `Authorization: Bearer <firebase-id-token>` (for dashboard users)
- **API Key**: `x-api-key: <your-api-key>` (for programmatic access)

**Rate Limiting**: 60 requests per minute per tenant/IP.

---

## 📁 Project Structure

```
codeatlas-ai/
├── src/
│   ├── index.ts                       # Composition root — entry point
│   ├── config/
│   │   └── env.ts                     # Environment configuration
│   ├── presentation/                   # Presentation layer (MCP + HTTP)
│   │   ├── mcpServer.ts               # MCP server instance
│   │   ├── mcpTools.ts                # All 14 MCP tool definitions
│   │   ├── httpServer.ts              # Express HTTP server + REST API
│   │   └── dreamingRoutes.ts          # Dream memory REST routes
│   ├── services/                       # Application services
│   │   ├── authService.ts             # Authentication & API key verification
│   │   ├── projectService.ts          # Project discovery & analysis loading
│   │   ├── memoryService.ts           # Oracle 26ai tri-layer memory service
│   │   ├── dreamingService.ts         # Oracle dreaming memory service
│   │   ├── embeddingService.ts        # NVIDIA NIM embedding generation
│   │   ├── memoryGenerator.ts         # Auto-generated memory documentation
│   │   └── scanner/
│   │       └── securityScanner.ts     # Static security vulnerability scanner
│   ├── middleware/
│   │   └── auth.ts                    # Express auth middleware (Firebase + API key)
│   ├── database/
│   │   ├── connection.ts              # Oracle DB connection pool (Thick Mode)
│   │   └── schema.sql                 # Oracle 26ai database schema + VPD setup
│   ├── types/
│   │   ├── index.ts                   # TypeScript interfaces (GraphNode, AnalysisResult, etc.)
│   │   └── express.d.ts              # Express type augmentation
│   ├── utils/
│   │   ├── logger.ts                  # Structured logging
│   │   └── context.ts                 # AsyncLocalStorage for request context
│   └── repositories.ts                # Repository pattern (auth, telemetry)
├── dashboard/                          # React dashboard (Vite + TypeScript)
│   ├── src/
│   │   ├── App.tsx                    # Root component
│   │   ├── main.tsx                   # Entry point
│   │   ├── lib/
│   │   │   └── firebase.ts           # Firebase client SDK
│   │   └── components/
│   │       ├── Dashboard.tsx          # Main dashboard (project management)
│   │       ├── Auth.tsx               # Login / API key auth
│   │       ├── KnowledgeGraphView.tsx # Interactive force-directed graph
│   │       ├── ControlCenterView.tsx  # Settings & controls
│   │       ├── CloudIndexView.tsx     # Cloud sync status
│   │       └── DocumentationView.tsx  # MCP integration guide
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── scripts/                            # Utility scripts
│   ├── db-init.ts                     # Database schema initialization
│   ├── deploy.sh                      # Deployment script
│   ├── migrate-user.ts                # User migration
│   └── query-firestore.ts             # Firestore debugging
├── tests/                              # Test suites
│   ├── unit/                          # Unit tests
│   ├── integration/                   # Integration tests
│   └── e2e/                           # End-to-end tests
├── docs/
│   ├── QUICK_SETUP.md                 # Quick setup guide
│   ├── AI-MEMORY-SETUP.md            # AI memory configuration
│   └── rules-template/               # IDE integration templates
│       ├── CLAUDE.md
│       ├── cursor-codeatlas.mdc
│       ├── codeatlas-mcp.md
│       └── windsurfrules.md
├── instantclient/                      # Oracle Instant Client libraries
├── .github/workflows/
│   ├── ci.yml                         # CI pipeline (build, type-check, test)
│   └── cd.yml                         # CD pipeline (deploy to live server)
├── package.json
├── tsconfig.json
├── DESIGN.md                           # Design system specification
├── CHANGELOG.md                        # Full version history
└── LICENSE                             # MIT License
```

---

## 🧠 Memory Architecture

CodeAtlas AI implements a **Tri-Layer Memory** system using Oracle 26ai native database features:

### 1. 📝 Episodic Memory (`ai_episodic_memory`)
Stores business events as JSON documents using Oracle's native `JSON` data type.
- **Business Rules** — Captured during code review (e.g., "VIP users get free shipping")
- **Change Logs** — Auto-recorded on every `sync_system_memory` call
- **Query**: `SELECT event_data FROM ai_episodic_memory WHERE project_name = :project AND event_type = 'BUSINESS_RULE'`

### 2. 🧬 Semantic Memory (`ai_semantic_memory`)
Stores vector embeddings of code entities for AI-powered similarity search.
- **Embedding Model**: `nvidia/nv-embed-v1` — 4096-dimensional FLOAT32 vectors
- **Storage**: Oracle native `VECTOR(4096, FLOAT32)` data type
- **Search**: `SELECT * FROM ai_semantic_memory ORDER BY VECTOR_DISTANCE(embedding, :query, COSINE) FETCH FIRST :limit ROWS ONLY`
- **Batch Processing**: Entities are embedded in chunks of 50, stored in DB batches of 500

### 3. 🔗 Relational Memory (`ai_relational_memory`)
Stores code dependency relationships as a Property Graph for graph traversal.
- **Knowledge Graph**: `CREATE PROPERTY GRAPH ai_knowledge_graph` connecting semantic entities via relational edges
- **Graph Queries**: `GRAPH_TABLE(ai_knowledge_graph MATCH (a)-[e]->{1,5}(a))` for cycle detection
- **Relationship Types**: `import`, `call`, `contains`, `implements`

### 🔐 Oracle VPD Multi-Tenant Security
All three memory tables are protected by Oracle Virtual Private Database (VPD) with automatic row-level security based on `tenant_id`. Each database connection session sets its security context via `ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId)`, and VPD policies transparently filter rows.

---

## 🏠 Multi-Tenant Architecture

CodeAtlas AI supports **SaaS multi-tenancy** at every layer:

### Directory Sandbox
```
tenants/
├── tenant-abc123/
│   ├── project-alpha/
│   │   └── .codeatlas/analysis.json
│   └── project-beta/
└── tenant-def456/
    └── project-gamma/
```

### Database Isolation
- **Oracle VPD/RLS**: Row-level security with automatic `tenant_id` filtering
- **Firestore Namespacing**: Documents prefixed as `${tenantId}_${projectName}`
- **Rate Limiting**: Per-tenant rate limits (60 req/min)

### Access Control
- **Standard users**: Can only see and manage projects within their tenant sandbox
- **System administrators**: Can view and manage all tenant projects
- **Authentication**: Firebase ID Tokens (dashboard) or API Keys (programmatic)

---

## 📊 Dashboard

The interactive dashboard is a React application with a premium **glassmorphism** design system:

### Design Specifications
- **Primary Color**: Neon Cyan `#00F0FF` — active nodes, CTAs, glow accents
- **Secondary**: Electric Violet `#9D00FF` — AI insights, relationships
- **Background**: Deep Space `#0A0C10` with glass surfaces `rgba(16, 20, 29, 0.6)`
- **Backdrop Blur**: 20px frosted glass
- **Typography**: Space Grotesk (headlines) + Inter (body)
- **Typography**: Space Grotesk (headlines) + Inter (body)

### Dashboard Views
| View | Description |
|------|-------------|
| **Control Center** | Project management, API keys, settings |
| **Knowledge Graph** | Interactive force-directed SVG graph with zoom, pan, and node dragging |
| **Cloud Index** | Cloud sync status, indexing coverage |
| **Documentation** | MCP integration guides and setup instructions |

### Building the Dashboard
```bash
cd dashboard
pnpm install
pnpm run build     # Production build
pnpm run dev       # Development server
```

---

## 🧪 Testing

CodeAtlas AI includes a comprehensive test suite with unit, integration, and e2e tests.

```bash
# Run all tests
pnpm test

# Run TypeScript type checking
npx tsc --noEmit --skipLibCheck

# Run dashboard tests
cd dashboard && pnpm test
```

### Test Structure
```
tests/
├── unit/
│   ├── scanner.test.ts                  # Security scanner logic
│   ├── repositories.test.ts            # Auth & telemetry repository
│   ├── dreaming-service.test.ts        # Dreaming service operations
│   ├── dreaming-routes.test.ts         # Dream memory REST endpoints
│   └── memory-generator.test.ts        # Memory documentation generator
├── integration/
│   ├── api.test.ts                     # REST API endpoints
│   ├── mcp.test.ts                     # MCP tool execution
│   ├── database.test.ts               # Oracle DB operations
│   ├── multi-tenant.test.ts           # Tenant isolation
│   ├── project-deletion.test.ts       # Project cleanup flow
│   ├── discovery.test.ts              # Project discovery
│   ├── settings.test.ts               # Indexing settings API
│   └── watcher.test.ts                # File watcher
└── e2e/
    └── scan-flow.test.ts               # End-to-end analysis flow
```

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Commit your changes**: `git commit -am 'Add my feature'`
4. **Push to the branch**: `git push origin feature/my-feature`
5. **Open a Pull Request**

### Development Guidelines
- Follow the existing **Clean Architecture** patterns
- Write **TypeScript** with strict typing
- Add **tests** for new features
- Update **documentation** as needed
- Ensure all tests pass: `pnpm test`

### Code Style
- TypeScript with strict mode enabled
- ESLint + Prettier for consistent formatting
- Clean Architecture with use case–driven service design
- Async/await over raw promises

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2026 GiauPhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
...
```

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/giauphan">GiauPhan</a><br>
  Powered by <a href="https://www.oracle.com/database/">Oracle 26ai</a> · <a href="https://www.nvidia.com/en-us/ai/">NVIDIA NIM</a> · <a href="https://firebase.google.com/">Firebase</a><br>
  <a href="https://github.com/giauphan/codeatlas-ai">GitHub</a> · <a href="https://www.npmjs.com/package/codeatlas-enterprise">npm</a> · <a href="https://github.com/giauphan/codeatlas-ai/issues">Issues</a>
</p>
