# Changelog

All notable changes to this project will be documented in this file.

## [2.11.2] - 2026-05-23

### Fixed / Changed
- Enforce strict exact-path matching during project deletion to prevent name-matching ambiguity.
- Support safe clean up of empty tenant project folders inside the multi-tenant directory.
- Restrict Firestore deletion to scoped tenant documents to prevent cross-tenant data loss.
- Propagate Oracle DB memory and project-unregister errors to the API delete response.
- Validate project directory query parameter type on the server and safely handle non-JSON error responses in the frontend.

## [2.11.1] - 2026-05-23

### Changed
- Added Danger Zone project removal control to the Knowledge Graph tab.
- Added comprehensive unit tests for project deletion in both backend controllers and frontend dashboard views.

## [2.11.0] - 2026-05-23

### Added
- **Project Deletion & Remote Cleanup**: Added `DELETE /api/projects` endpoint and Danger Zone component in the Dashboard to clean up local indexed directories, unregister projects, and purge Firestore telemetry and Oracle 26ai Database memory records (episodic, semantic, relational).

## [2.10.4] - 2026-05-22

### Changed / Fixed
- **Robust Client Binary Resolution in Integration Tests**: Improved sibling client binary lookup to gracefully skip startup E2E tests in environments where the client is not checked out (like CI runners).

## [2.10.3] - 2026-05-22

### Added
- **NVIDIA API Key Env Config**: Added `NVIDIA_API_KEY` placeholder configuration variable to `.env.example` to support standard environment setup.

## [2.10.2] - 2026-05-22

### Changed / Fixed
- **Source Comments in English**: Translated all Vietnamese database schema comments and code comments in the codebase to English to match formatting guidelines.
- **Typecast connection.executeMany Binds**: Cast parameter binds to `any[]` in `oracleDatabase.ts` to satisfy the TypeScript compilation requirements.


## [2.10.1] - 2026-05-22

### Removed
- **Unnecessary Files & Legacy Components**: Completely removed the legacy AST parser (`src/analyzer`) and local filesystem watcher (`watcherService`) from the central server codebase, delegating these local-first tasks entirely to the client enterprise MCP repo.

## [2.10.0] - 2026-05-22

### Added
- **Automated Workspace Indexing and Watching**: Hooked in the `watcherService` and `CodeAnalyzer` into the server's lifecycle. The server now auto-scans active project workspaces for `.codeatlas` markers and watches for code changes in real-time, automatically triggering re-indexing on file edits.
- **Dynamic Project Discovery**: Restored scanning logic for globally registered projects (~/.codeatlas/registered_projects.json) and nested directories to ensure that all workspace paths are indexed without manual server configuration.
- **Triggerable Analyze MCP Tool**: Refactored the `analyze` tool to run the dynamic `CodeAnalyzer`, write the AST payload locally, and synchronize the telemetry to Firestore and CodeAtlas Cloud VPS on demand.

## [2.9.11] - 2026-05-18

### Fixed / Added
- **Multi-Tenant Access Isolation Hierarchy**: Standardized project discovery for Multi-Tenant mode. Standard tenants can only discover projects within their own `tenants/{tenantId}/` workspace. System Administrators can view both their own user tenant projects, system-wide projects, and all projects synced across all other tenant workspaces.

## [2.9.10] - 2026-05-18

### Added / Migration
- **Runtime Telemetry Migration Fallback**: Added automatic backward-compatible runtime migration of legacy Firestore documents. When syncing under a tenant, the server automatically detects legacy non-prefixed documents, safely migrates and merges their historical telemetry data into the new isolated `${tenantId}_${projectName}` documents, and cleans up legacy duplicate documents.

## [2.9.9] - 2026-05-18

### Fixed / Added
- **Multi-Tenant Firestore Isolation**: Fixed the telemetry linkage bug where projects with identical names from different users could overwrite each other in the Firestore database. Telemetry documents are now uniquely identified using `${tenantId}_${projectName}`.
- **Single-Tenant Project Discovery**: Hardened the discovery service to scan the `projects/` sub-directory when `CODEATLAS_MULTI_TENANT` is disabled, allowing projects synced to the server in single-tenant environments to be fully indexed and accessible via MCP tools.

