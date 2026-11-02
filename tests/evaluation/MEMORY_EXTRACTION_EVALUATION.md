# Memory extraction fixture and evaluation harness

The corpus in `tests/fixtures/memory-extraction/cases.json` (dataset version 2) contains 62 synthetic, labeled English and Vietnamese examples: 40 development cases and 22 holdout cases. It covers decisions (including a long caveat), verified facts, mixed Vietnamese/English engineering content, errors and linked fixes, duplicate evidence, preferences and preference changes, progress, open questions, negation, contradictions, unverified assistant claims, conversational noise, and fake credential values. `development` cases are for implementation feedback; `holdout` cases must remain unused while tuning extraction rules or prompts.

Version 2 corrects three development annotations before extractor implementation: `mixed-vi-en-01` is an explicit decision because it begins “Quyết định dùng”; `progress-en-02` includes both a completed test and an explicit next action; and `unverified-en-02` includes a user-reported fact that tests have not run, while the assistant forecast remains forbidden. The holdout split was not changed.

Each fixture carries synthetic `sourceEvents` with stable IDs, roles, and source text. Every expected item has a semantic kind, a short text fragment, a source event ID and quoted evidence span, plus a certainty label. A strict match requires all four: compatible kind, retained meaning, cited source span/event, and the expected `explicit`, `reported`, or `uncertain` certainty. User decisions and preferences are labeled `explicit`; user-reported engineering facts and outcomes are `reported`; unresolved questions are `uncertain`. Assistant-only claims without user or tool evidence are negative cases and must not be promoted to verified facts. The test also reports a content-only diagnostic score without evidence/certainty gates so the legacy extractor's text coverage can be compared with later versions; the strict acceptance test still requires provenance and uncertainty metadata.

Text checks are deliberately partial: the harness does not require exact wording, order, punctuation, or a fixed number of unrelated metadata fields. The only compatibility aliases are `KNOWLEDGE` for legacy decision/fact/fix/status labels and `SESSION_SUMMARY` for task status. A candidate can satisfy only one expected item, preventing one generic result from inflating recall. Additional candidates count as false positives. `mustNotContain` checks that a forbidden claim or fake sensitive value never appears in extracted text.

Run the development set with:

```bash
node --experimental-test-module-mocks --import tsx --test tests/evaluation/memory-extraction.test.ts
```

Run the held-out set only after extraction behavior and prompt/rule choices are frozen:

```bash
RUN_MEMORY_EXTRACTION_HOLDOUT=1 node --experimental-test-module-mocks --import tsx --test tests/evaluation/memory-extraction.test.ts
```

The harness reports case IDs and mismatch counts only; it does not print transcript text, extracted content, or sensitive sentinels. A future model-backed evaluator can adapt the extractor to the same `{ kind, content }` output contract, but it must use a deterministic local/mock provider and must not send these fixtures to an external service.

The pinned legacy extractor baseline (platform checkout `ebe95e7`, dataset version 2, development split only) is content-only precision 0.857 and recall 0.150 over 40 cases and 40 labels (TP=6, FP=1, FN=34). English recall is 0.172 (5/29); Vietnamese recall is 0.091 (1/11). The strict evidence-aware score is zero because the legacy output has no source citations or certainty metadata; it also produces seven grounding violations and one forbidden secret leak. The holdout split was skipped.

For a release evaluation, record raw precision and recall separately for each kind and locale, plus false positives on negative/noise cases and any forbidden-content leakage. Report development results separately from the 22-case holdout. Do not combine the splits into a single headline score. A zero-leakage requirement applies to the synthetic secrets, and assistant claims without tool evidence must not be promoted to verified facts. After the baseline was measured, the user delegated target selection on 2026-10-20. The selected release thresholds are precision ≥0.85, recall ≥0.75, and recall ≥0.70 separately for English and Vietnamese, with complete evidence grounding and zero forbidden-content leakage.

## Coverage map

| Requirement | Fixture dimensions |
| --- | --- |
| DR-001, DR-004, DR-007 | Decisions, progress/checkpoints, paired error and fix records |
| DR-002, DR-003 | Vietnamese and mixed Vietnamese/English engineering content |
| DR-005 | Assistant claims explicitly marked unverified or lacking tool output |
| DR-006 | Superseded preferences and decisions |
| DR-008 | A decision longer than 300 characters with its caveat near the end |
| DR-009 | Short social conversation with no extractable engineering memory |
| DR-010 | Repeated evidence and one-result-per-label matching |
| DR-011 | Noise and no-memory cases with empty expected output |
| DR-012 | Synthetic API key, bearer value, and password sentinels; positive extraction cases verify the value is redacted |

