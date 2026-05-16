# Changelog

All notable changes to this project will be documented in this file.

## [2.1.4] - 2026-05-16

### Added
- **Auto-Indexing Engine**: Integrated Chokidar file watcher to automatically trigger codebase re-indexing on local file changes.
- **Neural Indexing UI**: Modernized the Cloud Index tab with a Roo-Code style control panel, featuring auto-indexing toggles and a real-time log stream.
- **Cluster Graph Layout**: Refactored the Knowledge Graph logic to group functions and variables around their parent modules in a "Neural Cluster" formation.
- **Interactive Graph Filters**: Added entity-type filtering (Modules, Functions, Classes, Variables) and deep search capabilities.
- **Multi-Tab Auth UI**: Restored and upgraded the Authentication interface to support Access Tokens, Firebase Email/Password, and Admin Bypass.

### Fixed
- **TypeScript Type Safety**: Resolved "implicitly any" and module resolution errors in the core MCP engine.
- **Dashboard Stabilization**: Fixed layout overlaps and ensured robust data fetching with deep optional chaining.

## [2.1.3] - 2026-05-16

### Added
- **Neural Interface UI**: Major modernization of the dashboard using a premium Glassmorphism design system.
- **Glassmorphic Components**: Implemented high-fidelity panels, sidebars, and metrics cards with 20px backdrop blur and rim-lighting.
- **Typography Upgrade**: Integrated Space Grotesk (headers) and Inter (data) for a cinematic tech aesthetic.
- **Enhanced Visuals**: Added Neon Cyan and Electric Violet accents with bloom/glow effects.
- **Neural Loading Screen**: Implemented a futuristic system initialization sequence in `App.tsx`.

### Changed
- Refactored `Dashboard.tsx` to use a fixed glass sidebar and floating stats grid.
- Redesigned `Auth.tsx` with a floating glass card and Super Admin bypass integration.

## [2.1.2] - 2026-05-16

### Added
- Super Admin bypass key for uninterrupted access during Firestore indexing.

### Changed
- Migrated from npm to pnpm for disk space optimization and faster installs.
- Hardened .gitignore to exclude pnpm logs and Firebase service account JSON files.
- Synchronized environment configuration for SSE server on port 8080.

## [2.1.0] - 2026-05-16

### Added
- **Real-time Activity Telemetry**: Implemented `logActivity` system that records all tool executions to Firestore for live monitoring.
- **Enterprise Dashboard UI**: Completely revamped the dashboard with a premium glassmorphism design, real-time usage stats, and live activity feeds.
- **Enterprise Vulnerability Scanner**: Unlocked the full security and architectural audit tool for all enterprise users.

### Fixed
- **JSX Syntax & TypeScript Errors**: Resolved multiple structural and type mismatch issues in `Dashboard.tsx` and `index.ts`.
- **Authentication Flow**: Standardized `checkAuth` to return rich user metadata, enabling secure multi-tenant activity tracking.

## [2.0.0] - 2026-05-16

### Changed
- **Pure MCP/API Architecture**: Removed VS Code extension code entirely. The project is now a standalone MCP server and HTTP API provider.
- **Standalone Dashboard**: Maintained the web dashboard as a standalone interface connecting to the API.
- **Dependency Update**: Added missing dependencies (`@modelcontextprotocol/sdk`, `express`, `firebase-admin`, `zod`) to the root `package.json`.
- **ESM Migration**: Updated project to use ES Modules (`"type": "module"`) for better compatibility with modern Node.js and MCP SDK.

## [1.9.0] - 2026-05-16

### Changed
- **Architectural Migration**: Moved core analysis logic to the server-side to support remote MCP deployment.
- **Thin Client Extension**: Refactored the VS Code extension to be a thin client. It now fetches analysis data from a remote MCP server instead of performing local file parsing.
- **Removed Local Logic**: Stripped `src/analyzer` and database connectivity logic from the extension build.
- **Remote Configuration**: Added `codeatlas.remoteMcpUrl` and `codeatlas.apiKey` settings.

## [1.8.2] - 2026-05-16

### Fixed
- Resolved Firebase environment variable TypeScript errors by adding `vite-env.d.ts` and updating `tsconfig.json` in the dashboard.

## [1.8.1] - 2026-05-07