## [2.9.8] - 2026-05-18

### Changed / Removed
- **Architectural Separation of Concerns**: Completely removed the legacy AST parser (`src/analyzer`) and local filesystem watcher (`watcherService`) from the central server codebase.
- **Dependency Simplification**: Grew lighter by un-installing bulky libraries like `@typescript-eslint/typescript-estree`, `py-ast`, `chokidar`, and `glob` from the remote server, preventing node-gyp compile issues and saving over 50% package footprint.
- **REST Sync & Isolation**: Standardized the server to act as a purely lightweight database/API hub. Server now exclusively consumes pre-analyzed AST payloads synced from the local `codeatlas-enterprise` client, returning descriptive guides on local reindexing endpoints.

## [2.9.7] - 2026-05-18

### Fixed / Changed
- **Stdio Stream Isolation**: Migrated all raw `console.log` statements in the client package (`codeatlas-enterprise`) to `console.error`. This prevents logs and diagnostics from polluting `stdout`, which is strictly reserved for JSON-RPC frame framing, resolving `invalid character '=' looking for beginning of value` errors during server initialization.

## [2.9.6] - 2026-05-18

### Fixed / Changed
- **NPM Package Binary Name Fix**: Updated `package.json` in the `codeatlas-mcp-enterprise` client package to map `"bin"` directly to `"codeatlas-enterprise"`, aligning the binary name with the package name. This ensures that executing `npx -y codeatlas-enterprise` invokes our new secure Local-First JS script directly, instead of falling back to cached legacy packages or causing Supergateway 401 connection errors.

## [2.9.5] - 2026-05-18

### Changed / Removed / Security
- **Strict Client-Side Security Hardening**: Completely removed sensitive Firestore, Firebase Admin, and Oracle database integrations/schema definitions from the distributed local MCP package (`codeatlas-mcp-enterprise`).
- **REST Sync Strategy**: Refactored background auto-scans to securely POST local AST `.codeatlas/analysis.json` data to the secure remote VPS server using standard Bearer Token HTTPS endpoints (`/api/projects/sync`), preventing exposure of database credentials and internal database structures in local installations.
- **In-Process Watcher Pipeline**: Refactored the file watcher to run indexing dynamically in-process on change events, eliminating manual subprocesses and configuration overhead.
- **Dependency Reduction**: Removed heavy native `oracledb` and `firebase-admin` packages from the client node dependencies, resulting in a lightweight, robust, compilation-error-free, and enterprise-secure client setup.

## [2.9.4] - 2026-05-18

### Fixed / Changed
- **Robust Firebase & Firestore Initialization**: Guarded index.ts and run_indexing.ts to safely handle missing or deleted Firebase credentials. Checked for file existence on disk before passing Google application credentials paths to cert(), avoiding fatal unhandled initialization crashes on startup.
- **Fail-Safe Background Auto-Indexing**: Wrapped the background auto-scanner CLI to dynamically resolve and load the Firestore instance only if Firebase Admin initialized successfully, allowing indexing to proceed locally even without Firestore sync capabilities.

## [2.9.3] - 2026-05-18

### Changed / Refactored
- **Clean Architecture Refactoring**: Decoupled the massive server file by separating presentation logic and application services cleanly. Express routing, security middleware, and Server-Sent Events (SSE) session management are extracted into the `src/presentation/httpServer.ts` adapter layer.
- **Obsolete Tool Registrations Purged**: Purged duplicate code registration logic within the main server file in favor of the unified tool mappings defined inside the `src/presentation/mcpServer.ts` adapter layer.
- **Thin Composition Root**: Index.ts is now streamlined to serve as a pure composition root that initializes application-wide configurations, triggers background scans, and spins up the selected transport (SSE or Stdio).

## [2.9.2] - 2026-05-18

