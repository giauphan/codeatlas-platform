# Memory pipeline remediation verification

Status: **Implementation and the selected-target runtime rollout pass.** The live capture/restore canary, two real Claude sessions, native hooks, six reachable project context opt-ins, and a canonical-scope scheduled consolidation canary passed. The resident API loaded the corrected scheduler; the dedicated selected-project jobs are active with five-minute reconciliation and daily 19:00 UTC consolidation. The shared legacy scheduler remains disabled. Earlier scope incidents and test/data incidents remain disclosed below. GPT-6 Luna subagents implemented the remediation and regression fixes in both repositories. Verification date: 2026-10-20 UTC.

The three source documents named in the request were not present in either checkout or the accessible `/home/ubuntu` and `/tmp` trees. The local execution tracker and regression-matrix disposition are recorded in `docs/superpowers/plans/2026-10-19-memory-pipeline-remediation.md` and this report; this limits claims about exact document-by-document signoff.

## Final implementation and verification

| Check | Observed result |
|---|---|
| MCP full test suite | **247 passed**, 0 failed/skipped, 32 suites |
| MCP lint, build, artifact verification | Passed; packaged files match the generated source/artifact manifest |
| Installed Claude hook validation | **17/17 passed** on the selected host; disposable installation also passed **17/17** |
| Platform full isolated `npm test` | **558/558 passed**, 0 failed/skipped; 89 suites; all four deterministic quality flags enabled |
| Platform typecheck and build | Passed |
| Explicit deterministic quality command | **70/70 passed**, 0 failed/skipped; all five bilingual corpus gates passed |
| Compiled API/SQLite acceptance | **11 passed**, 0 failed, 1 expected live-Claude case skipped; actual live Claude verification is recorded below |
| Selected-target runtime canary | Passed end-to-end: capture, replay, Stop reconciliation, retrieval, cross-project isolation and fresh SessionStart |
| Selected-target live Claude continuity | Two fresh Claude sessions passed: the first captured a synthetic tool result; the second restored it without receiving the token in its prompt |
| Real model → SQLite → retrieval → checkpoint → receipt replay | **1/1 passed**, no skips, one provider call and no second call on replay |
| Private PostgreSQL 14.24 / pgvector 0.8.7 runtime probe | Schema initialization/reinitialization, canonical uniqueness, scoped vector search, restart sequence and ledger persistence/fencing passed |
| PostgreSQL concurrent adapters and restart | **20/20 repeated acceptance runs passed after the race fix**: one slot owner, expired lease reclaim, stale-owner rejection and persisted completion after server restart |
| Local quality telemetry baseline | **1/1 passed**: 11/11 durable events, zero duplicate memory rows, retrieval MRR 0.833 across four queries, 7/7 checkpoint components and 2/2 startup restores |
| Model quality on the first unseen assessment | **Precision 0.90 / recall 0.90**; EN and VI recall 0.90; 24 calls, no provider errors |
| Final guarded model on the same corpus (now a regression set) | **Precision 0.925 / recall 0.925**; EN recall 0.90, VI 0.95; 24 calls, no provider errors |
| Final clarified model on the same corpus | **Precision 0.90 / recall 0.90**; EN and VI recall 0.90; 24 calls, no provider errors |
| Model adjudicated regression assessments | Final clarified rubric: **0.946 / 1.000 passed**; earlier **0.892 / 0.943 passed**, **0.811 / 0.857 failed**, and **0.838 / 0.886 failed** results remain preserved |

The latest full platform suite ran with all four deterministic quality flags enabled; all five bilingual corpus gates passed with no skips. Model assessments use an explicit compatible provider and the same selected thresholds. Zero grounding and sensitive-content violations were observed in the final assessments. Per-kind errors remain separately reported; overall precision is not a guarantee that every semantic label is correct.

The intermediate guarded-model pass used extractor SHA256 `db672febcfe0ec567444a7073de9a9c9045727fa845401650e6983bd130415cf`. Its per-kind decision precision was 0.80 (4 true positives / 1 false positive); do not describe it as perfect decision classification. A later adjudicated rerun failed precision, and source-level review found a taxonomy overlap between developer workflow policies and runtime decisions. The clarified prompt explicitly prioritizes source-control/review/commit-history workflow as PREFERENCE and reserves DECISION for application/product/runtime behavior. At intermediate source SHA256 `50cb080b1ae247cdf5b5ccd2367adedf2c1531bac3901c0dce9f0a5d7015fdbc`, the adjudicated assessment recovered all 35 gold records with 2 false positives, while the final authored corpus recovered 36/40 with 4 false positives. Both had zero grounding/privacy violations and zero provider errors. The latter's decision precision is 4/6, so perfect semantic labeling is not claimed. Original blind scores, prior failures and subsequent regression results remain separate.

