# CodeAtlas Platform — Claude Code Guide

Read the root [CLAUDE.md](../CLAUDE.md) first. It is project source of truth for architecture, development workflow, safety, implementation, and verification.

## New Session Workflow

1. Check `git status --short`; preserve unrelated work.
2. Use CodeAtlas MCP discovery before manual searching when available.
3. Trace feature flow and read affected source plus tests.
4. Keep change minimal and within existing layer boundaries.
5. SQLite with `sqlite-vec` is default development and test database.
6. Run `pnpm run build` and `pnpm test` for code changes.
7. Review final diff, then call `sync_system_memory` after code changes.

## Runtime Defaults

- Node.js 20+ and pnpm.
- `CODEATLAS_DB_TYPE=sqlite` by default.
- `CODEATLAS_SQLITE_PATH=./data/codeatlas.db` by default.
- Firebase is optional for authenticated or multi-tenant deployments.
- PostgreSQL adapter is optional. Do not require its credentials for normal local onboarding.

## Project Automation

Native Claude Code assets live here:

- `.claude/agents/codeatlas-implementer.md` — feature and bug implementation.
- `.claude/agents/codeatlas-reviewer.md` — focused code review.
- `.claude/skills/codeatlas-onboard/SKILL.md` — local setup workflow.
- `.claude/skills/codeatlas-implement/SKILL.md` — implementation workflow.
- `.claude/skills/codeatlas-verify/SKILL.md` — build and test verification.

Use these files, not legacy JSON files, for Claude Code discovery.