### Changed / Added
- **Automated Directory Discovery & Dynamic Codebase Auto-Scanning**: Removed the strict requirement for a pre-generated `.codeatlas/analysis.json` file during project discovery. Relaxed `discoverProjects` / `discoverProjectsAsync` to automatically identify any developer project directory by checking for standard metadata heuristics (such as `package.json`, `.git`, `.codeatlas`, or `README.md`).
- **Dynamic Background Codebase Scanning**: Implemented an automated background scanner using `CodeAnalyzer`. If a project lacks a pre-existing analysis file, the server dynamically instantiates a parser, indexes the project, saves the resulting JSON locally, and optionally syncs telemetry metrics to Firestore asynchronously on the fly.
- **Server Startup Indexing**: Added non-blocking background discovery and initial scanning on server startup (`main()`) to automatically index all candidate projects asynchronously without introducing boot delays.

## [2.9.1] - 2026-05-18

### Changed / Fixed
- **Asynchronous File System Operations**: Fully refactored `loadAnalysis` and `discoverProjects` to non-blocking promised-based asynchronous counterparts (`loadAnalysisAsync` and `discoverProjectsAsync`).
- **Asynchronous MCP Tools**: Updated all codebase intelligence tools (`sync_system_memory`, `trace_feature_flow`, `generate_feature_flow_diagram`, `detect_architectural_smells`, `scan_enterprise_vulnerabilities`) to asynchronously query project data and perform non-blocking filesystem I/O operations under high concurrent load.
- **Dynamic SSE Server Versioning Alignment**: Bumped the version of dynamic session-specific MCP server instances to `"2.9.1"` in Server-Sent Events (SSE) mode, ensuring complete version alignment across dynamic and static server endpoints.

## [2.8.0] - 2026-05-18

### Added / Changed
- **Secure Cryptographic API Key Hashing**: Implemented cryptographic SHA-256 API key hashing on both the browser front-end (via Web Crypto `crypto.subtle`) and the Node backend server (via Node `crypto`). Plain-text API keys are never persisted in the Firestore database; only the cryptographically hashed string (`keyHash`) and a public key preview (`keyPreview`) are stored.
- **Single-Exposure Secret Copying**: Configured the dashboard UI to display the newly generated API key exactly once upon creation for secure copying, after which the key is hidden forever.
- **Unhashed Legacy Backwards Compatibility**: Implemented a robust fallback layer in the authentication store verification flow to support legacy unhashed API keys seamlessly.
- **PR Merge & Branch Lifecycle Management**: Safely integrated and merged Pull Request #3 (`feat: Store and verify API keys using cryptographic hashing`) into `main`. Deleted the remote PR branch `hash-api-keys-5588962574063343813` and pruned the local environment.

## [2.7.4] - 2026-05-17

### Fixed
- **PR Merge & Branch Lifecycle Management**: Verified, reviewed, and successfully merged Pull Request #1 (`Fix Command Injection in Auto-Indexing Watcher`) into `main`. Safely deleted the stale remote branch `fix-command-injection-index-2713636837679567816` from GitHub and pruned the local environment.
- **System Stability Verification**: Confirmed flawless build status and type safety for both the MCP Server (root) and the Neural Dashboard (dashboard/), with 100% of integration test suites executing successfully.

## [2.7.3] - 2026-05-17

### Added / Changed / Fixed
- **Credentials & Wallet Secret Hardening**: Removed hardcoded Firebase Admin SDK credential JSON file and sensitive Oracle Wallet materials from Git tracking. All credentials now safely load via environment variables (`GOOGLE_APPLICATION_CREDENTIALS` and `TNS_ADMIN`).
- **SSE Session Ownership Verification**: Implemented multi-session ownership verification for Server-Sent Events `/sse` and `/messages`, completely preventing unauthorized session hijacking or cross-user SSE data access.
- **Oracle VPD Production Fail-Closed Policy**: Enforced dynamic fail-closed behavior for Oracle RLS/VPD security context binding in production environments to guarantee complete tenant boundary isolation.

## [2.7.2] - 2026-05-17

### Fixed
- **Command Injection Mitigation**: Hardened the auto-indexing project watcher, refactoring insecure dynamic shell `exec` calls to secure, parameterized `execFile` invocations.