Final extractor SHA256 is **`938a483a7c4736ca404d99700dfdaaf855f3bcaeed87a288bf0352cadd090668`**. Generic intent, uncertainty, workflow, progress, actual-failure and confirmed-fix rules repaired the deterministic failures without changing fixtures, labels, metrics or gates. Both actual provider profiles were rerun on this exact hash: adjudicated **35 TP / 2 FP / 0 FN**, precision/recall **0.946/1.000**; final authored regression **36 TP / 4 FP / 4 FN**, **0.900/0.900**. Each made 24 calls with zero provider errors, recovered requests, grounding or privacy violations. Real model persistence/retrieval/checkpoint/receipt replay also passed. These are regression measurements; inspected corpora cannot become unseen again.

Final deterministic results, with identical target thresholds:

| Corpus | TP / FP / FN | Precision / recall | EN / VI recall | Gate |
|---|---|---|---|---|
| Development, 40 records | 36 / 5 / 4 | 0.878 / 0.900 | 0.897 / 0.909 | Pass |
| Original holdout, 19 records | 16 / 2 / 3 | 0.889 / 0.842 | 0.800 / 0.889 | Pass |
| Known independent regression, 44 records | 42 / 3 / 2 | 0.933 / 0.955 | 0.955 / 0.955 | Pass |
| Adjudicated release, 35 records / 42 fragments | 33 / 1 / 2 | 0.971 / 0.943 | 1.000 / 0.895 | Pass |
| Final authored corpus, 40 records | 34 / 4 / 6 | 0.895 / 0.850 | 1.000 / 0.700 | Pass |

All five deterministic evaluations reported zero grounding/privacy violations. Selected thresholds remain precision >=0.85, recall >=0.75 and per-language recall >=0.70. Final-corpus Vietnamese recall meets the boundary exactly. Before remediation the three broader sets failed at precision/recall 0.826/0.864, 0.581/0.514 and 0.452/0.350; those results remain historical failures, not relabeled passes. Passing these small labeled regressions does not establish arbitrary conversation quality.

Final executable identity: PATH `codeatlas` resolves to `/home/ubuntu/codeatlas-mcp-server/dist/index.js`, SHA256 `78d17258b116aa049515e484084083be11b27cc69358e6cb4bc18ea9718b5fe7`. Complete build-manifest SHA256: `1b5b709e10bc7b5dc30b95d747c22dbe0ebfee065679e3d075650d96d1fbb16c`. The complete manifest is required because imported CLI changes need not change the entrypoint hash.

Latest logs: platform full suite `/tmp/codeatlas-platform-final-tests.log`, typecheck `/tmp/codeatlas-platform-final-typecheck.log`, build `/tmp/codeatlas-platform-final-build.log`, compiled cross-repository acceptance `/tmp/codeatlas-final-crossrepo.log`; MCP suite, lint, build and artifact verification `/tmp/codeatlas-final-mcp-{tests,lint,build,verify}.log`, hook validation `/tmp/codeatlas-final-mcp-hooks.log`. The installed hook validation passed 17/17 with local process permissions. Earlier failed/intermediate runs retain their original logs and freeze records. These local logs are ephemeral; this report and the evaluation report retain the decision-relevant counts and hashes.

The global Claude settings were merged from a private preview with the shared installer logic and a rollback copy. Native lifecycle hooks point to the compiled MCP CLI; existing matcher groups, deny permissions and unrelated settings were preserved. Context opt-in is enabled in the six reachable configured project settings. A direct settings-presence check is not treated as proof of delivery; the two-session live acceptance and installed-hook validation provide that evidence for the selected target. Earlier default full-suite startup accessed the operator's default local database, as disclosed below; the final suite and canaries use disposable storage.

