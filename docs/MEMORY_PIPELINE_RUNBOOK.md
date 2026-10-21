# Memory pipeline operations

This runbook accompanies `MEMORY_PIPELINE_REMEDIATION_RESULTS.md`. Source fixes, compiled artifacts, host hook delivery, meaningful memory extraction and production rollout are separate checks. A hook exit code of zero is a host usability guarantee, not proof of memory persistence.

Current selected-target status: all five deterministic bilingual regression gates and both configured-model profiles pass on the final source hash recorded in the results document. The runtime canary and two fresh Claude sessions passed, the global lifecycle hooks plus six reachable project context opt-ins are installed, and a canonical-project scheduled consolidation completed after the resident API reloaded the fix. The dedicated scheduler is enabled for the selected tenant/project: reconciliation every five minutes and consolidation daily at 19:00 UTC. The shared legacy scheduler remains disabled. Earlier failures, the display-alias scope incident and limited-corpus/per-kind errors remain visible. Broad production rollout and production latency acceptance remain pending; capture, storage and hook checks do not replace extraction quality checks.

## Build and verify

From `codeatlas-mcp-server`, run:

```bash
npm run build
npm run lint
npm test
npm run verify-build
```

The build writes `dist/build-manifest.json` with source and runtime artifact hashes. Verification rejects stale source, changed compiled files, test files and TypeScript sources in the package. Compare the complete manifest as well as `dist/index.js`; changing an imported CLI module need not change the entrypoint hash.

From `codeatlas-platform`, run:

```bash
npm run typecheck
npm run build
npm test
npm run test:memory-pipeline
npm run test:memory-quality
```

`npm test` creates disposable HOME, SQLite, project and temporary directories before loading application code. It uses synthetic service configuration, excludes operator credentials and blocks dotenv from restoring provider/database settings. It removes disposable files and forwards the test result. Earlier unisolated runs accessed the default local database and wrote system startup records; the results report records that incident. Run the complete deterministic suite without opt-in skips with:

```bash
RUN_MEMORY_EXTRACTION_HOLDOUT=1 RUN_MEMORY_EXTRACTION_INDEPENDENT=1 RUN_MEMORY_EXTRACTION_RELEASE=1 RUN_MEMORY_EXTRACTION_FINAL=1 npm test
node --experimental-test-module-mocks --test-concurrency=1 --import tsx --test tests/cross-repo/memory-quality-telemetry.acceptance.ts
```

The telemetry test reports a synthetic lexical-retrieval baseline with explicit denominators, including MRR, checkpoint completeness, duplicate rows and bootstrap hit rate. Context bytes are a size proxy; actual token counts and production rates require separate measurement.

The cross-repository test requires the built sibling MCP repository, or `CODEATLAS_MCP_REPO` pointing at it. It starts authenticated Express routes and a disposable SQLite database with temporary HOME and synthetic credentials. It never uses the operator database. The real-host test is explicit:

```bash
CODEATLAS_LIVE_HOST_TEST=1 node --import tsx --test --test-name-pattern='live Claude' tests/cross-repo/compiled-memory-pipeline.acceptance.ts
```

That canary requires the installed Claude CLI and working provider authentication. It carries only provider authentication/model mappings from the trusted host settings in memory; it does not load operator hooks or copy credentials into fixtures. `CODEATLAS_LIVE_HOST_MODEL` can select a model supported by that provider. It uses isolated Claude settings and two fresh sessions; the second prompt does not contain the first session's acceptance token. It has a provider spending limit. A failed authentication/provider run must be reported separately from a passing executable/API fixture run.

For the selected live rollout, the API is `http://localhost:3381` and the project is this checkout. Keep the 54321 legacy API out of hook routing. The Phase 7 backup is `/home/ubuntu/.codeatlas/backups/memory-pipeline-phase7-O9QVny`; its restore was checked in isolation. The dedicated cron settings file is `/home/ubuntu/.codeatlas/cron/codeatlas-platform-memory-pipeline.json`; it is tenant/canonical-project scoped, reconciliation is enabled every five minutes, and consolidation is enabled daily at 19:00 UTC. Shared legacy cron settings remain disabled. The selected-target runtime canary, two-session real Claude restore and corrected scheduled consolidation have passed. Check the live API and scheduler ledger after code changes; a settings GET confirms the config, while the ledger verifies which scope actually ran. Pause the affected job if its scope or semantic result is unexpected.

The selected scope is the six reachable configured project roots. Leave the three missing configured paths reported as unavailable, and do not fabricate directories or claim their context was installed. The 74 historical database scopes are existing tenant data and do not determine hook rollout scope. The 20-second hook budget is a measured direct CLI completion bound for the synthetic canary, not a production p95/p99 promise; provider inference/session time and intentional process-kill recovery are excluded.