The harness is intentionally black-box: it invokes `summarizeConversationForDreams` with a transcript and checks returned labels, text, cited evidence, and certainty. It makes no assertions about helper names, keyword rules, internal control flow, or storage implementation. Its required result fields are an external evaluation contract for future extractors. The remediated function preserves legacy memoryType/content/importance fields and adds kind, certainty, confidence, and evidence.

## Remediated extraction and evaluation freeze

The deterministic fallback emits complete source quotes rather than paraphrases. Sentence boundaries preserve dotted filenames, symbols, URLs, and version numbers. Decisions retain their complete rationale and caveats. User preferences and decisions are explicit, user/tool outcomes are reported, and supported assistant suggestions remain uncertain; assistant forecasts or completion claims cannot establish task completion. Optional provider output must match the structured schema and complete source units, including negation. Invalid output or provider failure falls back to deterministic extraction.

The grounding evaluator now compares evidence with the redacted source and requires quoted content rather than a token subset. This permits safe citations of credential-bearing source sentences while still checking the forbidden synthetic value separately. A dedicated test demonstrates that deleting “not” fails grounding. Neither fixture labels nor the holdout split were changed.

Development result before opening holdout: 40 cases / 40 labels, TP=40, FP=0, FN=0, precision=1.000, recall=1.000; English 29/29 and Vietnamese 11/11. Grounding violations=0, forbidden-content violations=0. These scores concern the fixed synthetic corpus and do not establish accuracy on arbitrary production conversations.

The candidate rules and provider prompt are frozen before the explicit holdout run. SHA-256 hashes and held-out measurements are recorded below. Heldout results will not be used to change this frozen candidate.

Frozen SHA-256 snapshot:

```text
3d9232532e9b796d23478b8a8147f5baaf144ae39f71cbed70220b661f9412db  src/services/structuredMemoryExtractor.ts
2f07e31b23f931c1e0be90442b6e11e0bf421d16d27a37f31a9bf3c3a80e771f  src/services/llmService.ts
5732f5c71373aad1111823ec0ba6f752c897ce27f4438df2f6550a57b650b56e  tests/evaluation/memory-extraction-harness.ts
5d763f6dd52e001517e5da6f7fe4dadc43d1284187c6e8316f981738f3627279  tests/evaluation/memory-extraction.test.ts
451f3bba0d28c927c8e8d493b63d2106135891cbe51f03549909776e2cd22211  tests/fixtures/memory-extraction/cases.json
```

Frozen holdout result: 22 cases / 19 labels, TP=17, FP=3, FN=2, precision=0.850, recall=0.895. English recall=0.800 (8/10), Vietnamese recall=1.000 (9/9). Per kind: decision precision=1.000 / recall=0.800; fact 0.600 / 1.000; mistake 1.000 / 0.750; fix 1.000 / 1.000; preference 1.000 / 1.000; task status 0.500 / 1.000; open question 1.000 / 1.000. Evidence-grounding violations=0. Forbidden substring matches=5; therefore the frozen heldout safety gate failed despite meeting the selected aggregate precision/recall thresholds.

The five forbidden matches concern retained historical preferences/decisions, an uncertain assistant claim, and a negative Vietnamese constraint. In `neg-vi-02`, the forbidden substring is embedded in the source prohibition, so the literal checker reports a false positive even though negation is retained. The other active-history and unsupported-assistant cases require further remediation and an independent unseen evaluation before a release claim. No heldout labels were edited. The failed frozen result remains recorded rather than presented as passing. After that failure, the parent requested general safety repairs for unsupported assistant assurances and explicit historical-choice supersession, backed by new independent unit regressions. This creates a new candidate; the original holdout is now a known regression set and cannot be represented as an untouched holdout for that candidate. A separate evaluator is preparing a fresh independent set without inspecting the candidate.

