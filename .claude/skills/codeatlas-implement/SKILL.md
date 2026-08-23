---
name: codeatlas-implement
description: Implement a CodeAtlas change from discovery through tests and verification.
---

# CodeAtlas Implementation

1. Run `git status --short`.
2. Identify feature entry points with CodeAtlas MCP `trace_feature_flow` or `search_entities` when available.
3. Read related source, dependencies, and tests.
4. Choose the smallest change that satisfies the request.
5. Keep HTTP/MCP code in `src/presentation`, business logic in `src/services`, and persistence in `src/database` or repositories.
6. Use SQLite + `sqlite-vec` as default behavior. Do not make Oracle or PostgreSQL required for local work.
7. Add regression coverage for changed behavior.
8. Run:

   ```bash
   pnpm run build
   pnpm test
   ```

9. Review `git diff --check` and final diff.
10. Call `sync_system_memory` with a concise change description.

Do not reset, clean, stash, commit, push, or alter unrelated files. Report any unavailable or failing check.
## Pipeline verification gates (CI parity)

Features and refactors now ship through a strict CI pipeline. Match these gates locally before finishing so CI stays green:

- Root gates: `pnpm run typecheck`, `pnpm run build`, `pnpm test` (Node built-in test runner).
- Dashboard gates: `cd dashboard && pnpm run typecheck`, `pnpm run build`, `pnpm test` (vitest).
- Dashboard TypeScript is `strict: true` with `noFallthroughCasesInSwitch`. Unused-symbol checks (`noUnusedLocals`/`noUnusedParameters`) are intentionally off because pre-existing unused locals are widespread; do not re-enable them unless you also clean up every affected component.
- Dashboard tests require jsdom 29 and `undici@^7` (`pnpm-workspace.yaml` override is `undici: ^7.25.0`). Never pin undici below 7; jsdom 29 imports `undici/lib/handler/wrap-handler.js`, which does not exist in undici 6.
- CI security job runs `pnpm audit --prod --audit-level=high` and gitleaks with no `continue-on-error`. Never put key-shaped strings in tests or fixtures (e.g. `ca_test_key_12345` was caught by gitleaks); use innocuous placeholders like `test-token`.
- CI jobs: build (root + dashboard typecheck/build/tests), sqlite (`CODEATLAS_DB_TYPE=sqlite`, `CODEATLAS_SQLITE_PATH` under the workspace), security (audit + gitleaks). Workflow has concurrency cancellation and least-privilege permissions.