### Added
- Upgraded to Oracle Thick Mode using Instant Client 21.16 for full mTLS support.
- Added automatic Oracle Client initialization logic in `src/oracleDatabase.ts`.

### Fixed
- Stabilized Oracle Autonomous Database 26ai connectivity with 100% mTLS compatibility.
- Resolved ORA-01017 credential error by properly quoting .env values.

## [1.8.0] - 2026-05-07

### Added
- **Subscription Tier System** — Introduced Free, Plus, Pro, and Enterprise tiers.
- **Tier-based Access Control** — MCP server now enforces tool restrictions based on API key tier.
  - **Free Tier Limits**:
    - Only `generate_system_flow` and `get_project_structure` are fully enabled.
    - `get_project_structure` and `get_file_entities` are limited to 50 results.
    - Advanced tools (`get_insights`, `trace_feature_flow`, etc.) require a paid plan.
- **Dashboard Updates**:
  - Display user tier badge.
  - Automatic 'free' tier assignment on signup.
  - API keys now inherit user tier.
  - Upgrade prompts for free tier users.

## [1.7.0] - 2026-05-20

### Added
- **Standalone MCP Server Support** — Can now be deployed as a remote server via SSE or local via Stdio.
- **Security Mechanism** — Added API Key authentication via `CODEATLAS_API_KEY` environment variable.
  - For SSE: Validates `x-api-key` header or `apiKey` query parameter.
  - For Stdio: Validates the presence of the environment variable on the host.
- **Dynamic Transport** — Automatically switches to SSE if `PORT` environment variable is set.

## [1.6.4] - 2026-05-07

### Added
- Integrated RTK (Rust Token Killer) for optimized token usage in shell commands.
- Setup `rtk` wrapper rules for Antigravity agent in `rules/`.

---

## [1.6.0] - 2026-04-16

### Added
- **New MCP Tool: `generate_feature_flow_diagram`** — Generates Mermaid diagrams showing the actual execution flow of a feature
  - Traces call chains: entry point → controller → service → model
  - Supports `flowchart` and `sequence` diagram types
  - Includes topological sort for step-by-step execution order
  - Color-coded: 🟢 entry points, 🔵 keyword matches, 🟠 classes, ⬜ functions
- Updated `.agents/rules/codeatlas-mcp.md` template with new tool reference

---

## [1.5.0] - 2026-04-16

### Added
- **Auto-generate `.agents/memory/`** — Extension now automatically creates the memory folder after every `Analyze Project` run
  - `system-map.md`, `modules.json`, `feature-flows.json`, `conventions.md` are regenerated each time
  - `business-rules.json` and `change-log.json` are preserved if they already exist (only created on first run)
- New `src/memoryGenerator.ts` module encapsulating memory generation logic

---

## [1.4.3] - 2026-04-16

### Fixed
- Ensure `JSON.parse` results are validated as arrays before calling `.push()` / `.unshift()` — prevents runtime errors when `business-rules.json` or `change-log.json` contain non-array data
- Applied fix to both `index.ts` and `scripts/sync-all-memory.cjs`

---

## [1.4.2] - 2026-04-08

### Fixed
- Handle undefined `stats` in `AnalysisResult` — prevents `Cannot read properties of undefined (reading 'files')` errors during MCP tool execution
- Made `stats`, `entityCounts`, `totalFilesAnalyzed` optional in interface with null-coalescing fallbacks
- Removed `npm run lint` from `pretest` script (lint setup missing, caused failures)

---

## [1.4.1] - 2026-04-03

### Fixed
- Fixed `.agent/memory/` → `.agents/memory/` path in `index.ts` and `auto-memory.md` to match project convention

### Added
- `scripts/sync-all-memory.cjs` — Utility script to generate `.agents/memory/` for all projects at once
- Version & changelog rule in `.agents/rules/rule.md` — AI must bump version + update changelog on every change

---

## [1.4.0] - 2026-04-03

