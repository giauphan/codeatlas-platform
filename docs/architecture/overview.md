# CodeAtlas Platform — Architecture Overview

## Repositories

| Repo | Role |
|---|---|
| **codeatlas-platform** | Central API server (Express + MCP SSE) with Oracle 26ai, Firebase, NVIDIA embeddings |
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
│  database/connection.ts  Oracle 26ai      │
│  Firebase Admin SDK  NVIDIA NIM API       │
└──────────────────────────────────────────┘
```

## Key Services

| Service | Purpose | External Deps |
|---|---|---|
| `dreamingService` | Dream memory CRUD + Oracle queries | Oracle 26ai |
| `consolidationEngine` | Knowledge graph consolidation | Oracle |
| `secondBrainService` | Second Brain memory store | Oracle |
| `genomeService` | Immune system gene store | Oracle |
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
│  (AST, graphs, search) │  HTTP  │   (API + Oracle + AI)   │
└──────────────────────┘        └────┬───────┬─────┬──────┘
                                     │       │     │
                              ┌──────▼┐ ┌───▼──┐ ┌▼──────┐
                              │Oracle │ │Fire- │ │NVIDIA │
                              │ 26ai  │ │base  │ │ NIM   │
                              └───────┘ └──────┘ └───────┘
```
