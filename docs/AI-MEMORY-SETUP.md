# 🧠 AI System Memory — Setup Guide

## What is this?

Solves the **AI losing context between conversations** problem. When you start a new chat, AI automatically knows:
- System modules and how they connect
- Current business rules
- Code conventions
- Recent changes

## Requirements

1. **CodeAtlas extension** installed in VS Code / Cursor
2. Project analyzed at least once (`CodeAtlas: Analyze Project`)

## Setup (One-Time)

### Step 1: Install CodeAtlas Extension

Install `codeatlas` from VS Code Marketplace or use the `.vsix` file.

### Step 2: Add CodeAtlas MCP Server

Choose your AI platform:

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

**Windsurf / Other MCP-compatible editors**:
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

### Step 3: Run Analyze Project

Open your project in VS Code → `Ctrl+Shift+P` → `CodeAtlas: Analyze Project`

This automatically creates:
```
.codeatlas/
└── analysis.json          # Code analysis data for MCP

.agents/
├── memory/
│   ├── system-map.md      # Mermaid architecture diagram (auto-generated)
│   ├── modules.json       # Module registry + imports + contains
│   ├── feature-flows.json # Feature → files mapping
│   ├── business-rules.json # Business rules (preserved between analyses)
│   ├── change-log.json    # Recent changes log (preserved between analyses)
│   └── conventions.md     # Languages, patterns, structure (auto-generated)
└── rules/
    ├── codeatlas-mcp.md   # Tells AI how to use CodeAtlas MCP tools
    └── auto-memory.md     # Tells AI to read/sync memory automatically
```

### Step 4: Done! 🎉

From now on, every new AI conversation will:
1. Read `.agents/memory/` → know system architecture
2. Use MCP tools to trace code → understand before editing
3. Sync memory after changes → next conversation remembers

**No manual file copying needed. Everything is auto-generated.**

---

## How It Works

```
You: "feature X has bug Y"
          │
          ▼
AI reads .agents/memory/       ← recalls system flow
          │
          ▼
AI calls trace_feature_flow("X")  ← finds related files
          │
          ▼
AI reads files in readingOrder     ← understands current code
          │
          ▼
AI fixes code                      ← edits the right place
          │
          ▼
AI calls sync_system_memory()      ← updates memory for next time
```

## MCP Tools Reference

| Tool | When to use |
|------|-------------|
| `generate_system_flow` | See Mermaid architecture diagram |
| `sync_system_memory` | After code changes (MUST call) |
| `trace_feature_flow` | Before working on a feature |
| `get_project_structure` | List modules, classes, functions |
| `get_dependencies` | Import/call relationships |
| `search_entities` | Find function/class by name |
| `get_file_entities` | All entities in a specific file |
| `get_insights` | Code quality analysis |
| `list_projects` | List all analyzed projects |

## FAQ

**Q: Memory gets stale when code changes?**
A: No. Rules force AI to call `sync_system_memory` after every edit. Memory auto-updates from actual code.

**Q: Business rules change?**
A: When you mention new rules, AI saves them to `business-rules.json`. This file only appends, never deletes.

**Q: New project without analysis.json?**
A: Run `CodeAtlas: Analyze Project` in VS Code first. Then MCP tools work.

**Q: What languages are supported?**
A: TypeScript, JavaScript, Python, PHP (including Blade templates).

**Q: Do I need to copy rule files manually?**
A: No! Since v1.5.0, running `Analyze Project` auto-generates both `.agents/memory/` and `.agents/rules/`.