The separate synthetic telemetry baseline (`tests/cross-repo/memory-quality-telemetry.acceptance.ts`, `/tmp/codeatlas-final-verified-telemetry.log`) measured **11/11 durable events** including three checkpoint markers, **8/8 grounded evidence records**, seven distinct memories from eight memory acknowledgements, **zero persisted duplicate rows**, and no extra capture/memory rows on replay. Four lexical/path queries gave **MRR 0.833**, **hit@20 4/4**, and zero returned IDs outside the requested project. Three checkpoint restores contained **7/7 expected components**; startup bootstrap succeeded **2/2**. Combined startup text was **1,131 UTF-8 bytes**, a context-size proxy; actual model tokens were not measured. These small synthetic observations are not production rates.

The latest compiled acceptance measured **18 completed direct CLI hook calls**, maximum/p95 **872 ms**, against its existing **20,000 ms helper deadline**. The installer declares no explicit per-route timeout; intentional SIGKILL and model inference/session duration are excluded from hook-completion samples. Character-budget and duplicate-packet suppression tests passed. Production token cost, baseline latency change and production p95/p99 SLO remain unmeasured.

## Implemented behavior

- Native Claude decoding uses `tool_response` and error-only failures, shared redaction before dispatch/spool, bounded multipart content, typed ACK validation, finite deadlines and stable retry keys. Missing configuration reports an explicit outcome. Backend noise filters never expose sentinel IDs as persisted memories.
- Per-project/session inboxes, queues, exact authorized JSONL paths and independent read/ACK cursors preserve 9th+ messages, concurrent sessions, rotation, truncation, lost responses and actual process-kill replay. Permanent poison events enter private redacted quarantine without silently dropping evidence or blocking later valid events indefinitely.
- Canonical repository identity survives Git worktrees/symlinks and separates equal basenames/tenants. Canonical deduplication replaces display-name uniqueness while preserving legacy rows/custom columns. Retrieval scopes candidates before vector limits and falls back to lexical filename/path lookup during embedding outages.
- Latest checkpoints are deterministic and source-backed, available before a task prompt. SessionStart and prompt hooks deliver bounded host-supported context, suppress unchanged packets, preserve installer security settings, and label historical text as untrusted. Explicit `memory_bootstrap` and reload results never claim unsupported host injection.
- Extraction records role, kind, certainty, full quoted evidence, source spans, durable model decisions and replay-stable IDs. Model checkpoints curate whole eligible batches, including fast-path events. Evidence confidence does not inflate on replay; supersession requires a related topic and compatible scope. Nested credential fields, PEM blocks, URL passwords and AWS credentials are redacted before their relevant persistence/provider boundaries.
- Reconciliation and daily consolidation use separate validated cron schedules, explicit timezone, durable tenant/project UTC slots, leases, heartbeats, fencing, bounded recovery/backoff and semantic success. HTTP 200 with `success:false` remains failed/retryable. Empty consolidation and pending-source backfill have explicit tests.
- Host outcomes and admin-only aggregate metrics distinguish source receipt, memory persistence, actual host delivery, retrieval errors/empty/no-match, scheduler failure and lease loss. Counts/durations/lag permit throughput and latency observation without logging raw payloads. Operator runbooks document retention, quarantine, migration and reversible pauses.

## Regression matrix disposition

The source matrix remains authoritative. This mapping identifies executable evidence rather than declaring universal host or production behavior.

| Matrix IDs | Main evidence | Disposition |
|---|---|---|
| HC-001–010, HC-019 | MCP `src/cli/brainHooks.test.ts`, `hookDiagnostics.test.ts`, compiled acceptance | Decoder/schema/config precedence, redaction and safe outcomes tested |
| HC-011–018 | MCP `src/services/dreamingService.test.ts`; platform capture/route/idempotency tests | Stored/filtered/rejected/malformed JSON, auth, timeout, retry and duplicate ACKs tested |
| HC-020–021 | Compiled acceptance; MCP `test/build-manifest.test.ts` | Equal-basename scopes and stale/modified compiled artifact rejection tested |
| SH-001–007 | `tests/cross-repo/compiled-memory-pipeline.acceptance.ts` | 7→8→9→50, replay, outage, lost ACK and actual SIGKILL/restart tested |
| SH-008–015 | MCP session spool/transcript reader/project identity tests; shell hook tests | Concurrent projects/sessions, exact paths, worktrees, rotation, spaces/Unicode, outside-root rejection and real multiline shell forwarding tested |
| RT-001–005, RT-016 | Project identity, scoped retrieval and canonical idempotency tests in both repositories | Aliases/collisions, tenants, worktrees, pre-limit vector filtering and requested filters tested |
| RT-006–013 | Checkpoint, retrieval and context tests; compiled acceptance | Prompt-free bootstrap, task relevance, outages, exact-path fallback and distinct error/empty/filtered states tested |
| RT-014–015 | Context formatting/filter tests and live continuity | Untrusted historical labels, source IDs and current-source/working-tree verification instruction tested; arbitrary host compliance is not claimed |
| DR-001–012 | Extractor, ingestion, checkpoint, model-to-SQLite and bilingual quality tests | Persistence/evidence/safety and all five deterministic corpus gates passed; both measured model profiles passed; limited-corpus and per-kind errors remain explicit |
| DR-013–015 | Live Claude two-session canary; context/reload/MCP bootstrap contract tests | Actual Claude continuity passed; hosts without injection use explicit tool output, with no universal auto-injection claim |
| CR-001–010 | Scheduler, cron, settings, reconciliation and consolidation idempotency tests; real PostgreSQL concurrency acceptance | Semantic failure, restart, partial replay, two-worker claims, missed windows, empty work, backfill and timezone validation tested on SQLite; independent PostgreSQL adapters also proved slot ownership, reclaim, fencing and restart persistence |