Optional model extraction uses `createMemoryExtractionGenerator()` from `llmService.ts`. Configure `CODEATLAS_MEMORY_EXTRACTION_URL` as a complete OpenAI-compatible chat-completions endpoint, `CODEATLAS_MEMORY_EXTRACTION_MODEL`, optional `CODEATLAS_MEMORY_EXTRACTION_API_KEY`, and `CODEATLAS_MEMORY_EXTRACTION_TIMEOUT_MS` (default 15000, bounded to 100–30000). The adapter uses nonstreaming JSON responses, a bounded response body, and never logs provider bodies. The extractor calls it only for meaningful checkpoint batches with deterministic candidates. The supplied JEV SystemOne `noul` API returns a numeric answer and is not treated as a JSON/text memory extractor without a documented compatible contract.

A context refresh computation returns `delivery_status: "unsupported"`, the available context payload, `context_available`, and `automatic_injection: false`. Only a host adapter can establish that this payload was actually delivered. Computing or returning context does not increment an injected-memory counter.

## Safety-repaired candidate (version 2)

`StructuredMemory` now carries optional `status: "active" | "superseded"` and `supersedes: MemoryEvidence[]`. An explicit user choice change can retain an exact historical quote as superseded while making the replacement the only active choice. Supersession links contain exact source-event IDs and evidence spans rather than inferred topics. Optional model output cannot set this metadata; the validator reconstructs schema fields and discards supplied status/supersession fields. Worker persistence must retain historical evidence and apply status/link updates within tenant/project scope.

The extractor drops unsupported assistant facts, forecasts, assurances, and completion claims. Assistant preference/fix/mistake quotations may remain uncertain for backwards compatibility. The evaluator now scores active records while validating provenance of every record. Sensitive forbidden values are checked across content and evidence of active and superseded records. Non-sensitive forbidden assertions are checked in active content; a same-clause negation check distinguishes “Never execute commands” from the affirmative forbidden assertion. Dedicated tests cover affirmative failures, retained prohibitions, and secrets in superseded audit evidence.

The repaired development result remains 40/40 labels, TP=40, FP=0, FN=0, precision=recall=1.000, with zero grounding and forbidden-content violations. Focused extractor/provider/reload/evaluator regressions: 38 passed and the original holdout test skipped by default. Type checking and compilation passed before this second freeze.

Second candidate SHA-256 snapshot (before the independent evaluator is opened):

```text
eed507fddd03f0e54cdbb8427872982f7c1cbf961439bdca5173097fe23a5a08  src/services/structuredMemoryExtractor.ts
2f07e31b23f931c1e0be90442b6e11e0bf421d16d27a37f31a9bf3c3a80e771f  src/services/llmService.ts
99a4d778b91090b9ccae5232867e7bd6361f942b67c231399ca8a81e72eb7b16  tests/evaluation/memory-extraction-harness.ts
6badde176cf19b74fe5e2e97688b3848d442613f253c6d5e0d3a6b9e209298ef  tests/evaluation/memory-extraction.test.ts
451f3bba0d28c927c8e8d493b63d2106135891cbe51f03549909776e2cd22211  tests/fixtures/memory-extraction/cases.json
```

The previously inspected 30-case independent corpus was used for remediation and is now a known regression set. Its earlier results remain preserved below; they are not unseen validation. A separate 24-case evaluator-created canary is pending and must be reported separately.

## Generalization remediation candidate v3

Candidate v3 broadens deterministic extraction around sentence intent and source structure: engineering imperatives can express choices without a decision keyword; code identifiers, paths, measurements, and tool output support technical facts; unresolved whether/uncertainty phrasing supports open questions; and explicit changes link exact older evidence as superseded. Complete decision quotes retain causal reasoning and caveats. Tool success quotes containing filenames remain intact, assistant assurances and change claims are excluded, and credential-bearing connection strings are redacted or filtered. Optional model output remains limited to complete, validated source quotes.

Validation used the existing development, holdout, and previously inspected 30-case regression corpora with `RUN_MEMORY_EXTRACTION_HOLDOUT=1 RUN_MEMORY_EXTRACTION_INDEPENDENT=1 node --experimental-test-module-mocks --import tsx --test tests/evaluation/memory-extraction.test.ts`. The regression corpus was not treated as unseen. Focused extractor tests passed 23/23; all three corpus checks passed their selected thresholds in this run. Development: 40 labels, TP=38, FP=3, FN=2, precision=0.927, recall=0.950; EN precision/recall=0.931/0.931, VI=0.917/1.000. Original holdout regression: 19 labels, TP=18, FP=0, FN=1, precision=1.000, recall=0.947; EN recall=0.900 and VI=1.000. Known 30-case regression set: 44 labels, TP=40, FP=5, FN=4, precision=0.889, recall=0.909; EN precision/recall=0.955/0.955, VI=0.826/0.864. Grounding violations=0 and forbidden-content violations=0 on all three sets. These results describe the labeled regression corpora only and do not claim generalization to arbitrary conversations.