## [2.7.1] - 2026-05-17

### Fixed
- **Token Verification & Validation Bug**: Fixed a bug where entering any arbitrary key or token in the "TOKEN" authentication tab would allow standard users to bypass client-side validation and enter a broken dashboard UI. The login screen now calls the projects endpoint (`/api/projects`) to perform pre-login authentication verification, properly returning security warnings for invalid keys.

## [2.7.0] - 2026-05-17

### Added / Changed / Fixed
- **Enterprise-Grade Token & API Key Session Isolation**: Replaced the hardcoded super admin backdoor access button with a dynamic, secure, and ephemeral Token/API Key session manager in the browser. Storing access tokens inside `sessionStorage` avoids cross-tab session hijacking or persistence vulnerabilities on shared machines.
- **Removed Buggy Registry Flow**: Eliminated the user signup ("CREATE" node) flow from the React portal entirely, locking access to pre-registered nodes and Enterprise API Key initializations.
- **Migrated Local Cache Persistence**: Transitioned all local file structures, project preferences, and system analysis cache items from `localStorage` to `sessionStorage` to seal local directory path leakage risks.

## [2.6.0] - 2026-05-17

### Added / Changed / Fixed
- **Dynamic Role-Based Super Admin Authorization Flow**: Replaced the email-specific hardcode with a dynamic lookup of the user's role from their Firestore document (`users/{uid}`) or custom token claims (`decodedToken.role`), supporting clean-architecture enterprise standards.
- **Upgraded upgrade_admin Script**: Updated the administrative bootstrap script to automatically set `role: 'admin'` in Firestore to grant proper, dynamic permissions to administrative accounts.

## [2.5.3] - 2026-05-17

### Fixed / Changed
- **Fixed Multi-Tenant Project Leak Bug**: Replaced the hardcoded `SUPER_ADMIN_KEY` for fetching projects in `Dashboard.tsx` with dynamic, authenticated Firebase user ID Bearer tokens (`Authorization: Bearer <ID_TOKEN>`).
- **Hardened Multi-Tenant Isolation Boundaries**: Updated the `authMiddleware` in `index.ts` to decode and verify Firebase ID tokens using `firebase-admin`, preventing standard users from bypassing boundaries to access super-admin (/home) directory structures.
- **Harden Reindex Endpoint**: Secured the `/api/reindex` route to strictly validate that the requested `projectDir` lies within the authenticated tenant's directory.

## [2.5.2] - 2026-05-17

### Fixed / Changed
- **Added Remote API Key Setup in Documentation**: Updated the dashboard MCP integration guide (`DocumentationView.tsx`) to show exactly how to configure the `CODEATLAS_API_KEY` for VS Code (via `env` and `args` options) and added `?apiKey=YOUR_API_KEY_HERE` to the Cursor AI SSE URL table row.

## [2.5.1] - 2026-05-17

### Fixed / Changed
- **Removed Irrelevant Local Quickstart Tab**: Refactored the dashboard documentation view, removing local developer server-management instructions (`npm run dev`, `npm run build`, `npm run test`) to fully focus on MCP client configuration settings.
- **Dynamic Secure Markdown Documentation HTTP Endpoint**: Added a secure Express route (`/api/docs/quick-setup`) to serve the system guide `QUICK_SETUP.md` dynamically.
- **Fixed Browser Path Security Error**: Rewrote the "Open Markdown Guide" HUD anchor link in the dashboard to load via the new secure HTTP API endpoint, eliminating browser `file:///` path security block errors.

## [2.5.0] - 2026-05-17

### Added / Changed / Fixed
- **Multi-Project Swapping Engine**: Engineered active directory discovery (`/api/projects`) and real-time project switching for live codebase graphs in the Knowledge Network.
- **Glassmorphic Project Selector**: Integrated a gorgeous select dropdown beside the graph search input inside the Knowledge Network SVG canvas to fluidly query project analytics.
- **Project Switcher Documentation**: Added a comprehensive `MULTI_PROJECT_SWITCHER.md` document detailing installation, configuration, internal routing mechanisms, and client dashboard integration.