Two completed CodeRabbit review rounds and independent Luna audits identified actionable issues in canonical deduplication, alias side effects, legacy rolling IDs, installer dispatch, unconfigured spool creation, retention date comparison and poisoned queue heads. Confirmed findings were fixed and regression-tested. An inaccurate suggestion to bypass scheduler authentication was rejected after checking the actual auth use case; missing credentials now produce a clear disabled diagnostic. Final manual privacy/semantic reviews also prompted shared redaction and conservative supersession/constraint guards.

The sections below preserve the baseline and intermediate failures; their counts and hashes are historical, not the final executable record.

## Baseline (2026-10-19, Asia/Jakarta)

Baseline ran against detached checkouts pinned before implementation, with temporary HOME and SQLite databases. Source dependencies were reused from the existing installation; no production memory writes or hook installation occurred.

| Check | Platform `ebe95e7d7b2401658331d3fa21d2df33dcf330ac` | MCP `5b8365d15565383c189657d85a39ca0452dd3ca6` |
|---|---|---|
| Branch at capture | `main` | `fix/issue-345-genome-parser-context` |
| Test suite | 339/339 passed | 165/165 passed after build |
| Type check | Passed | Passed (`npm run lint`) |
| Build | Passed | Passed |
| Build validation | Not configured | Passed, 31 files |
| Hook installation validation | Not applicable | 0/17 in empty temporary HOME; requires fixture installation |

Node `v24.15.0`; npm `11.12.1`; Claude Code `2.1.302`. Capture window 22:53:48–22:56:38 WIB (15:53:48–15:56:38 UTC).

Resolved PATH executable: `/home/ubuntu/codeatlas-mcp-server/dist/index.js`.
Baseline MCP build SHA256: `6b1b06dd331cd4c9be2fa2496965519bc72de6fe617e0f9a3336528dc55d682c`.
Baseline platform build SHA256: `0aead4bc6564afcfd09946ca26da6c9169a222c1d3da71dd8cedfb780c1f088c`.

The initial MCP test run before build failed three setup-hook tests because the clean checkout had no compiled CLI. After the required build, all 165 passed. This establishes a build-order precondition that release verification must respect.

Raw local baseline logs: `/tmp/codeatlas-remediation-baseline/` (ephemeral, not required to understand this report).

## Reproduced executable failure

`npm run test:memory-pipeline` executes the actual sibling `dist/index.js` with native hook JSON against real authenticated Express routes and a disposable SQLite adapter. Before the fix it failed all four initial assertions: normal `tool_response` produced zero persisted rows, replay had no stored ID, error-only events produced no mistake, and no capture request reached the API. Red-run log: `/tmp/codeatlas-memory-canary-red.log`.

## Baseline diagnostics and Phase 1 gate verified

- Platform targeted suite: 93/93 passed; typecheck/build passed.
- MCP full suite at Phase1 handoff: 185/185 passed; lint/build/verify-build passed. The release verifier now compares source and artifact SHA256 manifests and rejects stale or modified builds. Three additional regressions demonstrated RED→GREEN behavior for stale source, changed compiled output and TypeScript asset exclusion.
- `npm run test:memory-pipeline`: **4/4 passed**, using the actual compiled CLI, real authenticated Express routes, and a temporary SQLite database. Verified normal `tool_response` storage and exact-ID retrieval, stable replay, `PostToolUseFailure` classification, and secret removal before API submission.
- Canary build SHA256 at this gate: `8559d3e92a5952c3179adf76fd8e27c3888ca54b30c9adb74a64a34f1b09dadc`. Sources will change in later phases; this is a phase checkpoint, not the final release hash.
- Expected environment condition: external embedding keys were deliberately absent. This canary verified persisted storage and lexical retrieval without an embedding provider; separate scoped-vector tests are required in Phase3.

