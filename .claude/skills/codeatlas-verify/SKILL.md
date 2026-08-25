---
name: codeatlas-verify
description: Run CodeAtlas build, tests, and final diff checks.
---

# CodeAtlas Verification

Run checks relevant to changed code:

```bash
pnpm run build
pnpm test
git diff --check
git status --short
```

For dashboard changes, also run from `dashboard/`:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

Do not claim success if a check fails or was skipped. Do not modify unrelated files while fixing verification failures.
## Pipeline verification gates (CI parity)

Features and refactors now ship through a strict CI pipeline. Match these gates locally before finishing so CI stays green:

- Root gates: `pnpm run typecheck`, `pnpm run build`, `pnpm test` (Node built-in test runner).
- Dashboard gates: `cd dashboard && pnpm run typecheck`, `pnpm run build`, `pnpm test` (vitest).
- Dashboard TypeScript is `strict: true` with `noFallthroughCasesInSwitch`. Unused-symbol checks (`noUnusedLocals`/`noUnusedParameters`) are intentionally off because pre-existing unused locals are widespread; do not re-enable them unless you also clean up every affected component.
- Dashboard tests require jsdom 29 and `undici@^7` (`pnpm-workspace.yaml` override is `undici: ^7.25.0`). Never pin undici below 7; jsdom 29 imports `undici/lib/handler/wrap-handler.js`, which does not exist in undici 6.
- CI security job runs `pnpm audit --prod --audit-level=high` and gitleaks with no `continue-on-error`. Never put key-shaped strings in tests or fixtures (e.g. `ca_test_key_12345` was caught by gitleaks); use innocuous placeholders like `test-token`.
- CI jobs: build (root + dashboard typecheck/build/tests), sqlite (`CODEATLAS_DB_TYPE=sqlite`, `CODEATLAS_SQLITE_PATH` under the workspace), context-hygiene (`tests/unit/context-hygiene.test.ts`), security (audit + gitleaks). Workflow has concurrency cancellation and least-privilege permissions.

## Context-hygiene gate

A strict CI job (`context-hygiene`) runs `tests/unit/context-hygiene.test.ts` in isolation. It guards the retrieval inject-gate — the last filter before Second Brain memories reach a Claude prompt — against the content that previously leaked into live sessions.

- The blocklist (`src/services/noiseBlocklist.ts`) is consumed by `queryDreamMemories` via `filterNoiseRows`; that is what keeps polluting memories out of context.
- When adding or changing blocklist patterns, extend the corpus in `context-hygiene.test.ts`: polluters (english-study, weather, shopping/grocery, lifestyle, scheduler-retry) must stay blocked AND genuine engineering memories must stay allowed. A "block everything" change must fail the allow-half.
- The noise arrived through the `brain-context.sh` UserPromptSubmit hook (in `~/.claude/` and the MCP-server repo), which is outside this repo's CI. This gate covers the server-side filter, not the hook config.

## Unit testing practices

Reference: https://aws.amazon.com/what-is/unit-testing/

Write unit tests around behavior, not implementation:
- Structure each test as Arrange – Act – Assert (AAA).
- Test one behavior per test and name it from the behavior, not the function ("returns 400 for an invalid API key", not "testCreateKey").
- Keep tests isolated and deterministic: mock external boundaries (database, network, time, crypto). Root uses Node's built-in runner with `mock.module`; the dashboard uses vitest + @testing-library/react.
- Prefer asserting observable outcomes (return values, rendered text, called side effects) over internal calls.
- Fix the bug and add its regression test in the same change; a passing test that would have failed before the fix is what earns coverage.
- New suites must be picked up by the existing runners: root `tests/**/*.test.ts` (run with `pnpm test`), dashboard `**/*.test.ts?(x)` (run with `cd dashboard && pnpm test`).
- Never commit flaky, empty, or skipped-to-pass tests. CI is fail-fast; a broken suite blocks the pipeline.
