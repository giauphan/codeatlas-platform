# Memory Pipeline Remediation Implementation Plan

> **For agentic workers:** Execute the supplied remediation plan task by task using isolated file ownership, regression tests, and verification before completion.

**Goal:** Repair capture, durable ingestion, scoped retrieval, automatic checkpoint restoration, evidence-grounded extraction, and scheduling across both repositories.

**Architecture:** Retain existing services and storage adapters. Extend the HTTP contract compatibly with explicit acknowledgements, tenant-scoped identity and durable receipts/checkpoints/job records. Claude hooks share one native capture implementation; the shell adapters delegate to it.

**Tech Stack:** TypeScript, Node.js, Express, SQLite/sqlite-vec, optional PostgreSQL, Claude lifecycle hooks.

**Requested source specs:** `CODEATLAS_MEMORY_PIPELINE_ROOT_CAUSE_REPORT.md`, `CODEATLAS_REMEDIATION_IMPLEMENTATION_PLAN.md`, and `CODEATLAS_REGRESSION_TEST_MATRIX.md`. These named files were not present in either checkout or the searched accessible `/home/ubuntu` and `/tmp` trees. This execution tracker records the available code evidence, regression disposition and release gates; exact document-by-document signoff cannot be asserted until those source specs are available.

## Global constraints

- Preserve current MCP/code-analysis behavior, existing user hooks/permissions, legacy API consumers and storage.
- Ordinary tests use disposable HOME, API credentials and databases. Explicitly approved live canaries may write unique synthetic events only to the selected target and must preserve their result evidence.
- No raw secrets, transcripts or tool responses in diagnostic logs.
- Fail open for the host while reporting precise capture/retrieval outcomes.
- No completion or rollout claim without observed evidence; external runtime checks remain explicit blockers when unavailable.
- Do not commit, push or deploy as part of implementation. Any selected-host configuration change requires a protected preview, backup and preserved unrelated settings.

## Execution and verification ledger

This file tracks execution of the existing detailed plan; it does not replace or weaken its acceptance criteria. For every behavior, reproduce the break in a focused test before applying the fix, then run the test again. Record exact commands/results in `docs/MEMORY_PIPELINE_REMEDIATION_RESULTS.md`.

- [x] **Phase 0:** Record branch/SHA/toolchain/executable/build hash; add safe hook and backend diagnostics and native event fixtures. Gate: event trace ID visible without content. Files: MCP CLI/diagnostics and platform Dream diagnostics; tests HC-006–010, privacy.
- [x] **Phase 1:** Platform typed ACK/idempotency extension, then MCP hook decoder/transport/config precedence, then compiled smoke. Files: both dreaming services, platform Dream routes, MCP CLI/entrypoint; tests HC-001–021. Gate: executable capture -> durable ID -> same-project query.
- [x] **Phase 2:** Durable per-session spool/cursor, exact transcript validation, replay-safe batch receipts, shell compatibility bridge, progress/compact checkpoints. Files: MCP capture modules/hooks and platform ingest service/routes; tests SH-001–014. Gate: 7->8->9->50 without loss, replay without duplicates, no cursor advance on failure.
- [x] **Phase 3:** Canonical tenant/project identity and audit mapping, candidate-scoped vector filtering, lexical fallback, typed retrieval outcomes. Files: identity helpers, both Dream services, database adapters/routes; tests RT-001–016. Gate: other projects cannot crowd out or leak into requested project.
- [x] **Phase 4:** Durable checkpoint APIs and deterministic startup; task-specific prompt context with suppression; unified installer; explicit host delivery. Files: checkpoint service/routes, MCP context composer/installer/hooks/MCP tools; tests DR-013–015, SH-015, RT-006–007. Gate verified by the compiled acceptance suite and two real Claude sessions: new-session startup includes prior checkpoint and cites sources, with explicit empty/error states.
- [x] **Phase 5:** Structured evidence/provenance, validated optional LLM output and deterministic fallback, multilingual fixture evaluation, supersession and privacy. Files: extraction module, llmService, pipeline, memory persistence; tests DR-001–012 plus 40+ labelled fixtures. Gate: measured baseline and first blind assessment preserved; all five deterministic regression gates and both configured-model profiles pass unchanged selected thresholds with zero grounding/privacy violations. Final source hash and per-kind limits are recorded in the evaluation/results reports.
- [x] **Phase 6:** Separate reconciliation and consolidation, durable unique job claims/leases, full cron/timezone validation, restart/retry policy, semantic success. Files: job ledger/scheduler, HTTP startup/cron settings, pipeline; tests CR-001–010. Gate: real SQLite failures stay retryable and successes persist an audit record; crash replay and fencing tests pass. Private PostgreSQL 14.24/pgvector 0.8.7 probes also passed initialization, scoped uniqueness/vector search, restart ordering, persisted ledger and fencing, plus a two-adapter slot race, expired lease reclaim and stale-owner rejection across server restart.
- [x] **Phase 7:** Selected-target capture/replay, Stop reconciliation, retrieval, cross-project isolation and fresh SessionStart passed in the live runtime canary. Two fresh Claude sessions passed the actual restore check. The backed-up global lifecycle hooks and six reachable project context opt-ins are installed; three missing roots remain unavailable. MCP and platform build/type/test gates pass, including 558/558 platform tests with all deterministic quality flags enabled and no skips. The resident API reloaded the canonical-scope fix; its scheduler ledger records three post-reload runs, all for the selected tenant/canonical project. Reconciliation completed twice with zero failures; consolidation processed eight canonical rows, merged none, created two concepts, and archived/superseded none. The dedicated cron is enabled at five-minute reconciliation and daily 19:00 UTC consolidation; shared legacy scheduling remains disabled. Production p95/p99 latency remains unmeasured. The missing source specs and database/filesystem test incidents are disclosed in the results report.