## Extraction baseline

The synthetic bilingual corpus has 62 labelled examples (40 development, 22 held-out). Before extraction changes, content-only scoring recovered 6/38 development items (precision 6/7, recall 6/38) and 1/19 held-out items (precision 1/2, recall 1/19). One synthetic secret leaked in each split. Legacy output has no source-event/span or certainty fields, so strict grounded extraction has zero accepted true positives. Targets were sent to the user after establishing this baseline, as the plan requires. Results from a small fixture set are measurements of this corpus only.

## Phase 2/3 and checkpoint backend

The compiled durability gate passed 3/3 against real authenticated Express/SQLite: 7→8→9→50 transcript messages, 503 followed by restart with old and newly appended events, and a server commit followed by a dropped ACK. Explicit checkpoint markers were counted separately from user messages. Source receipts explicitly distinguish pending extraction from persisted memory; the later extraction worker must turn these into meaningful retrievable memories before final acceptance.

Backend Phase0–3 focused suites passed 87/87 with typecheck/build. Client Phase2 handoff passed 202/202 with lint/build/artifact verification. Canonical tenant/project identity, collision-audited aliases, pre-limit scoped vector selection and lexical fallback are covered.

Checkpoint backend tests passed 34/34 (including existing route compatibility) and a real API acceptance test passed. Verified deterministic restore without semantic search, same-project source attribution, assistant claims never promoted over failing tool observations, secret removal, rejection of unsupported claims, and an empty checkpoint marker remaining empty memory. Source evidence is materialized before retention can remove it.

At this historical checkpoint, actual Claude startup delivery, installer parity, native outcome logging, structured processing and scheduler fencing were still underway. They were subsequently implemented and tested; see the final verification ledger above. Independent review prompted fixes for same-session enqueue loss, late lifecycle cursor regression, and lease loss allowing job mutations to continue.

The v2 development corpus corrects three annotation errors before candidate tuning (explicit Vietnamese decision, a missing next action, and a user-reported unrun test status). Recomputed old-extractor development baseline: 6 true positives, 1 false positive, 34 false negatives among 40 labels (precision 6/7, recall 6/40). English recall 5/29, Vietnamese 1/11. Original held-out annotations remain unchanged. After measuring this baseline, the user delegated target selection: precision >=0.85, recall >=0.75, per-language recall >=0.70, zero grounding violations and zero sensitive-content leakage. These thresholds have not been lowered.

## Verification ledger (2026-10-20 UTC)

The intermediate integrated run before the final monitoring/classification follow-ups passed platform **496/497** tests (one opt-in fresh release-quality test skipped), MCP **237/237**, and the compiled cross-repository acceptance suite **12/12 with no skips**. Both repositories passed type checks and builds; the MCP artifact verifier checked 40 packaged files. A disposable hook installation passed **17/17** validation checks. These counts are historical checkpoints; the final verification is recorded above.

The cross-repository suite ran with `CODEATLAS_LIVE_HOST_TEST=1 CODEATLAS_LIVE_HOST_MODEL=codex/gpt-6-luna npm run test:memory-pipeline`. It used a private temporary HOME, synthetic API key, real authenticated Express routes, a disposable SQLite database, and the actual sibling compiled CLI. The live-host case started two fresh Claude Code sessions: the first invoked a real tool and saved its outcome; the second recovered the acceptance token and test count although its prompt did not contain that token. This proves automatic continuity for this configured Claude host and project. It does not establish support for hosts lacking lifecycle injection.

Additional executable fault checks covered 7→8→9→50 transcript messages, duplicate delivery, 503/restart with later messages, server commit followed by a lost ACK, an actual SIGKILL before ACK followed by restart, deterministic prompt-free SessionStart restoration, and distinct memory IDs for two real repositories with the same basename. The run took 32.003 seconds; its two-session live Claude case took 14.296 seconds. These are local canary observations, not production percentile latency measurements.

