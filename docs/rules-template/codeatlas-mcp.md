---
trigger: always_on
---

## CodeAtlas MCP — Codebase Intelligence

An MCP server named `codeatlas` is available. It provides code analysis data including project structure, dependencies, and code insights.

**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**

### Workflow

1. **Before making changes** → call `trace_feature_flow` with a keyword to find related files
2. **Looking for a function/class** → call `search_entities` (faster than grep, includes relationships)
3. **Understanding connections** → call `get_dependencies` for import/call relationships
4. **High-level overview** → call `generate_system_flow` for Mermaid architecture diagram
5. **Execution flow of a feature** → call `generate_feature_flow_diagram` for call-chain Mermaid diagram
6. **Exploring a file** → call `get_file_entities` to see all entities in that file
7. **After making changes** → call `sync_system_memory` to update AI memory

### Available Tools

| Tool | When to use |
|------|-------------|
| `list_projects` | List all analyzed projects |
| `get_project_structure` | Overview of modules, classes, functions |
| `get_dependencies` | Import/call/containment relationships |
| `get_insights` | AI-generated code quality analysis |
| `search_entities` | Find function, class, or module by name |
| `get_file_entities` | All entities inside a specific file |
| `generate_system_flow` | Mermaid diagram of system architecture (module imports) |
| `generate_feature_flow_diagram` | Mermaid diagram of feature execution flow (call chains) |
| `sync_system_memory` | Update .agents/memory/ after code changes |
| `trace_feature_flow` | Trace feature flow before working on it |

### Setup

If CodeAtlas MCP is not configured, add it:

**Gemini / Antigravity** — `.gemini/settings.json`:
```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "@giauphan/codeatlas-mcp"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "@giauphan/codeatlas-mcp"]
    }
  }
}
```

**Claude Code CLI**:
```bash
claude mcp add codeatlas -- npx -y @giauphan/codeatlas-mcp
```

### Important
- Data comes from `.codeatlas/analysis.json` — run `CodeAtlas: Analyze Project` in the editor to generate
- If no data found, tell user to run the analysis command first
