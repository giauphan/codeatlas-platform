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
      "args": ["-y", "-p", "codeatlas-ai", "codeatlas-mcp"]
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
      "args": ["-y", "-p", "codeatlas-ai", "codeatlas-mcp"]
    }
  }
}
```

**Claude Code CLI**:
```bash
claude mcp add codeatlas -- npx -y -p codeatlas-ai codeatlas-mcp
```

**Windsurf / Other MCP-compatible editors**:
```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "-p", "codeatlas-ai", "codeatlas-mcp"]
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

## Model Compatibility

Rules have been tested against multiple AI models:

| Model | Compliance | Notes |
|-------|-----------|-------|
| **gemma-3-27b-it** | 🟢 100% | Perfect — all 7 test cases passed |
| **gemma-3-12b-it** | 🟢 100% | Perfect — all 7 test cases passed |
| **gemma-4-31b-it** | 🟢 86% | Minor: mentions grep alongside search_entities |
| **gemini-2.5-flash-lite** | 🟢 100% |  — all passed |

### Known Limitations

- **Gemma models** don't support `system_instruction` or function calling. Rules must be embedded in user prompt text.
- **Gemini free tier** has strict rate limits (15 RPM). Use exponential backoff for batch testing.

## Rule Writing Best Practices

Patterns that achieve 100% model compliance:

| Pattern | Example | Why |
|---------|---------|-----|
| **Absolute language** | "NEVER use grep" | No ambiguity |
| **Numbered steps** | "1. trace → 2. read → 3. fix" | Sequential enforcement |
| **Concrete examples** | "VIP users skip verification" | Pattern matching |
| **Consequence warnings** | "next conversation loses context" | Fear of breaking |
| **Bold keywords** | "**FIRST** call trace_feature_flow" | Visual attention |
| **MANDATORY headers** | "### 🧠 MANDATORY:" | Stands out |

> ⚠️ Avoid comparative language like "instead of" or "faster than" — use absolute prohibitions like "NEVER" or "MUST" for reliable compliance.

---

## Second Brain Hooks (Claude Code)

The optional **Brain hooks** wire Claude Code to the CodeAtlas brain so every session is primed with relevant memory and new learnings are saved back automatically.

### What the hooks do

| Hook event | Script | Effect |
|------------|--------|--------|
| `UserPromptSubmit` | `brain-context.sh` | Query the brain for context relevant to the incoming prompt; prepend a "Second Brain Context" block |
| `PostToolUse` | `brain-save.sh` | Save key model calls / learnings to the brain |
| `PostToolUseFailure` | `brain-save.sh` | Record what went wrong so the same mistake is less likely to recur |

Hooks are **global** (`~/.claude/hooks/` + `~/.claude/settings.json`) so they fire for **all** Claude Code projects, not just this repo.

### Requirements

- **CodeAtlas server running** — the hooks call the HTTP API, so `codeatlas` must be up (default `http://localhost:3381`).
- **`CODEATLAS_API_KEY`** — the hooks no-op (exit silently) if this is unset, so nothing works until you set it.
- **`python3`** on `PATH` — used by the installer to patch `settings.json`.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CODEATLAS_API_KEY` | Yes | — | Auth token for the CodeAtlas API. Set in your shell profile (`.bashrc` / `.zshrc`) so hooks inherit it. |
| `CODEATLAS_API_URL` | No | `http://localhost:3381` | Base URL of the CodeAtlas server. Override for remote/hosted deployments. |
| `PORT` | No | `3381` | Server listen port (env for the server side, mirrors `CODEATLAS_API_URL`). |

Example shell profile lines:

```bash
export CODEATLAS_API_KEY="your-api-key"
export CODEATLAS_API_URL="http://localhost:3381"
```

> ⚠️ Restart Claude Code after changing these so the running session picks the new values up.

### Install

The installer ships inside the **codeatlas-mcp-server** package (`src/cli/hooks/install-brain-hooks.sh`) and runs as a CLI command:

```bash
# From the installed package (npm / npx):
codeatlas-mcp install-hooks

# From a source checkout of codeatlas-mcp-server:
node dist/index.js install-hooks
```

Preview without writing anything:

```bash
codeatlas-mcp install-hooks --dry-run
```

This is **idempotent** — safe to re-run. What it does:

1. Copies `brain-save.sh` + `brain-context.sh` into `~/.claude/hooks/` (overwrites older versions) and `chmod +x` them.
2. Backs up `~/.claude/settings.json` to `~/.claude/settings.json.bak-install-<timestamp>`.
3. Patches the global hook commands in `~/.claude/settings.json`, using `$HOME`-based paths (`~/.claude/hooks/...`) so it works on any machine/user.
4. Never touches a project's `.claude/settings.json` or global `CLAUDE.md`.

### Verify

After a **restart**, check:

```bash
# Hooks are installed and commands point at current $HOME
grep -n 'brain-' ~/.claude/settings.json
ls -la ~/.claude/hooks/brain-*.sh

# Save hook is actively logging (each line tagged with your project)
tail -f ~/.claude/brain-save.log
```

You should also see a **"Second Brain Context"** block in the system reminder at the top of any new conversation (requires `CODEATLAS_API_KEY` to be set).

### Uninstall / rollback

The installer does **not** provide an uninstall flag — roll back manually:

1. **Restore settings.json** from the installer backup:
   ```bash
   cp ~/.claude/settings.json.bak-install-<timestamp> ~/.claude/settings.json
   ```
   (If a backup is missing, remove the `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` entries under `"hooks"` from `~/.claude/settings.json`.)

2. **Remove the hook scripts:**
   ```bash
   rm ~/.claude/hooks/brain-context.sh ~/.claude/hooks/brain-save.sh
   ```

3. **Restart Claude Code.**

### Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| No "Second Brain Context" block appears | `CODEATLAS_API_KEY` unset in the shell profile; or the CodeAtlas server isn't reachable at `$CODEATLAS_API_URL`. |
| `ERROR: /home/.../settings.json not found` | Installer expects `~/.claude/settings.json` to exist. Create it first (`{}` is fine) or run `claude` once to generate it. |
| Hooks fire but log nothing | Check the server and restart Claude Code — hooks load settings at startup. |
| Contaminated context in tool output | Old/duplicate `brain-context.sh` hook output may be polluting sessions. Re-run the installer (overwrites the hook) and restart, or remove the hook per **Uninstall / rollback**. |