Canary identity: `/home/ubuntu/codeatlas-mcp-server/dist/index.js`; entrypoint SHA256 `78d17258b116aa049515e484084083be11b27cc69358e6cb4bc18ea9718b5fe7`; complete manifest SHA256 `409d57aa3b9f8f26c9841b7a418c2004c5df1b72aae49e228222285952a46112`. Later source changes require a fresh build and manifest; the final record supersedes this one.

Commands and local logs:

- `RUN_MEMORY_EXTRACTION_HOLDOUT=1 RUN_MEMORY_EXTRACTION_INDEPENDENT=1 npm test`: `/tmp/codeatlas-platform-final-suite3.log` (496 passed, one explicit quality-profile skip).
- Platform `npm run typecheck`, `npm run build`: `/tmp/codeatlas-platform-final-{typecheck,build}.log`.
- MCP `npm run lint`, `npm run build`, `npm run verify-build`, `npm test`: `/tmp/codeatlas-mcp-final-*.log` (237 passed, no skips, 25.295 seconds test duration).
- Compiled/live-host canary: `/tmp/codeatlas-crossrepo-final-release.log` (12 passed).

## Quality evidence and historical failures

Detailed corpus versions, frozen candidate hashes, original failed results, and annotation disclosures are preserved in [the evaluation report](../tests/evaluation/MEMORY_EXTRACTION_EVALUATION.md). The original 24-case release fixture remains byte-for-byte unchanged. Metric version 2 groups gold fragments only when kind, certainty, source event and exact quoted evidence span are identical; every fragment must remain present in the single matching memory. Raw annotation counts remain visible. An independently reviewed annotation copy corrects four preference/decision labels under the frozen rubric. No fixture source text was changed or sent as gold labels to the model.

With this corrected metric/annotation, the release corpus contains **35 memory records / 42 annotated fragments**. At the intermediate freeze, the deterministic candidate scored TP=14, FP=17, FN=21 (precision 0.452, recall 0.400; EN recall 0.438, VI 0.368). The configured model candidate scored TP=24, FP=15, FN=11 (precision 0.615, recall 0.686; EN recall 0.625, VI 0.737), with 24 provider calls, no provider errors, zero grounding violations and zero sensitive-content violations. Both failed the selected quality target at that freeze. Logs: `/tmp/codeatlas-extraction-release-adjudicated-final.log`, `/tmp/codeatlas-model-quality-adjudicated-final.log`. The inspected release corpus was then treated as a regression corpus; subsequent model improvements are recorded above.

The user-provided JEV `systemone`/`noul` example was exercised with synthetic data; it returned a numeric answer, not a JSON memory-extraction contract. The optional extraction adapter therefore uses an explicitly configured compatible chat-completions provider. No production provider or hook configuration was changed to hide this distinction.

## Release limits and rollout decision

- Local quality gates, the selected-target runtime canary and the selected-host Claude continuity check pass. Six reachable configured project roots now have context opt-in; three missing roots remain unavailable. All-project deployment, production latency budgets and the historical October 12 incident's exact runtime cause remain unverified. The named source documents were unavailable, so exact document-by-document signoff cannot be asserted.
- SQLite schema upgrades, canonical deduplication, durable receipts, retrieval, leases and replay were exercised against real temporary databases. PostgreSQL was tested with signed official PGDG packages extracted privately under `/tmp`: PostgreSQL 14.24 and pgvector 0.8.7, private Unix socket, `listen_addresses=''`, synthetic credentials. Actual adapter initialization passed twice before and twice after a server restart. Canonical same-basename separation, duplicate rejection, scoped 1024-vector search, capture sequence 1→2 across adapters/restart, persisted ledger and fencing passed. A retained two-adapter acceptance test then exposed an intermittent **SQLSTATE 23505** race between the stable-key primary key and slot uniqueness constraint: a targeted UPSERT could throw instead of losing the claim. The fix uses uniqueness-safe insertion followed by an atomic conditional claim/reclaim update, preserving constraints and fencing. The acceptance test passed **20/20 repeated runs after the fix**, including restart persistence. Scheduler source SHA256: `8028ab021f0616cd0e4be0a049608f1d8008446e7422304f1d7c2477ad09a2d7`. The test rejects non-temporary/TCP connection targets before connecting or restarting. No system service configuration changed; private servers/data/packages were removed. RED log: `/tmp/codeatlas-postgres-concurrency-safe-test.log`; GREEN logs: `/tmp/codeatlas-postgres-concurrency-green-{01..20}.log`; unsafe-target refusal: `/tmp/codeatlas-postgres-concurrency-negative.log`; package hashes: `/tmp/codeatlas-postgres-concurrency-package-sha256.txt`.
- No global claim is made about arbitrary host injection, real embedding-provider availability, or production p95/p99 latency. Lexical outage behavior and scoped vector selection are tested separately.
- A `sync_system_memory` connector is not available in this session. Runbooks, local outcome traces and repository documentation contain the durable operational record.