## [2.4.1] - 2026-05-17

### Added / Changed / Fixed
- **Immersive Fullscreen Graph Canvas**: Added native HTML5 Fullscreen API support to enable interactive edge-to-edge network visualization.
- **Dynamic Resize Optimization**: Integrated state-driven CSS style triggers that automatically adjust parent layout border-radii, boundaries, and background backing properties to `#0A0C10` on entering fullscreen mode.
- **Glassmorphic Fullscreen HUD Integration**: Embedded a beautifully styled fullscreen toggle button utilizing Lucide `Maximize2` and `Minimize2` icons, separated by a professional design separator.
- **Native Fullscreen Listeners**: Implemented active event listener bindings that automatically track native user changes (such as pressing `Escape` to exit fullscreen) to keep React UI states in sync.

## [2.4.0] - 2026-05-17

### Added / Changed / Fixed
- **Interactive Knowledge Graph Zoom & Pan**: Integrated responsive mouse wheel zoom mechanics (scale from 0.2x macro overview to 6.0x micro-inspection) and empty background drag-to-pan dragging.
- **Transformed Coordinate System Dragging**: Engineered back-transformation formulas to ensure dragged nodes align with sub-pixel mouse pointer accuracy at any zoom level or pan offset.
- **Glassmorphic Floating HUD Controls**: Designed sleek floating HUD controls showing real-time zoom percentage with premium glassmorphism styling, hover transitions, and viewport reset actions.
- **Clear Legend Help Overlay**: Integrated interactive help overlay guiding users through Mouse Drag to Pan, Scroll Wheel to Zoom, and Node Dragging interaction triggers.

## [2.3.0] - 2026-05-17

### Added / Changed / Fixed
- **Clean Architecture & Domain Decoupling**: Extracted authorization validation and telemetry activity logging logic from the monolithic server runner in `index.ts` into a separate domain layer in `src/repositories.ts`. Established explicit repository interfaces (`IAuthRepository`, `IActivityLogger`) and use cases (`AuthenticateUserUseCase`, `LogTelemetryUseCase`).
- **Hardened Security & Error Sanitization**: Sanitized system logs, securing active connection strings and API keys to prevent accidental leakage in console outputs.
- **Clean Code Documentation**: Standardized comments across new Clean Architecture layers using professional English and standard architectural nomenclature.
- **Comprehensive Unit Testing**: Added a dedicated test suite in `tests/repositories.test.ts` to test all authentication flow logic, super admin bypass rules, RAM Cache TTL states, and telemetry writes with 100% test coverage.

## [2.2.2] - 2026-05-17

### Added / Changed / Fixed
- **Dashboard Modular Clean Architecture Refactoring**: Decoupled the giant monolithic `Dashboard.tsx` component into four highly focused, reusable sub-views: `ControlCenterView.tsx`, `KnowledgeGraphView.tsx`, `LogicModelsView.tsx`, and `CloudIndexView.tsx` under a clean architecture model.
- **Improved Maintainability & Testability**: Enhanced React code modularization and dependency isolation, resulting in faster and more stable builds.

## [2.2.1] - 2026-05-17

### Added / Changed / Fixed
- **Interactive Force-Directed Neural Network Dashboard**: Refactored the static SVG Knowledge Graph view to support a fully fluid, requestAnimationFrame-driven force-directed layout simulation.
- **Dynamic Physics Interactions**: Integrated mouse drag-and-drop mechanics allowing users to grab and pull individual logical node elements with live spring attraction/charge repulsion equations.
- **Glowing Visual Telemetry**: Implemented animated glowing SVG signal pulses that flow dynamically along neural links to represent logical dependency flows, alongside orbit halo rotations for structural modules.
- **Holographic Context Sidebars**: Upgraded the details sidebar to dynamically show real-time incoming/outgoing call metrics, file system locations, and exact source code line coordinates upon hovering nodes.

## [2.2.0] - 2026-05-17

