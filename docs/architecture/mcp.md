# MCP Architecture

## Tool Registration

CodeAtlas Platform registers tools via the MCP SDK:

```typescript
// mcpTools.ts — 30+ MCP tools registered
server.tool("save_dream_memory", "Save memory...", schema, async ({ content, ... }) => {
  await OracleDreamingService.saveDreamMemory(...);
});

server.tool("query_dream_memories", "Search memories", schema, async ({ query, ... }) => {
  return await OracleDreamingService.queryDreamMemories(...);
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
| **SSE** | `PORT=8080` | `:8080/sse` + `:8080/messages` |

## Request Flow

```
┌──────────┐   stdio/SSE    ┌──────────────┐   Oracle    ┌──────────┐
│ AI IDE   │──────────────►│ Platform      │───────────►│ Oracle   │
│ (MCP)    │◄──────────────│ (MCP Server)  │◄───────────│ 26ai DB  │
└──────────┘   JSON-RPC    └──────┬───────┘             └──────────┘
                                  │ HTTP
                           ┌──────▼───────┐
                           │ mcp-server   │
                           │ (local AST)  │
                           └──────────────┘
```