Rollback controls are documented in [the runbook](MEMORY_PIPELINE_RUNBOOK.md). They preserve capture receipts, queued evidence and additive schema while allowing context delivery, processing and each scheduled job to be paused independently. No production rollback was executed.

## Phase 7 live runtime work (selected-target scheduler canary passed)

The selected local target is `http://localhost:3381`, project `codeatlas-platform`; port 54321 remains outside hook routing and its shared legacy scheduler stays disabled. The direct native-hook budget is 20 seconds, a helper deadline rather than a production SLO. The six reachable configured project roots were selected; three missing configured paths remain unavailable, and 74 historical database scopes are not treated as configured repositories.

Before live writes, an online SQLite backup was created at `/home/ubuntu/.codeatlas/backups/memory-pipeline-phase7-O9QVny`; an isolated restore passed `PRAGMA quick_check` and table-count comparison. A private fingerprint file records hashes of all 9,020 then-existing memory rows without copying their content. The live database had 9,020 memories, three tenants and 74 historical scopes. After canary writes, all 9,020 baseline memory rows still existed with tenant, canonical project fields, type, content and status unchanged; three new memory rows belonged to the synthetic canary. The separate `_system` episodic startup table grew from 579 baseline rows to 586. One row matches the failed duplicate-server start at 12:38:37 UTC; six others appeared between 09:24:01 and 09:38:15 UTC and cannot be individually attributed. No cleanup or rollback was attempted.

The first API canary exposed a confirmed old-schema migration gap: existing `dream_capture_events` tables lacked `memory_ids_json` and `acknowledged_at`, despite those columns existing in fresh-install DDL. SQLite and PostgreSQL migrations now add them idempotently. The live SQLite schema has both columns; a populated legacy PostgreSQL acceptance passed **1/1** on private PostgreSQL 14.24/pgvector 0.8.7, preserving the legacy row, custom index and trigger through repeated schema initialization, capture and replay. Log: `/tmp/codeatlas-postgres-capture-migration-green.log`.

The selected-target runtime canary now passes the whole chain: authenticated native tool capture and stable replay, Stop-hook completion, a pending checkpoint marker reconciled by exact event ID, persisted-memory retrieval in the same project, other-project isolation, and fresh SessionStart context with source IDs. The final run took **14.005 seconds** against the 20-second direct-hook deadline. Its private result is `/tmp/codeatlas-phase7-live-canary-final-5-20261020/result.json`.

The real Claude acceptance then passed with two fresh sessions against the selected API and isolated Claude settings. Session one stored four source rows including one synthetic tool outcome; the acceptance token was absent from session two's prompt and was restored in its response. Each invocation had a $1 cap. The selected model run completed in 33.9 seconds total; production token costs remain unmeasured. Global Claude settings were merged through the shared installer logic from a private preview and a rollback copy. The required native lifecycle events point to the compiled MCP CLI; existing hook groups, deny permissions and unrelated settings were preserved. The installed hook validator passed **17/17**. Six reachable project settings now opt into context; the three unavailable roots were not created.

The first scheduler rollout completed eight unscoped jobs: six reconciliations across three tenant scopes and two consolidations across two tenant scopes. Reconciliation stored zero memories; consolidation processed 204 memories and created six concepts, with no merges, archives or supersessions. No speculative rollback was attempted. After selecting a single tenant/project, a later display-project consolidation exposed a second root cause: the scheduler passed the display alias rather than the canonical `project_id`. It processed 29 candidates, merged 13 memories, created two concepts and archived none. A pre-run aggregate showed 21 active canonical-project memories; after the run, eight remained active. Eight same-tenant rows had `project_id IS NULL` under that display alias (two active, six archived). The available run record does not identify individual affected row IDs, so ownership and exact side effects cannot be reconstructed or safely reversed. No restoration or cleanup was attempted.