Candidate-v3 source hashes, also saved to `/tmp/extraction-candidate-v3-freeze.sha256`:

```text
e4a7b6ab1fd4cc6f4420494736a9d51624e45140c5a16a845d7d1cbc1280ac68  src/services/structuredMemoryExtractor.ts
2f07e31b23f931c1e0be90442b6e11e0bf421d16d27a37f31a9bf3c3a80e771f  src/services/llmService.ts
99a4d778b91090b9ccae5232867e7bd6361f942b67c231399ca8a81e72eb7b16  tests/evaluation/memory-extraction-harness.ts
```

The next evaluation must use the separate 24-case canary without reading or tuning against its labels. Preserve this candidate snapshot and keep its canary results separate from both the original holdout and the known 30-case regression set.

## Evaluation metric revision: shared-quote memory records

The harness now groups raw expectation fragments into one scored memory record only when kind, certainty, source event ID, and evidence span match exactly. A candidate can satisfy that grouped record only when its content contains every annotated fragment and, in strict mode, it has the expected certainty and cites the expected source event/span. Existing one-candidate-to-one-record matching remains in force across different groups, so a broad candidate cannot cover separate source events or quotes. `expectedCount` is the grouped record count; `expectedFragmentCount` preserves the raw annotation count. Per-locale and per-kind breakdowns expose both counts.

This correction addresses annotations that split a single fully quoted decision, fix, or task state into fragments. Historical precision/recall figures recorded above used the pre-revision fragment metric and remain preserved as historical results; they must not be relabeled as results under the revised metric. Release thresholds are unchanged. Report any re-evaluation under this metric separately from historical scores and retain both counts.

## Release annotation audit version 2

`tests/fixtures/memory-extraction/release-holdout-adjudicated.json` is an annotation-only copy of the original 24-case `release-holdout.json`. The original file remains unchanged. The copy records annotation version 2, the original fixture SHA-256 as `parentSha256`, and a reason beside every changed expectation. The adjudication used the frozen rubric without inspecting candidate output or predictions.

The frozen kind boundary used for this audit is: decisions are explicitly adopted architecture, product, or operational choices and policies; preferences cover personal or recurring style, format, example, and workflow preferences, excluding architecture; facts cover technical state, constraints, and prohibitions at reported certainty unless the user explicitly adopts them as policy; mistakes and fixes require an evidenced failure and correction; task status covers progress, blockage, and next work, with a direct user instruction explicit; open questions are uncertain; assistant-only assurances remain negative cases.

The four annotation corrections are:

- `holdout-en-07`, expectation 1: PREFERENCE → DECISION. Thin route handlers and shared-schema validation are an architecture convention.
- `holdout-en-11`, expectation 1: PREFERENCE → DECISION. Compatibility with the current LTS is an interim operational policy pending owner confirmation.
- `holdout-vi-08`, expectation 1: PREFERENCE → DECISION. This is the equivalent interim compatibility policy.
- `holdout-vi-11`, expectation 1: PREFERENCE → DECISION. Choosing the workspace logger and excluding a new logging library is an architectural choice.

The distinction between a user directive and a standing/adopted policy can still be ambiguous in isolation. The corrected labels apply the boundary above consistently to these explicit policy or architecture choices; this is an annotation judgment, not a change to extraction targets or a conclusion based on model performance.

## Final verification ledger (metric version 2)

This ledger adds the final frozen-source measurements without replacing or reinterpreting any earlier result above. The release gate is unchanged: precision ≥0.85, recall ≥0.75, English and Vietnamese recall ≥0.70 each, zero grounding violations, and zero forbidden-content violations. `expected` counts grouped memory records under metric version 2; `fragments` is the raw annotation count. Historical scores use the metric version stated in their original sections and are not directly comparable where annotation fragments were grouped.

The final independently authored corpus contains 24 cases (12 English, 12 Vietnamese), 40 raw annotation fragments, and four negative cases. Its file SHA-256 is `9906401533b7ec816af3cbcf1b69b0dbfcef3e604b1c5c783b174db98f42455d`. The corpus author did not inspect extractor source, predictions, or evaluation results while authoring it. The source author did not inspect the fresh corpus or its results before the first blind evaluation and subsequent source freeze. The final source includes the separately motivated AWS field-name privacy fix and conservative, topic-and-scope-aware supersession repair; neither was based on fresh corpus contents. The final verified extractor SHA-256 is `7f50a251a7bf7159f00c3c675bf6f108fb78e0989ac9ff53c5b744d37bf16ce8`, recorded in `/tmp/codeatlas-extraction-verified-freeze.sha256`.

