# CodeAtlas Platform — Architecture Overview

## Repositories

| Repo | Role |
|---|---|
| **codeatlas-platform** | Central API server (Express + MCP SSE) with SQLite + sqlite-vec, Firebase, NVIDIA embeddings |
| **codeatlas-mcp-server** | Local-first MCP server for codebase intelligence — AST analysis, dependency graphs, semantic search |

## Platform Architecture Layers

```
┌──────────────────────────────────────────┐
│  Presentation Layer                       │
│  httpServer.ts  mcpTools.ts  mcpServer.ts │
│  dreamingRoutes  cronSettingsRoute        │
│  consolidationRoutes  genomeRoutes        │
│  secondBrainRoutes  a2a/                  │
├──────────────────────────────────────────┤
│  Service Layer                            │
│  dreamingService  consolidationEngine     │
│  secondBrainService  genomeService        │
│  projectService  embeddingService         │
│  memoryService  authService               │
│  scanner/securityScanner                  │
├──────────────────────────────────────────┤
│  Data Layer                               │
│  database/connection.ts  SQLite + sqlite-vec      │
│  Firebase Admin SDK  NVIDIA NIM API       │
└──────────────────────────────────────────┘
```

## Key Services

| Service | Purpose | External Deps |
|---|---|---|
| `dreamingService` | Dream memory CRUD + SQLite queries | SQLite + sqlite-vec |
| `consolidationEngine` | Knowledge graph consolidation | SQLite + sqlite-vec |
| `secondBrainService` | Second Brain memory store | SQLite + sqlite-vec |
| `genomeService` | Immune system gene store | SQLite + sqlite-vec |
| `embeddingService` | NVIDIA vector embeddings | NVIDIA NIM API |
| `authService` | Firebase auth + API key validation | Firebase |
| `projectService` | Multi-tenant project management | FS |
| `securityScanner` | Vulnerability scanning | — |
| `a2aClientService` | Agent-to-Agent protocol client | — |
| `memoryGenerator` | Dream auto-generation | Firebase |

## External Integrations

```
                                     ┌──────────────┐
                                     │   AI IDEs    │
                                     │  (Cursor,    │
                                     │   Claude,    │
                                     │   Continue)  │
                                     └──────┬───────┘
                                            │ MCP (stdio/SSE)
┌──────────────────────┐        ┌───────────▼──────────────┐
│  codeatlas-mcp-server │◄──────►│   codeatlas-platform    │
│  (AST, graphs, search) │  HTTP  │   (API + SQLite + AI)   │
└──────────────────────┘        └────┬───────┬─────┬──────┘
                                     │       │     │
                              ┌──────▼┐ ┌───▼──┐ ┌▼──────┐
                              │SQLite │ │Fire- │ │NVIDIA │
                              │sqlite-│ │base  │ │ NIM   │
                              │ vec   │ │      │ │       │
                              └───────┘ └──────┘ └───────┘
```
