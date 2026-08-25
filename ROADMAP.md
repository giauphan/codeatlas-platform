# Roadmap

This document tracks planned work for CodeAtlas Platform. Items move from **Planned** → **In Progress** → **Shipped**. Dates are tentative and may shift based on community feedback and contributions.

## Shipped

- **v2.14.x** — Multi-tenant isolation, SQLite + sqlite-vec migration, MCP SSE transport, Dream Memory with scope/tags/related_ids, SESSION_SUMMARY type, brain-context.sh auto-load, A2A orchestration.
- **Public repository optimization** — `files` field in package.json, `.npmignore`, rewritten README/CONTRIBUTING, new DEVELOPMENT/DEPLOYMENT/API_EXAMPLES/CONFIGURATION docs, CODE_OF_CONDUCT, Dockerfile, docker-compose, `.gitignore` hardening, PAT removal from git remote.

## In Progress

- **CI hardening** — Add eslint, coverage gate, `pnpm audit`, dependency review action.
- **Canonical naming** — Consolidate `codeatlas-platform` (repo) vs `codeatlas-ai` (npm package) vs `codeatlas-enterprise` (legacy client reference).

## Planned

### Near-term (next quarter)

- **PostgreSQL backend support** — Optional DB backend alongside the SQLite default. Abstracts `dreamingService` behind a DB-agnostic interface.
- **Docker image publishing** — Publish to GitHub Container Registry on release tags. Multi-arch (amd64 + arm64).
- **OpenAPI spec export** — Generate OpenAPI 3.1 document from REST routes for client SDK generation.
- **MCP tool versioning** — Version MCP tool schemas so clients can negotiate capabilities.
- **Observability** — Structured logging to stdout in JSON, Prometheus `/metrics` endpoint, OpenTelemetry traces.

### Medium-term

- **Plugin system** — Allow third-party MCP tools to register via a plugin manifest.
- **Webhook delivery** — Notify external systems on dream memory save, consolidation run, immune scan.
- **RBAC** — Role-based access control beyond user/admin (e.g., `reader`, `writer`, `auditor`).
- **Backup/restore** — CLI tool to export/import dream memories and genome data.

### Long-term

- **Multi-region** — Active-active deployment across PostgreSQL regions with cross-region sync.
- **Streaming AST analysis** — Incremental indexing via file-watch events instead of full re-scan.
- **Skill marketplace** — Public registry for CodeAtlas skills (install/publish/version).

## Contributing to the roadmap

Open a [discussion](https://github.com/giauphan/codeatlas-platform/discussions) with the `roadmap` label to propose new items. Large changes should reference a GitHub issue with clear scope and acceptance criteria.

Items without a maintainer or community contributor assigned may stay in Planned indefinitely.