The successful live runtime canary is `scripts/memory-pipeline-runtime-canary.mjs`; its protected result is `/tmp/codeatlas-phase7-live-canary-final-5-20261020/result.json`. A rerun requires the explicit `CODEATLAS_MEMORY_RUNTIME_CANARY=1` opt-in, the selected loopback API, exact derived project ID, the platform SQLite file as a read-only comparison source, and a new protected result path under the OS temporary directory. Supply the API key through the process environment without placing it in shell history or logs. It writes unique synthetic events to the selected project and must refuse if other project events are pending. Preserve the result metadata and inspect capture ACK, replay, Stop reconciliation, exact retrieval, other-project isolation and fresh SessionStart. Avoid unnecessary reruns because each successful run adds synthetic source/checkpoint rows.

The completed live runtime canary passed tool capture and exact replay, Stop-hook completion, exact checkpoint reconciliation, same-project retrieval, other-project isolation, and fresh SessionStart context delivery with source IDs. The actual two-session Claude acceptance also passed: the second prompt omitted the first session's synthetic receipt and the second response restored it from startup context. Its isolated run used two fresh sessions with a $1 per-session spend cap. The report records exact results and timing. These selected-target checks do not measure production p95/p99 latency or establish broad rollout readiness.

The successful two-session run used `scripts/memory-pipeline-claude-two-session-acceptance.mjs`. It requires the explicit `CODEATLAS_MEMORY_CLAUDE_TWO_SESSION_ACCEPTANCE=1` opt-in, the selected project/API identity, a read-only database preflight, provider authentication from trusted environment/Claude settings, and a new synthetic acceptance run. It installs hooks only in an isolated temporary Claude home. It reconciles and persists synthetic source/checkpoint data in the selected project; avoid rerunning without a new reason and an appropriate preflight.

The scheduler carries canonical project IDs separately from display names through the route, pipeline, all four consolidation operations and retries. Concepts also carry nullable `project_id`; old NULL-ID rows are left untouched by canonical scheduled runs unless a separate ownership map is approved and applied. The resident local `tsx watch` process restarted from the corrected source and the ledger recorded the selected-scope consolidation and reconciliation runs. Do not start a second server to reload it: an earlier duplicate `tsx watch` initialized the configured database before failing to bind. Do not remove or rewrite memory records in response to the earlier unscoped/display-alias runs; their effects and the lack of speculative rollback are documented in the results report.

## Host configuration and migration

Use one native installer after building the MCP package. The `setup:hooks` script and CLI setup path must use the same hook configuration implementation. Check the generated settings before applying them to a real installation. Preserve unrelated matcher groups, plugin commands and every existing deny permission. No operational step in this remediation removes tool deny rules.