### Added
- **`generate_system_flow` MCP tool** — Auto-generates Mermaid flowchart diagrams from code analysis. Supports 3 scopes: `modules-only`, `full`, `feature`
- **`sync_system_memory` MCP tool** — Creates/updates `.agents/memory/` folder with 6 auto-generated files (system-map.md, modules.json, feature-flows.json, business-rules.json, change-log.json, conventions.md). Serves as AI's persistent long-term memory between conversations
- **`trace_feature_flow` MCP tool** — BFS-based feature tracing: give a keyword, get all related files sorted by dependency order with `readingOrder` for AI to follow
- **Auto-memory rule template** — `.agents/rules/auto-memory.md` forces AI to read memory at conversation start and sync after code changes
- **CodeAtlas MCP rule template** — `.agents/rules/codeatlas-mcp.md` forces AI to use MCP tools before manual grep
- **Setup guide** — `docs/AI-MEMORY-SETUP.md` with step-by-step instructions for any project
- **Rule templates** — `docs/rules-template/` folder with ready-to-copy rule files

### Changed
- MCP server version bumped to 1.4.0 (9 tools total: 6 existing + 3 new)
- `tsconfig.json` — `rootDir` changed to `.` and `index.ts` added to `include` for proper IDE type checking
- Added `@modelcontextprotocol/sdk` and `zod` to `package.json` dependencies (were previously only available via npx)

---

## [1.2.2] - 2026-03-21

### Added
- **Auto-discover projects** — MCP server scans `~/` for all projects with `.codeatlas/analysis.json`
- **`list_projects` tool** — lists all analyzed projects with last analysis time
- All tools accept optional `project` parameter — specify by name or path
- No more hardcoded `CODEATLAS_PROJECT_DIR` needed

---

## [1.2.1] - 2026-03-21

### Added
- **Panel toggle buttons** — hide/show left (AI Insights) and right (Entity Overview) panels
- Smooth slide animation with 0.3s transition
- Graph auto-expands to fill space when panels are hidden

---

## [1.2.0] - 2026-03-21

### Added
- **MCP Server** — AI assistants can query CodeAtlas analysis data via Model Context Protocol
  - `get_project_structure` — list all modules, classes, functions, variables
  - `get_dependencies` — import/call/containment relationships
  - `get_insights` — AI-generated code insights
  - `search_entities` — fuzzy search by entity name with relationships
  - `get_file_entities` — all entities in a specific file
- Extension now saves analysis to `.codeatlas/analysis.json` for MCP server
- `.gemini/settings.json` MCP config included

---

## [1.1.1] - 2026-03-21

### Added
- **`excludedFiles` setting** — skip generated stub files (e.g. `_ide_helper.php`)
- Default excludes: `_ide_helper.php`, `_ide_helper_models.php`, `.phpstorm.meta.php`

### Fixed
- Laravel `_ide_helper.php` (28k lines, 2072 method stubs) flooding the graph with framework functions

---

## [1.1.0] - 2026-03-21

### Added
- **PHP parser** — regex-based extraction of classes, interfaces, traits, enums, functions, properties, constants, namespaces, `use` statements
- **Blade template parser** — `@extends`, `@include`, `@component`, `<x-component>`, `@section`, `@yield`
- **Per-project config** — `codeatlas.fileExtensions` and `codeatlas.excludedDirectories` via `.vscode/settings.json`
- `.php` added to default `fileExtensions`
- `vendor`, `storage` added to default `excludedDirectories`
- Color coding: PHP `#4F5D95`, Blade `#FF2D20`, Interface `#7209b7`, Trait `#06d6a0`, Enum `#ffd166`

### Fixed
- **Webview race condition** — data sent before React mounted; added `webviewReady` handshake with message buffering
- **Blank webview** — moved `acquireVsCodeApi()` before React bundle; fixed CSS filename mismatch (`style.css` vs `index.css`)
- **JS error on load** — variable name collision (`el`) between inline script and Vite bundle
- **`graphPhysics` undefined** — replaced with default values
- **Phantom function nodes** — orphan links filtered from graph; `react-force-graph` no longer auto-creates nodes for undefined targets
- **CSS layout** — full rewrite: proper flexbox layout, left/right panels visible, graph centered, status bar flow-based

---

## [1.0.0] - 2026-03-21

### Added
- Interactive force-directed graph visualization of source code
- AST-based code analysis for TypeScript, JavaScript, and Python files
- AI Insights panel with refactoring suggestions, security audit, and maintainability score
- AI Copilot chat with natural language queries about codebase
- Entity overview sidebar with counts and relationship statistics
- Click-to-navigate from graph nodes to source code
- Auto-reanalyze on file save with debounce
- Graph search and entity type filtering
- VS Code status bar integration
- Custom dark cyberpunk theme with glassmorphism design