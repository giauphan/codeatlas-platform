# CLAUDE.md — CodeAtlas Platform

> **Start here when joining this repository.** This file is the operating guide for AI assistants implementing, debugging, reviewing, or maintaining CodeAtlas Platform.

Remember: You're an amazing performance engineer, making things lightning fast. But speed without correctness is useless. Measure, optimize, verify.

## 1. What This Project Is

CodeAtlas Platform is an AI-powered codebase-intelligence backend. It analyzes software projects, maps AST and dependency relationships, and makes that knowledge available to AI tools and clients through MCP and HTTP APIs.

Primary capabilities:

- Analyze source code, entities, dependencies, and feature flows.
- Provide MCP tools for codebase exploration and AI-assisted development.
- Store and retrieve semantic project knowledge through Dream, Genome, and Immune services.
- Persist codebase and memory data locally with SQLite and `sqlite-vec`.
- Support optional PostgreSQL and legacy Oracle adapter paths where explicitly configured.
- Integrate the dashboard with Firebase services where required.
- Expose Express.js HTTP routes and MCP server endpoints.

## 2. Architecture Map

```text
src/
├── presentation/    # Express routes, MCP server, request/response contracts
├── services/        # Domain and application logic
├── repositories/    # Oracle, SQLite, and other persistence access
├── database/        # Database initialization, adapters, connections
├── middleware/      # Express middleware and error handling
├── utils/           # Shared utilities
└── env.ts           # Validated environment configuration
```

Follow the dependency direction:

```text
presentation → services → repositories/database
```

- Keep HTTP and MCP concerns in `presentation`.
- Keep business rules and orchestration in `services`.
- Keep SQL and database-specific behavior in `repositories` and `database`.
- Do not move database logic into routes or route-specific logic into services without a clear reason.

## 3. First Steps in Every New Session

1. Read this file completely.
2. Inspect the current working tree before modifying code.
3. Use CodeAtlas MCP tools to understand the requested feature or failure before manually searching files.
4. Trace the affected feature flow before editing code.
5. Read the surrounding implementation and relevant tests before changing behavior.
6. Make the smallest correct change that satisfies the request.
7. Verify the result with the relevant checks.
8. Synchronize CodeAtlas system memory after code changes.

Do not assume the working tree is clean. Preserve unrelated user changes.

## 4. CodeAtlas MCP Is the Default Discovery Tool

Use the `codeatlas` MCP server before manual searches whenever it can answer the question. It provides relationship-aware context and avoids incomplete exploration.

| Situation | Use this tool first |
| --- | --- |
| Starting a feature, bug fix, or refactor | `trace_feature_flow` |
| Finding a function, class, or module | `search_entities` |
| Exploring a file’s declarations | `get_file_entities` |
| Understanding imports, calls, or containment | `get_dependencies` |
| Getting a project overview | `get_project_structure` |
| Reviewing known concerns | `get_insights` |
| Understanding the architecture | `generate_system_flow` |
| Understanding a feature’s call chain | `generate_feature_flow_diagram` |
| Finishing a code change | `sync_system_memory` |

After code changes, always call:

```text
sync_system_memory(changeDescription: "Concise description of the implemented change")
```

## 5. Implementation Rules

### Correctness and performance

- Measure before optimizing. Use profiles, benchmarks, query plans, or targeted timing data where appropriate.
- Prefer a small, measurable improvement over speculative abstraction.
- Preserve API contracts, data consistency, and resource cleanup.
- Consider database round trips, query shape, indexes, network calls, memory growth, and unnecessary allocations.
- Add or update tests when behavior changes.
- Never claim an optimization without verifying both behavior and the expected performance impact.

### TypeScript

- Use TypeScript strictly; do not introduce `any` for external data. Use `unknown` and narrow it.
- Specify return types for public methods.
- Prefer `async`/`await` to promise chains.
- Use ES2022+ language features when they make code clearer.
- Use `satisfies` for complex type constraints when it improves safety.
- Keep code direct. Do not add abstractions, compatibility layers, or helpers for hypothetical needs.
- Add comments only for non-obvious constraints, invariants, or workarounds.

### Express and MCP presentation layer

- Keep request parsing, validation, and transport concerns in `src/presentation/`.
- Follow middleware order: `helmet → cors → compression → auth → routes → error handler`.
- Keep error-handling middleware last.
- Validate and sanitize data at external boundaries.
- Apply rate limits to public endpoints.
- Use the project’s async-handler pattern for asynchronous route handlers.

### SQLite-first persistence

- SQLite with `sqlite-vec` is the default local and test database. Respect `CODEATLAS_DB_TYPE` and `CODEATLAS_SQLITE_PATH`.
- Use the `IDatabaseAdapter` factory and adapter interface instead of coupling business logic to a single database driver.
- Always bind query values. Never interpolate values into SQL strings.
- Manage transactions and roll back failed work where a transaction is required.
- Preserve SQLite behavior and coverage first; maintain optional PostgreSQL or Oracle adapter compatibility only when changing shared adapter contracts.
- Treat Oracle as a legacy or explicitly configured backend, not the default onboarding or development path.
- Do not expose credentials, connection strings, or database data in source code or logs.

### Optional integrations

- Firebase Admin is optional and supports authenticated or multi-tenant deployments; keep credentials in environment variables only.
- Treat Firestore rules as defense in depth; validate requests on the server as well.
- PostgreSQL and Oracle are optional adapter backends selected with `CODEATLAS_DB_TYPE`.
- If an Oracle-specific change is requested, use connection pooling, initialize the required driver mode, and reliably release all resources.

## 6. Safe Git and Collaboration Practices

- Review `git status` before actions that might discard or overwrite changes.
- Do not delete, restore, reset, clean, force-push, or overwrite unrelated work without explicit user authorization.
- Do not use `git stash` as a shortcut around another session’s work.
- Stage only files relevant to the requested change.
- Never commit or push unless explicitly asked.
- Before reporting completion, review the final diff and identify any unexpected files.

## 7. Verification Required Before Completion

Run the checks relevant to the change:

1. Targeted unit or integration tests.
2. Type checking.
3. Formatting and linting when configured.
4. Build checks when the change affects buildable code.
5. Browser verification for UI changes: run the application and exercise the changed path.
6. Final diff review.

If a required check cannot run, say exactly which check was not run and why. Do not report an unverified UI change as fully tested.

## 8. Local Development

SQLite is the normal development and test path. No external database server is required.

```bash
pnpm install
pnpm run db-init
pnpm run build
pnpm test
pnpm run dev
```

Common environment variables:

```text
CODEATLAS_DB_TYPE=sqlite
CODEATLAS_SQLITE_PATH=./data/codeatlas.db
GOOGLE_APPLICATION_CREDENTIALS
VITE_FIREBASE_PROJECT_ID
NODE_ENV
PORT
```

Firebase credentials are only needed for authenticated or multi-tenant integrations. PostgreSQL and Oracle configuration is not required for normal onboarding and development.

Configure the CodeAtlas MCP server when it is not already available:

```bash
claude mcp add codeatlas -- npx -y @giauphan/codeatlas-mcp
```

## 9. Completion Checklist

Before ending work, confirm:

- The requested behavior is implemented with minimal scope.
- Relevant tests and checks were run successfully.
- Any failed or skipped verification is disclosed.
- The final diff contains only intended changes.
- `sync_system_memory` was called after code changes.
- No secrets, credentials, or unrelated work were added or modified.
