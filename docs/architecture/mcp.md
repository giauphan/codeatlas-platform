# MCP Architecture

## Tool Registration

CodeAtlas Platform registers tools via the MCP SDK:

```typescript
// mcpTools.ts — 30+ MCP tools registered
server.tool("save_dream_memory", "Save memory...", schema, async ({ content, ... }) => {
  await DreamingService.saveDreamMemory(...);
});

server.tool("query_dream_memories", "Search memories", schema, async ({ query, ... }) => {
  return await DreamingService.queryDreamMemories(...);
});

server.tool("search_skills", ...);
server.tool("get_skill", ...);
server.tool("install_skill", ...);
server.tool("scan_enterprise_vulnerabilities", ...);
// ... 30+ tools total
```

## Transport Modes

| Mode | When | Endpoint |
|---|---|---|
| **Stdio** | `PORT` not set | stdin/stdout (Claude Desktop) |
| **SSE** | `PORT=3381` | `:3381/sse` + `:3381/messages` |

## Request Flow

```
┌──────────┐   stdio/SSE    ┌──────────────┐   SQLite    ┌──────────┐
│ AI IDE   │──────────────►│ Platform      │───────────►│ SQLite   │
│ (MCP)    │◄──────────────│ (MCP Server)  │◄───────────│sqlite-vec│
└──────────┘   JSON-RPC    └──────┬───────┘             └──────────┘
                                  │ HTTP
                           ┌──────▼───────┐
                           │ mcp-server   │
                           │ (local AST)  │
                           └──────────────┘
```
