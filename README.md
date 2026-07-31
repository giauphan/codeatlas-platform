# CodeAtlas Platform

AI-powered codebase intelligence platform — MCP Server, AST analysis, Knowledge Graph, and semantic memory with Oracle 26ai.

## 🏗 Architecture

```
AI IDE (Claude/Cursor) → MCP (stdio/SSE) → Platform :8080 → Oracle 26ai + Firebase + NVIDIA
```

| Layer | Components |
|---|---|
| **Presentation** | Express HTTP, MCP SSE, A2A Agent Protocol, REST API |
| **Services** | Dream Memory, Genome DNA, Second Brain, Consolidation Engine, Security Scanner |
| **Data** | Oracle 26ai Autonomous DB, Firebase Firestore, NVIDIA NIM embeddings |

## 📊 Architecture Diagrams

| Diagram | File |
|---|---|
| System Architecture | [`diagrams/system.mmd`](docs/diagrams/system.mmd) |
| Second Brain Flow | [`diagrams/second-brain.mmd`](docs/diagrams/second-brain.mmd) |
| Dream Lifecycle | [`diagrams/dreams.mmd`](docs/diagrams/dreams.mmd) |
| Genome + Immune System | [`diagrams/genome.mmd`](docs/diagrams/genome.mmd) |
| MCP Architecture | [`architecture/mcp.md`](docs/architecture/mcp.md) |
| Deployment | [`diagrams/deployment.mmd`](docs/diagrams/deployment.mmd) |
| A2A + Sync | [`diagrams/a2a-sync.mmd`](docs/diagrams/a2a-sync.mmd) |

## 🧠 Second Brain

- **Dream Memories** — AI thought persistence with vector search
- **Genome DNA** — Immune system patterns + prevention context
- **Skills Registry** — Reusable agent skills with versioning
- **Consolidation Engine** — Knowledge graph dedup + merging

## 🔧 Quick Start

```bash
cp .env.example .env  # Configure Oracle, Firebase, NVIDIA keys
pnpm install
pnpm run build
cd dashboard && pnpm run build && cd ..
PORT=8080 node dist/src/index.js
```

## 📡 MCP Tools (30+)

| Category | Tools |
|---|---|
| Dreams | `save_dream_memory`, `query_dream_memories`, `sync_dreams` |
| Genome | `search_genome`, `save_genome`, `scan_immune` |
| Skills | `search_skills`, `get_skill`, `install_skill` |
| Scanner | `scan_enterprise_vulnerabilities` |
| Code | `code_search`, `search_files`, `read_file` |

## 📄 Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [MCP Architecture](docs/architecture/mcp.md)
