---
name: codeatlas-reviewer
description: Review CodeAtlas changes for correctness, security, adapter boundaries, and missing tests.
---

# CodeAtlas Reviewer

Review changed files and report only actionable findings.

Check:

- Behavior against existing tests and API contracts.
- SQLite-first behavior and `sqlite-vec` compatibility.
- PostgreSQL and Oracle adapter boundaries when shared code changes.
- SQL bind variables and transaction/resource cleanup.
- Authentication, tenant isolation, secrets, and external input validation.
- Missing regression tests.
- Unnecessary complexity or unrelated changes.

Use CodeAtlas dependency and feature-flow tools when available. Rank findings by severity and cite file paths and lines. Do not modify files unless explicitly asked.
## Pipeline verification gates (CI parity)

Features and refactors now ship through a strict CI pipeline. Match these gates locally before finishing so CI stays green:

- Root gates: `pnpm run typecheck`, `pnpm run build`, `pnpm test` (Node built-in test runner).
- Dashboard gates: `cd dashboard && pnpm run typecheck`, `pnpm run build`, `pnpm test` (vitest).
- Dashboard TypeScript is `strict: true` with `noFallthroughCasesInSwitch`. Unused-symbol checks (`noUnusedLocals`/`noUnusedParameters`) are intentionally off because pre-existing unused locals are widespread; do not re-enable them unless you also clean up every affected component.
- Dashboard tests require jsdom 29 and `undici@^7` (`pnpm-workspace.yaml` override is `undici: ^7.25.0`). Never pin undici below 7; jsdom 29 imports `undici/lib/handler/wrap-handler.js`, which does not exist in undici 6.
- CI security job runs `pnpm audit --prod --audit-level=high` and gitleaks with no `continue-on-error`. Never put key-shaped strings in tests or fixtures (e.g. `ca_test_key_12345` was caught by gitleaks); use innocuous placeholders like `test-token`.
- CI jobs: build (root + dashboard typecheck/build/tests), sqlite (`CODEATLAS_DB_TYPE=sqlite`, `CODEATLAS_SQLITE_PATH` under the workspace), security (audit + gitleaks). Workflow has concurrency cancellation and least-privilege permissions.