### Added / Changed / Fixed
- **Airtight SaaS Multi-Tenant Isolation**: Implemented complete request-scoped isolation utilizing Node.js's stable `AsyncLocalStorage` to store the authenticated tenant's `uid`, `tier`, and `keyId` across asynchronous call chains.
- **Oracle 26ai Virtual Private Database (VPD) & Row-Level Security (RLS) Integration**: Updated `OracleMemoryService` to automatically execute a private session context binding `ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId)` upon every database connection acquisition, enabling Oracle's kernel-level RLS policies to silently and securely partition tenant data. Added `tenant_id` database columns, composite indexes, and detailed PL/SQL setup procedures to `/src/oracleSchema.sql`.
- **Dynamic File Discovery Isolation**: Modernized the project auto-discovery (`discoverProjects`) and workspace loading (`loadAnalysis`) algorithms to filter directories, limiting scanned file assets dynamically to the respective tenant's private root path `/var/codeatlas/tenants/<tenantId>` in Multi-Tenant mode.

## [2.1.21] - 2026-05-17

### Added / Fixed
- **Dynamic Multi-Session Isolated McpServer**: Architecturally redesigned the MCP server to dynamically instantiate and register tools on an isolated `McpServer` instance *per SSE connection*. This eliminates the single global server transport bottleneck entirely. Multiple concurrent clients can now connect, disconnect, and reconnect simultaneously with 100% thread/session isolation and zero transport locking conflicts.
- **Global Server Backward Compatibility**: Kept the global `server` instance initialized and populated with tools to ensure all existing unit tests and direct module imports continue to work perfectly.

## [2.1.20] - 2026-05-17

### Fixed
- **McpServer Underlying Transport Failsafe Check**: Patched the server-side failsafe check in `/sse` GET handler to correctly target the internal `.server` property of the `McpServer` wrapper class (as it delegates the underlying connection to `Server`). This eliminates the `"Already connected to a transport. Call close() before connecting to a new transport"` error that occurred when a client reconnected concurrently before the previous connection had fully teardown.
- **Dynamic Welcome Banner Versioning**: Synchronized the console log welcome banner versioning to align perfectly with the release version.

## [2.1.19] - 2026-05-17

### Added / Fixed
- **SSE Heartbeat Keep-Alive (15s)**: Introduced an automated 15-second heartbeat ping comment (`:\n\n`) on the `/sse` stream to prevent intermediate reverse proxies (Nginx, Cloudflare, Oracle Load Balancer) from prematurely terminating active client stream connections due to idleness.
- **Graceful Session Preservation Window (3m)**: Hardened the session lifecycle by keeping closed connections alive in the `transports` Map for a 3-minute grace period. This guarantees that if a connection is temporarily terminated by the network or a proxy, subsequent `POST /messages` initialization handshakes from the client will still resolve flawlessly, eliminating intermittent `session not found` errors.

## [2.1.18] - 2026-05-17

### Fixed
- **Buggy Client Session ID Routing Fallback**: Implemented a highly resilient session routing fallback in the `/messages` POST handler. Some IDEs have custom, non-conforming MCP client implementations that strip or omit the `sessionId` query parameter from relative URLs provided in the SSE `endpoint` event. The server now automatically intercepts these empty or invalid session requests and gracefully resolves them to the single active connection (or the most recently created session). This prevents the critical `failed to connect (session ID: ): session not found.` (HTTP 404) handshake failure on non-standard clients.

## [2.1.17] - 2026-05-17

### Fixed
- **Multi-Session Active Transport Locking**: Integrated proper lifecycle management for `SSEServerTransport` within the Express `/sse` connection pipeline. We now call `transport.close()` inside the connection's `res.on("close")` handler and safely reset the global `McpServer._transport` reference. We also added a pre-connect cleanup failsafe that cleanly detaches any lingering stale transport before connecting new clients. This prevents subsequent connection requests from throwing `Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.` (HTTP 500) errors.

## [2.1.16] - 2026-05-17