## Contract coordination

Platform accepts legacy requests before the client sends extensions. A save ACK uses `status: stored|duplicate|filtered|rejected|error`, `persisted`, and an actual `id`/`memory_id` only for stored or duplicate records. Client compatibility with legacy success requires a real non-sentinel ID. Stable idempotency keys are tenant/project scoped and retained before dispatch. Filtered events are explicitly accounted, never counted as persisted.

New hook identity uses `project_id`, `display_name`, `workspace_path`; legacy `project` remains accepted. Worktrees/symlinks resolve to the same repository identity; ambiguous aliases never merge two projects. Retrieval filters tenant/project/type/scope/tags before candidate cutoff. Checkpoint bootstrap is independent from semantic query.

## Verification commands

MCP: `npm test`, `npm run lint`, `npm run build`, `npm run verify-build`, `npm run validate:hooks` under disposable configuration where required.

Platform: `npm test`, `npm run typecheck`, `npm run build`; dashboard checks if dashboard changes are necessary.

Cross-repository: actual built CLI stdin -> authenticated disposable Express API -> real SQLite adapter -> query exact ID -> checkpoint -> fresh SessionStart output; repeat delivery and transport failure; assert isolation and redaction. Capture resolved CLI realpath and SHA256.

## Open release gates

Phase 5 passes locally. The user delegated selection of precision >=0.85, recall >=0.75 and per-language recall >=0.70 after baseline measurement, with zero grounding and sensitive-content violations. No gates or fixtures were changed during the final remediation. All five deterministic splits pass (70/70 focused checks); both actual configured-model profiles pass on extractor SHA256 `938a483a7c4736ca404d99700dfdaaf855f3bcaeed87a288bf0352cadd090668`: adjudicated precision/recall 0.946/1.000 and final authored regression 0.900/0.900. The first blind model score remains 0.900/0.900; inspected corpora are now regressions, and earlier failures remain preserved. Per-kind errors and final-corpus Vietnamese fallback recall at the 0.70 boundary remain visible.

The selected-target runtime canary passed end to end, and two fresh Claude sessions verified automatic restore without putting the acceptance token in the second prompt. The backed-up global hook settings and six reachable project context opt-ins are installed; hook validation passed 17/17. Full platform verification passed 558/558 tests with all deterministic quality flags and no skips; typecheck and build passed. The compiled cross-repository suite passed 11 tests with one expected live-Claude case skipped because that live case was run separately. MCP verification passed build, lint, manifest verification, hook validation (17/17) and 247/247 tests. The resident API reloaded the corrected scheduler and the ledger confirms a completed consolidation for the exact canonical project. Daily consolidation and five-minute reconciliation are enabled for that selected tenant/project; shared legacy scheduling remains disabled. The prior unscoped and display-alias runs, their uncertain item-level side effects, and the no-speculative-rollback decision are recorded in the results report. Production p95/p99 latency and exact signoff against the missing named source specs remain unverified. The report also records earlier database startup writes, possible activity-log deletions, auth metadata access and the filesystem fixture issue; no speculative restoration was attempted.
