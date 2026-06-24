# CodeAtlas AI — Open Source Codebase Intelligence Platform

> **Turn any codebase into an explorable Knowledge Graph** — AI-powered architecture analysis, semantic search, and MCP server integration for developers.

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-6C5CE7)](https://modelcontextprotocol.io)
[![Oracle 26ai](https://img.shields.io/badge/Oracle-26ai%20Native-red?logo=oracle)](https://www.oracle.com/database/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ What is CodeAtlas AI?

**CodeAtlas AI** is an open-source, production-grade codebase intelligence platform. It analyzes your source code using **AST (Abstract Syntax Tree) parsing**, builds a **Knowledge Graph** of your architecture, and exposes everything through the **Model Context Protocol (MCP)** for AI assistants like Claude, Cursor, VS Code, and Windsurf.

### 🔍 Why CodeAtlas?

- **Understand any codebase in minutes** — not days
- **AI-native architecture** — works with your existing AI tools via MCP
- **Multi-language** — JavaScript, TypeScript, Python, PHP
- **Self-hosted** — your code never leaves your infrastructure
- **Enterprise-grade** — Oracle 26ai memory, security scanning, multi-tenant

---

## 🎯 Features

| Feature | Description |
|---------|-------------|
| 🏗️ **Knowledge Graph** | Visualize modules, classes, functions as an interactive graph |
| 🧠 **Semantic Memory** | AI remembers your codebase across sessions (Oracle 26ai) |
| 🔌 **MCP Protocol** | Connect Claude, Cursor, VS Code, Windsurf, Copilot |
| 🔍 **AST Analysis** | Deep parse of JS/TS, Python, PHP with dependency resolution |
| 🛡️ **Security Scanner** | Find hardcoded secrets, unsafe functions, SQL injection |
| 📊 **Interactive Dashboard** | Web UI for browsing projects and analysis |
| 🔐 **API Key Auth** | Secure access with cryptographic key hashing |
| 🏠 **Multi-Tenant** | Isolate projects by tenant with sandbox boundaries |
| ⚡ **Real-time Watching** | Auto re-index on file changes |
| 🔄 **Firebase Telemetry** | Optional cloud sync for usage analytics |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v20.0.0+
- **pnpm** (recommended) or npm
- **Oracle Instant Client** (optional, for Thick Mode DB access)

### 1. Install

```bash
git clone https://github.com/giauphan/codeatlas-ai.git
cd codeatlas-ai
pnpm install
pnpm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your settings
```

### 3. Run

```bash
# Development
pnpm run dev

# Production
pnpm start
```

Server starts at **http://localhost:8080**.

### 4. Connect your AI Editor

See [AI Editor Integration](#-ai-editor-integration) below.

---

## 🔌 AI Editor Integration

### Cursor / Windsurf

Add to `.cursor/mcp.json`:

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

Configure via MCP settings to point at the SSE endpoint.

---

## 🛠️ MCP Tools Reference

### Code Analysis
| Tool | Description |
|------|-------------|
| `list_projects` | List all managed projects |
| `get_project_structure` | Get entities (modules, classes, functions, variables) |
| `generate_system_flow` | Generate Mermaid architecture flow diagrams |
| `generate_feature_flow_diagram` | Generate Mermaid execution flow diagrams |
| `trace_feature_flow` | Trace complete feature call chain |

### Code Search
| Tool | Description |
|------|-------------|
| `code_search` | Search source file contents |
| `search_entities` | Search functions, classes, modules by name |
| `get_callers` | Find what calls a function (reverse dependencies) |
| `get_callees` | Find what a function calls (forward dependencies) |
| `impact_analysis` | Full blast radius for changes |

### Knowledge & Memory
| Tool | Description |
|------|-------------|
| `detect_architectural_smells` | Find circular deps, God objects, dead code |
| `get_system_memory` | Retrieve business rules and change logs |
| `sync_system_memory` | Save business rules and changes |
| `query_dream_memories` | Semantic search across past AI memories |
| `save_dream_memory` | Save persistent AI memories |

### Security
| Tool | Description |
|------|-------------|
| `scan_enterprise_vulnerabilities` | Scan all projects for secrets, unsafe code, SQLi |

---

## 🏗️ Architecture

```
                   ┌─────────────────────────┐
                   │   AI Editor (Cursor,     │
                   │   Claude, VS Code, etc)  │
                   └────────┬────────────────┘
                            │ MCP Protocol (SSE)
                   ┌────────▼────────────────┐
                   │   CodeAtlas MCP Server   │
                   │   (Express + MCP SDK)    │
                   └────────┬────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
   ┌──────────┐    ┌──────────────┐   ┌──────────────┐
   │   AST     │    │   Oracle 26ai │   │   Firebase   │
   │  Parser   │    │   Knowledge   │   │   Telemetry  │
   │ (JS/PY/   │    │   Graph +     │   │   (optional) │
   │   PHP)    │    │   Memory      │   │              │
   └──────────┘    └──────────────┘   └──────────────┘
```

---

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run with experimental coverage
node --experimental-test-coverage --import tsx --test tests/**/*.test.ts
```

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- 🐛 Found a bug? [Open an issue](https://github.com/giauphan/codeatlas-ai/issues)
- 💡 Have an idea? [Start a discussion](https://github.com/giauphan/codeatlas-ai/discussions)
- 🔒 Found a security issue? See [SECURITY.md](SECURITY.md)

---

## 📄 License

[MIT](LICENSE) © 2026 Giau Phan

---

## 🔗 Related Projects

- [CodeAtlas MCP Enterprise](https://github.com/giauphan/codeatlas-mcp-enterprise) — Lightweight local-first MCP client
- [CodeAtlas on npm](https://www.npmjs.com/package/codeatlas-enterprise) — Install via npm