The final default deterministic run used all five configured splits (`/tmp/codeatlas-quality-verified-final.log`). Zero grounding and forbidden-content violations were observed in every split, but the rows marked **FAIL** did not meet the unchanged precision target:

| Split | Cases | Expected records / fragments | TP / FP / FN | Precision / recall | English P / R | Vietnamese P / R | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Development | 40 | 40 / 40 | 35 / 5 / 5 | 0.875 / 0.875 | 0.857 / 0.828 | 0.917 / 1.000 | Pass |
| Original holdout | 22 | 19 / 19 | 18 / 0 / 1 | 1.000 / 0.947 | 1.000 / 0.900 | 1.000 / 1.000 | Pass |
| Known independent regression | 30 | 44 / 44 | 38 / 8 / 6 | 0.826 / 0.864 | 0.870 / 0.909 | 0.783 / 0.818 | **Fail: precision** |
| Adjudicated release | 24 | 35 / 42 | 17 / 14 / 18 | 0.548 / 0.486 | 0.600 / 0.563 | 0.500 / 0.421 | **Fail** |
| Fresh independent final holdout | 24 | 40 / 40 | 13 / 18 / 27 | 0.419 / 0.325 | 0.471 / 0.400 | 0.357 / 0.250 | **Fail** |

The previously reported candidate-v3 independent-set score (0.889 precision / 0.909 recall) remains in its historical section above. The final deterministic regression run uses the corrected grouped-record metric and a later frozen source; its lower score is reported as measured, not reconciled by changing labels or targets. The deterministic extractor therefore does **not** pass the complete release gate.

The opt-in configured model profile was evaluated separately. On the adjudicated release copy it produced 33 TP, 4 FP, and 2 FN over 35 grouped records (42 fragments): precision 0.892 and recall 0.943. English was 0.941 / 1.000 precision / recall; Vietnamese was 0.850 / 0.895. On the fresh final holdout it produced 36 TP, 4 FP, and 4 FN over 40 records: precision and recall 0.900 each, with English and Vietnamese both at 0.900 / 0.900. Both model runs had zero grounding violations, zero forbidden-content violations, 24 provider calls, and zero provider errors. The provider rerun on the then-verified source hash reproduced the fresh-holdout 0.900 / 0.900 result; its complete output is `/tmp/codeatlas-model-quality-verified-final.log`. The first blind profile and adjudicated-release profile are preserved in `/tmp/codeatlas-model-quality-release-final-unseen.log` and `/tmp/codeatlas-model-quality-release-adjudicated.log`, respectively.

These model-profile scores meet the aggregate and locale thresholds on the evaluated synthetic corpora; they do not turn the failing deterministic results into passes or establish performance on arbitrary production conversations. Per-kind figures remain important: on the fresh model holdout, decision precision was 0.571 and fact recall was 0.667 despite passing aggregate and locale gates. Retain this limitation when making release decisions.

## Subsequent model safeguards and rubric clarification (2026-10-20, Asia/Jakarta)

All preceding results are preserved freeze records. Later guards normalized unadopted external requirements to reported facts, prevented unrelated/temporally scoped preferences from superseding each other, enforced exact-quote presentation/next-action classification, and rejected owned checkpoint transport markers as memories. Shared nested-field redaction closed the AWS session-token checkpoint gap. These changes were regression-tested without editing any source fixture, gold label, metric or threshold.

The model then passed the final corpus at TP=37, FP=3, FN=3 (precision/recall 0.925/0.925), but a real adjudicated rerun failed at 30/7/5 (0.811/0.857); a later guarded rerun scored 31/6/4 (0.838/0.886). These failures had 24 calls and zero provider errors, so they were retained as actual quality failures, rather than dismissed as transport failures or replaced by earlier passing runs.

Review identified an overlapping taxonomy: generic “operational policy” also described source-control workflow, while the preference rubric mentioned only presentation/commit order. The clarified system contract explicitly assigns developer source-control merge/commit-history and review workflow to PREFERENCE, even when prescriptive/project-wide; DECISION covers application/product/runtime behavior and architecture. It preserves reported progress/external constraints and direct-user next-action certainty. No corpus/gate changed.