The fix now carries canonical `project_id` from cron settings through the scheduler request, daily route, pipeline and all four consolidation operations. SQLite and PostgreSQL add a nullable canonical identity to concepts; old rows remain NULL. A scheduled canonical run filters memory and concept reads/writes by exact tenant plus project ID. Rows with a NULL ID stay untouched pending an explicit ownership map. Display-only legacy callers retain the display-name path. Isolated SQLite coverage verifies that same-alias rows with another or missing canonical ID retain their status and confidence, while the selected rows deduplicate, score and create correctly scoped concepts. A dedicated route test and pipeline test verify the ID handoff.

The resident `tsx watch` child restarted after the fix at 14:51:38 UTC and held port 3381. Three subsequent ledger entries all matched the selected tenant/canonical project: reconciliation completed at 14:55:40 and 15:00:40 (zero stored, zero failed), and consolidation completed at 15:03:44. The consolidation run processed eight canonical-project memories, merged zero, created two concepts, archived zero and superseded zero; duration was 1,368 ms, with no error. No other-scope job entries were created after that reload. The one-minute canary schedule was then restored to `0 19 * * *`; selected-project reconciliation remains `*/5 * * * *`, both jobs are enabled, timezone is UTC, and the shared legacy scheduler is disabled. The cron configuration was checked over the live API after restoration.

Production p95/p99 latency and token-cost SLOs remain unmeasured. The observed resident API is a local development watcher, not a managed production service. Three configured roots remain unavailable, and the named source specifications were not present in the accessible workspace. The selected-target execution gate is satisfied; broader production rollout and exact source-document signoff are not claimed.

## Test-isolation incident and correction

Earlier direct `npm test` runs inherited the operator HOME. Eager `MemoryController.autoInitialize()` opened `/home/ubuntu/.codeatlas/codeatlas.db`, ran schema initialization and invoked the `_system` episodic startup-record write. A separate earlier direct command, `node --import tsx --test tests/unit/sqliteAdapter.test.ts tests/unit/sqliteAdapter-bindings.test.ts`, also constructed the default adapter in three binding fixtures and executed `DELETE FROM activity_log` before synthetic inserts. This may have removed pre-existing activity rows; no before-snapshot exists, so the lost rows and exact fixture attribution cannot be reconstructed. No attempt was made to restore or delete rows without reliable ownership evidence.

During this continuation, a one-off `checkAuth` diagnostic was also imported without the test isolation wrapper. It connected to the default database and performed authentication repository work there; it did not inspect memory content. It may have updated a key's `updated_at` metadata, but no before-snapshot exists. In a separate attempt to restore the selected local API, a second `tsx watch` process initialized the configured platform database before failing to bind port 3381. Read-only comparison against the retained pre-canary backup found one `_system` startup row in that attempt's timestamp window, plus six other new startup rows since the backup whose exact source cannot be attributed. That configured platform database is distinct from the default local database. No rows were removed or restored. A read-only aggregate inspection found four matching system-initialization records in the earlier 08:35:45–08:36:40 UTC window; this is a time-window observation, not complete attribution of all earlier startup writes. The post-incident backup is not a pre-incident recovery point. The incident note is `/tmp/codeatlas-default-database-test-incident.json`; a later opaque backup was retained under `/home/ubuntu/.codeatlas/backups/memory-pipeline-phase7-O9QVny`.

The first full-suite attempt after adding the isolation wrapper revealed a filesystem gap: three legacy fixtures used fixed paths under the checkout, and the local-mode sync/delete test wrote and removed `.codeatlas` under `projects/demo-local-project`. No pre-run snapshot exists, so any prior contents cannot be reconstructed; no speculative restore was attempted. The local-mode, settings API and scan-flow fixtures now use per-run OS temporary project roots. Their focused tests pass, and the final isolated suite passed **558/558** with all deterministic quality flags enabled and no skips. The runner creates disposable HOME/database/project/temp directories, forces SQLite, supplies synthetic API configuration, excludes inherited credentials/provider/database selectors and blocks dotenv from restoring them. It forwards test exit status and SIGINT/SIGTERM, then removes its disposable files. Operator database review/cleanup, if desired, remains a separate task.

Monitoring, classification safeguards and the matrix disposition are documented above. **Phases 0–7 passed for the selected target**, including the real-host context restore and the canonical-project scheduler canary. Production-scale latency/cost SLOs, unavailable repository roots, exact signoff against the three missing source documents, and attribution of the earlier display-alias consolidation's item-level side effects remain unresolved limitations. No speculative restoration was attempted.
