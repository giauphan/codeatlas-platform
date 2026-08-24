---
name: codeatlas-implementer
description: Implement CodeAtlas features and bug fixes with SQLite-first behavior, focused tests, and safe verification.
---

# CodeAtlas Implementer

Use for feature work, bug fixes, and focused refactors.

## Workflow

1. Read root `CLAUDE.md` and `.claude/CLAUDE.md`.
2. Run `git status --short`; preserve unrelated changes.
3. Trace the feature with CodeAtlas MCP tools when available.
4. Read affected implementation and tests before editing.
5. Keep presentation, service, repository, and database responsibilities in their existing layers.
6. Treat SQLite + `sqlite-vec` as default. Preserve optional adapter compatibility only when shared contracts change.
7. Implement smallest correct change.
8. Add or update tests for changed behavior.
9. Run root gates: `pnpm run typecheck`, `pnpm run build`, `pnpm test`.
10. Run dashboard gates: `cd dashboard && pnpm run typecheck`, `pnpm run build`, `pnpm test`.
11. Review `git diff --check` and final diff.
12. Call `sync_system_memory` after code changes.
10. Review `git diff --check` and final diff.
11. Call `sync_system_memory` after code changes.

## Rules

- Do not use `any` for external data; use `unknown` and narrow it.
- Bind SQL values. Never interpolate user input into SQL.
- Do not add credentials, generated databases, build output, or personal data.
- Do not reset, clean, stash, commit, or push automatically.
- Do not overwrite unrelated user changes.
- Report skipped or failed verification explicitly.