At source SHA256 `50cb080b1ae247cdf5b5ccd2367adedf2c1531bac3901c0dce9f0a5d7015fdbc`, actual configured-provider results were:

| Corpus | TP / FP / FN | Precision / recall | EN recall / VI recall | Grounding / privacy violations | Calls / provider errors |
|---|---|---|---|---|---|
| Adjudicated regression, 35 records / 42 fragments | 35 / 2 / 0 | 0.946 / 1.000 | 1.000 / 1.000 | 0 / 0 | 24 / 0 |
| Final authored corpus, now a regression set, 40 records | 36 / 4 / 4 | 0.900 / 0.900 | 0.900 / 0.900 | 0 / 0 | 24 / 0 |

Both meet the selected model-profile gates. The final corpus's decision precision remains 4/6 and fact recall 9/12: literal grounding is not perfect semantic labeling. The first truly blind measurement remains the earlier 0.900/0.900 run; subsequent tuning/verification cannot be called unseen evaluation. Logs and synthetic 0600 snapshots: `/tmp/codeatlas-completion-provider-{adjudicated,final-unseen}*`. Real model-to-SQLite persistence, scoped retrieval, checkpoint restoration and receipt replay also passed with one provider call and no second call on replay (`/tmp/codeatlas-completion-provider-persistence.log`).

Deterministic extraction still failed the three broader gates at that freeze. The passing configured-model profile did not waive those failures.

## Final deterministic remediation and combined verification

The final extractor SHA256 is `938a483a7c4736ca404d99700dfdaaf855f3bcaeed87a288bf0352cadd090668`. Generic source-intent rules now distinguish actual failures from conditional failure handling, reported progress from adopted choices, verified corrections from unverified fixes, and developer workflows from runtime choices. Complete evidence units preserve adjacent uncertainty and caveats. Native failure headers retain dotted filenames, and legacy USER reports such as “encountered an error” remain MISTAKE. Regression tests cover these boundaries. No corpus, gold label, metric or threshold changed during this remediation; every previously inspected corpus is a regression set.

`npm run test:memory-quality` passed **70/70**, without skips, on this freeze:

| Corpus | TP / FP / FN | Precision / recall | EN recall / VI recall | Gate |
|---|---|---|---|---|
| Development, 40 records | 36 / 5 / 4 | 0.878 / 0.900 | 0.897 / 0.909 | Pass |
| Original holdout, 19 records | 16 / 2 / 3 | 0.889 / 0.842 | 0.800 / 0.889 | Pass |
| Known independent regression, 44 records | 42 / 3 / 2 | 0.933 / 0.955 | 0.955 / 0.955 | Pass |
| Adjudicated release, 35 records / 42 fragments | 33 / 1 / 2 | 0.971 / 0.943 | 1.000 / 0.895 | Pass |
| Final authored regression corpus, 40 records | 34 / 4 / 6 | 0.895 / 0.850 | 1.000 / 0.700 | Pass |

All five reported zero grounding and sensitive/forbidden-content violations. The unchanged gates are aggregate precision >=0.85, recall >=0.75, and each language's recall >=0.70. Vietnamese recall on the final corpus meets the boundary exactly; this does not establish stronger language coverage.

Both actual configured-provider profiles were rerun on the same final hash. Adjudicated regression: **35 TP / 2 FP / 0 FN**, precision **0.946**, recall **1.000**, both locale recalls **1.000**. Final authored regression: **36 TP / 4 FP / 4 FN**, precision/recall **0.900/0.900**, both locales **0.900/0.900**. Each used 24 provider calls, with zero provider errors, recovered requests, grounding violations or sensitive/forbidden-content violations. The final corpus still has decision precision 4/6 and fact recall 9/12; aggregate acceptance does not imply perfect kind classification. The first blind assessment remains separate above.

The actual model-to-SQLite persistence/retrieval/checkpoint/receipt-replay test passed **1/1**, with one provider call and none on replay. Logs: `/tmp/codeatlas-final-verified-quality.log`, `/tmp/codeatlas-final-verified-provider-{adjudicated,final-unseen,persistence}.log`. `/tmp/codeatlas-final-verified-provider-freeze.json` confirms the source hash was unchanged during provider verification. All earlier failures remain historical evidence; these passing results supersede their release-gate disposition without relabeling them as passes.
