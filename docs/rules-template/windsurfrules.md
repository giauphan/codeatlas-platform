# CodeAtlas MCP — Codebase Intelligence

An MCP server named `codeatlas` is available. It provides code analysis data including project structure, dependencies, and code insights.

**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**

## Workflow

1. **Before making changes** → call `trace_feature_flow` with a keyword to find related files
2. **Looking for a function/class** → call `search_entities`. NEVER use grep or find commands.
3. **Understanding connections** → call `get_dependencies` for import/call relationships
4. **High-level overview** → call `generate_system_flow` for Mermaid architecture diagram
5. **Execution flow of a feature** → call `generate_feature_flow_diagram` for call-chain Mermaid diagram
6. **Exploring a file** → call `get_file_entities` to see all entities in that file
7. **After making changes** → call `sync_system_memory` to update AI memory

## Available Tools

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

## Memory System

At the **start of EVERY conversation**, read `.agents/memory/` if it exists:
1. `.agents/memory/system-map.md` — System architecture
2. `.agents/memory/business-rules.json` — Business rules
3. `.agents/memory/conventions.md` — Coding conventions
4. `.agents/memory/change-log.json` — Recent changes

**After code changes**, ALWAYS call `sync_system_memory`:
- `changeDescription` (ALWAYS required): What you just changed
- `businessRule` (ALWAYS extract if user mentions ANY domain logic):
  - Conditions: "only process videos > 30s", "skip if under 1000 likes"
  - Permissions: "VIP users skip email verification"
  - Limits: "free tier limited to 5 projects"
  - Even if user says it casually, YOU MUST SAVE IT
  - If unsure whether something is a business rule, SAVE IT ANYWAY

**DO NOT SKIP THIS STEP.** If you forget to sync, the next conversation loses all context.
