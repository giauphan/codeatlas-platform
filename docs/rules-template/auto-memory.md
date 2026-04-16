---
trigger: always_on
---

## AI System Memory — Auto-Read & Auto-Sync

### 🧠 MANDATORY: Read Memory at Start

**At the start of EVERY conversation**, before doing any work:

1. Check if `.agents/memory/` folder exists in the project
2. If it exists, read these files IN ORDER:
   - `.agents/memory/system-map.md` — Understand the system architecture
   - `.agents/memory/business-rules.json` — Know the business rules
   - `.agents/memory/conventions.md` — Know the coding conventions
   - `.agents/memory/change-log.json` — Know what changed recently
3. Use this context to avoid breaking existing logic

### 🔎 MANDATORY: Use CodeAtlas MCP to Understand Code BEFORE Making Changes

**NEVER start coding without understanding the codebase first.** Follow this flow:

1. **User describes a problem/feature** → FIRST call `trace_feature_flow` with a keyword
   - Returns the list of related files in `readingOrder`
   - Read those files to understand the current implementation

2. **Need to find a specific function/class** → call `search_entities` instead of grep
   - Faster and includes relationship data (who calls it, who imports it)

3. **Need to understand how things connect** → call `get_dependencies`
   - Shows import/call/containment relationships between modules

4. **Need a high-level overview** → call `generate_system_flow`
   - Returns a Mermaid diagram showing the full system architecture

5. **Need to see execution flow of a feature** → call `generate_feature_flow_diagram`
   - Returns a Mermaid flowchart or sequence diagram showing the call chain
   - Shows: entry point → controller → service → model step-by-step

6. **Need to know what's in a specific file** → call `get_file_entities`
   - Returns all classes, functions, variables in that file

**Example flow when user says "fix login timeout":**
```
1. trace_feature_flow(keyword: "login")     → get list of related files
2. generate_feature_flow_diagram(keyword: "login") → see execution flow
3. Read files in readingOrder               → understand current logic
4. Fix the code                             → make changes
5. sync_system_memory(changeDescription: "Fixed login timeout") → update memory
```

### 🔄 MANDATORY: Sync Memory After Changes

**After completing ANY code changes, you MUST call `sync_system_memory`:**

1. **`changeDescription`** (ALWAYS required): What you just changed
   - Example: `"Fixed login timeout by adding retry logic"`

2. **`businessRule`** (if user mentions domain logic):
   - Business rules are statements like:
     - "VIP users skip email verification"
     - "Only process videos with 1000+ likes"
     - "Free tier limited to 5 projects"
   - If user mentions any such rule, SAVE IT

**DO NOT SKIP THIS STEP.** If you forget to sync, the next conversation loses all context.

### Available Memory Tools

| Tool | When to use |
|------|-------------|
| `generate_system_flow` | See/understand system architecture (module imports) |
| `generate_feature_flow_diagram` | See execution flow of a feature (call chains) |
| `sync_system_memory` | After code changes (ALWAYS call this) |
| `trace_feature_flow` | Before working on a feature (understand context) |
| `get_project_structure` | Detailed entity listing |
| `get_dependencies` | Specific dependency relationships |
| `search_entities` | Find function/class by name |
| `get_file_entities` | Contents of a specific file |
| `get_insights` | Code quality / architecture analysis |