Native hooks cover `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `PreCompact`. Context output uses the host's `hookSpecificOutput.additionalContext` contract where supported. Stop records a turn checkpoint; it is not treated as the only end-of-session signal. Shell entrypoints forward to the same native capture implementation; do not install both independent implementations.

Resolve the actual executable in the exact Claude environment:

```bash
command -v codeatlas
readlink -f "$(command -v codeatlas)"
codeatlas doctor hooks --json
```

Doctor reports configuration presence, executable resolution, registration, canonical identity and recent outcome codes. Do not paste API keys or raw memory/transcript dumps into incident reports. Explicit process environment takes precedence over supported environment files. Supply service credentials through the environment or private configuration, not command-line arguments.

Set `CODEATLAS_INJECT_BRAIN_CONTEXT=1` only in a trusted project configuration to enable historical context delivery. Retrieved text is labelled untrusted historical evidence with source IDs. It never authorizes executing an old command or supersedes the present user's task.

## Identity and durability

`project_id` is distinct from the display name and workspace path. The native adapter derives a stable local repository identity from the real Git common directory/root; worktrees and symlink aliases share it. Two unrelated repositories with the same basename keep separate IDs. `CODEATLAS_PROJECT_ID` is an explicit validated override. The backend registers aliases within the authenticated tenant and audits collisions; conflicting aliases are not silently reassigned.

Capture writes a private per-project/per-session local spool before dispatch. Inbox manifests preserve events even while another process owns that session's queue lock. Exact transcript paths are validated against the authorized Claude project/session. The adapter never borrows another session's newest JSONL. Only complete JSONL records are consumed; incomplete tails, rotation and truncation remain recoverable.

A source event ACK says the redacted evidence is durable. `source_persisted: true` and `extraction_status: pending` do not mean that a meaningful memory was extracted. Memory save ACKs distinguish `stored`, `duplicate`, `filtered`, `rejected` and `error`; only real persisted/duplicate memory outcomes expose memory IDs. Filtering is counted explicitly.

The client keeps two transcript cursors. `readCursor` advances after transcript batches are written to the durable local inbox and merged into the pending spool, allowing later hooks to continue reading while the service is unavailable. The delivery/ACK `cursor` advances only after events are acknowledged and no unresolved poison event blocks it. Durable inbox manifests and stable event IDs make a crash between local read and dispatch replayable without dropping events or creating duplicate source rows. A permanent rejection or mismatched ACK is moved to a private, secret-redacted quarantine; later events may drain, but the ACK cursor remains behind that unresolved gap. Permanent rejects do not retry automatically. Preserve and investigate quarantine before any manual repair or replay. Retryable transport/server errors use exponential backoff from 250 ms, capped at 15 minutes; each drain handles at most 50 events.

Extraction model receipts are durable per tenant, project, checkpoint marker, extractor version and source hash. A replay with identical inputs reuses its validated receipt instead of calling the model again. An empty model response `[]` is authoritative and extracts no memories. For nonempty output, if at least one candidate passes strict grounding, the resulting `valid[]` set is authoritative for that checkpoint batch; unselected model-derived memories are retired. If every candidate is invalid, or generation/receipt validation fails, extraction falls back to the deterministic path. Receipt and evidence keys make partial writes replay-safe. Changed source evidence or an extractor version uses a different receipt key. Keep existing receipts and provenance during rollback so retries do not silently become fresh model decisions.

After release, changes to the extraction contract or interpretation require an extractor-version change in addition to regression checks; changing only the prompt must not silently reuse an old model decision receipt. `CODEATLAS_STRUCTURED_MEMORY_EXTRACTION=false` selects compatible legacy classification for the legacy transcript summarization entrypoint. Native reconciliation remains the evidence-backed worker; pause it with `CODEATLAS_MEMORY_PROCESSING_ENABLED=false` while investigating rather than assuming the transcript compatibility flag disables every native path.

Do not delete the local spool or receipts to fix a network error. Restore connectivity/credentials, then invoke a supported hook/progress flush so pending records can retry. `CODEATLAS_DURABLE_CAPTURE=0` pauses dispatch while retaining queued evidence; do not restore the old rolling-eight-message shell implementation as a rollback.

## Checkpoints, extraction and retrieval

`GET /api/dreams/checkpoints/latest?project_id=...` returns deterministic, authenticated project progress without requiring a user prompt or an embedding match. Checkpoints cite source events/sessions. Completed steps require successful tool evidence; assistant completion claims alone do not become verified outcomes. Explicit checkpoint writes reject claims unsupported by their cited same-project evidence. Empty markers remain empty memory.

Task retrieval is separate from startup bootstrap. Semantic candidates are filtered by tenant, project, type, provider, status, scope and tags before the candidate limit. Lexical/exact path matching remains available during embedding outages. Distinguish genuine empty memory, no matching item, context filtering, authentication failure and backend/transport failure. Do not interpret an error as an empty database.

Structured extraction preserves session checkpoints, decisions, facts, mistakes, fixes, preferences, task status and open questions with quoted source spans, event IDs, role, confidence and certainty. Model output must pass grounding validation; unsupported claims fall back to deterministic extraction. Evaluate the development fixtures separately from the sealed held-out fixtures and publish raw counts alongside precision/recall. A small labelled corpus does not establish universal language quality.

The deterministic fallback passes the measured quality targets without a provider. On the final authored regression set it scored precision/recall 0.895/0.850, with Vietnamese recall at the 0.70 boundary. The configured checkpoint model scored 0.946/1.000 on the adjudicated set and 0.900/0.900 on the final authored set. All had zero grounding/secret violations. These are small synthetic regressions; preserve earlier failures, the original blind assessment and per-kind errors when assessing a deployment. Broad rollout still requires a production canary.

Configure `CODEATLAS_MEMORY_EXTRACTION_URL` as a complete compatible chat-completions endpoint, `CODEATLAS_MEMORY_EXTRACTION_MODEL`, and optional `CODEATLAS_MEMORY_EXTRACTION_API_KEY` through private environment configuration. Requests contain only bounded, redacted source/checkpoint data. The JEV `systemone` numeric `noul` example is a different protocol and is not accepted as a chat-completions extraction endpoint.

With explicit provider configuration, run `npm run test:memory-quality:model:final` for the final independently authored corpus, and `npm run test:memory-quality:model` for the adjudicated regression corpus. Provider errors invalidate the model measurement; they are not counted as passing fallback quality. The optional `CODEATLAS_MODEL_QUALITY_SNAPSHOT` path writes only synthetic redacted candidates and provenance hashes with mode 0600. No benchmark reads operator transcripts or a production memory database. Corpus selectors are limited to `rawrelease`, `adjudicated`, and `final-unseen` (also `finalunseen`).

Host traces record capture receipts, bootstrap attempts, actual successful packet delivery and duration. `doctor hooks --json` aggregates the last 200 trace records; those totals are a recent observation window, not all-time durable metrics. Backend admin diagnostics expose numeric capture, reconciliation, lag, retrieval and scheduler counters. These counters reset with the process; durable source receipts and job ledgers are the restart audit. Backend retrieval never increments host injection as if delivery had occurred.

## Scheduling and recovery

Reconciliation processes durable pending source events; consolidation deduplicates and scores existing memories. Configure the two jobs separately. Set `CODEATLAS_MEMORY_PROCESSING_ENABLED=false` to pause extraction/reconciliation; pending source rows remain pending and are eligible after processing is re-enabled. Existing cron settings remain readable, including the original `dreams_schedule`, `dreams_enabled` and `dreams_provider` fields. New settings include an explicit IANA `timezone` and separate reconciliation fields. Default scheduling timezone is UTC; choose `Asia/Jakarta` explicitly when that is the intended schedule.

After a successful reconciliation, the route redacts source text for `processed` and `filtered` capture rows older than seven days by default. `CODEATLAS_MEMORY_SOURCE_RETENTION_DAYS` controls the age and is clamped to 1–30 days (default 7). Pending rows are excluded from expiry, as are persisted memories, evidence and extraction receipts. Keep pending source rows available until reconciliation acknowledges them.

The five-field cron matcher supports lists, ranges, steps and month/weekday names. Day-of-month/week semantics follow [Cronie's matching implementation](https://github.com/cronie-crond/cronie/blob/master/src/cron.c): when either day field begins with `*`, including a stepped wildcard, both day predicates must match; otherwise either restricted day may match. UTC run slots and the configured timezone are persisted.

`dream_job_runs` records one unique tenant/project/job/scheduled UTC slot. Claims have a bounded lease, heartbeat and fencing token. Failed HTTP requests, malformed JSON, `success: false` and failed operation counts remain retryable. Success is recorded only after semantic application success. Losing a lease aborts the request. Consolidation embeds the live fence in every mutation; reconciliation rechecks the lease between operations and uses idempotent memory receipts and evidence keys for replay safety.

PostgreSQL first claims use an insert that tolerates either intentional uniqueness constraint, followed by a conditional claim/reclaim update. This prevents concurrent workers from receiving an unhandled slot-index conflict. The retained test is `tests/cross-repo/postgres-scheduler-concurrency.acceptance.ts`; it requires explicit `CODEATLAS_POSTGRES_ACCEPTANCE=1` and a dedicated private cluster. It rejects database/socket paths outside the real temporary directory, TCP hosts and non-synthetic database names before connecting. It stops/restarts that disposable cluster to test durable state; configure the `POSTGRES_*` and `CODEATLAS_POSTGRES_*` inputs documented in the test header. Never point this restart test at a deployed service.

Recovery considers the most recent eligible slot within a bounded 24-hour window and previously failed/expired runs. Retries use bounded exponential backoff and stop after the configured attempt limit. Completed rows survive restarts and prevent duplicate successful work. A failed terminal run is an operational incident, not a completed job. Consolidation reuses stable run IDs/instants and deterministic concept IDs, avoiding compounded scoring on replay.

## Canary and rollback

The disposable fixture canary, selected-target runtime canary, isolated two-session real-host canary and canonical-project scheduled canary have passed. The selected host settings were merged from a protected preview with a rollback copy; existing matcher groups and deny permissions were preserved. Six reachable configured project roots now opt into context; three unavailable roots remain untouched. Broad production rollout still requires reviewing persistence, bootstrap hit rate, scope isolation, extraction quality and latency. Production p95/p99 and token-cost SLOs remain unmeasured.

Rollback context delivery with `CODEATLAS_INJECT_BRAIN_CONTEXT=0`, preserving capture. Pause local durable dispatch with `CODEATLAS_DURABLE_CAPTURE=0`, preserving queued evidence. Pause platform extraction/reconciliation with `CODEATLAS_MEMORY_PROCESSING_ENABLED=false`, preserving pending database sources. Disable either scheduled job independently in cron settings. Keep typed ACK checks, identity isolation, redaction and durable receipts during rollback. Retain additive storage tables and source provenance; never drop or mass-rewrite production memory as a diagnostic.

Record all runtime blockers, provider limitations, skipped external checks, quality-target approval and actual test results in the results document. Do not substitute MCP connectivity, hook exit zero or an extracted-memory count for the full `capture → persistence → same-project retrieval → new-session context` acceptance chain.