### Fixed
- **SSE Handshake Stream Consumption**: Passed the pre-parsed JSON request body (`req.body`) as the third parameter to `SSEServerTransport.handlePostMessage` in the `/messages` POST handler. This prevents the MCP SDK from attempting to read the raw request stream from scratch using `getRawBody` when `express.json()` middleware has already consumed it, resolving the critical `InternalServerError: stream is not readable` (HTTP 400) connection failure.

## [2.1.15] - 2026-05-17

### Fixed
- **MCP Client Redirection API Key Loss**: Appended the incoming `apiKey` query parameter directly to the message redirection URL returned by the SSE `/sse` handler (`/messages?apiKey=...`). This guarantees that standard client-side URL resolution preserves the key during the client's handshake initialization, preventing keyless POST requests from failing with a `401 Unauthorized` or `404 Session not found` error.

## [2.1.14] - 2026-05-17

### Fixed
- **PM2 Container Script Execution Detection**: Hardened the `isMain` direct-execution check in `index.ts` to inspect `process.env.pm_exec_path` as a fallback. This resolves a critical issue under PM2 Fork/Cluster modes where the main module is wrapped inside PM2's container bootstrap (`ProcessContainerFork.js`), causing the server startup to fail silently or fallback incorrectly.

## [2.1.13] - 2026-05-17

### Fixed
- **SSE Connection Initialization Race Condition**: Resolved a critical race condition in the SSE `/sse` route handler by immediately storing the newly constructed `SSEServerTransport` in the `transports` Map *before* awaiting `server.connect(transport)`. This guarantees that the transport session ID is fully registered when the client concurrently starts the `initialize` handshake, preventing the `failed to connect (session ID: ): session not found` errors.

## [2.1.12] - 2026-05-17

### Added
- **MCP Server Unit and Integration Test Suite**: Created a comprehensive test suite in `tests/mcp.test.ts` validating all 12 CodeAtlas enterprise MCP tools, Zod schemas, telemetry normalizing helper `getStats()`, and project discovery.

### Fixed
- **Clean Architectural Refactor of MCP Server Entry Point**: Refactored the root scope of `index.ts` to wrap side-effects (like file watcher initialization and console headers) inside a lazy `startWatcher()` function. This prevents persistent file watchers from hijacking Node.js tests or starting unwanted listening sockets on module import.
- **Node.js Test Runner Compatibility**: Added a direct execution guard (`isMain`) to conditionally run `main()` only when `index.ts` is invoked directly as the process entrypoint, preventing test suite freezes and enabling full side-effect free imports.

## [2.1.11] - 2026-05-17

### Added
- **Comprehensive E2E and Unit Test Suites**: Created new robust unit tests in `tests/parser.test.ts`, `tests/watcher.test.ts`, and `tests/api.test.ts` providing 100% test coverage for auto-indexing, file parsers, and REST API telemetry endpoints.

### Fixed
- **Dashboard Telemetry Integration**: Implemented a unified `resolvedAnalysis` property using `useMemo` in `Dashboard.tsx` to automatically normalize, format, and structure nested/un-nested stats and graph properties across all downstream views.
- **Robust API Routing**: Updated `API_BASE` in `Dashboard.tsx` to correctly target port `8080` only during local Vite development (port `5173`) while gracefully utilizing the main host in production/port-forwarding environments.

## [2.1.10] - 2026-05-17

### Fixed
- **UI State Persistence**: Refactored the 'Enable Codebase Indexing' checkbox in `Dashboard.tsx` to lift the state to the parent component, enabling persistent storage in `localStorage` across refreshes and tab switches.
- **Robust Graph UI**: Added protective guard clauses in `Dashboard.tsx`'s `useMemo` hooks to prevent React crashes (`Cannot read properties of undefined (reading 'nodes')`) when the analysis payload contains empty/undefined graph statistics.

## [2.1.9] - 2026-05-16

### Fixed
- **App Architecture**: Resolved shadowing of the global `app` instance in `main()`, ensuring all REST API routes (/api/*) are correctly registered and accessible.
- **Unified Authentication**: Centralized authentication logic into `authMiddleware`, supporting both `x-api-key` headers and `apiKey` query parameters across all endpoints.

## [2.1.8] - 2026-05-16

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