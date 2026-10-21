import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuredMemories, extractStructuredMemoriesWithOutcome, redactMemoryText, validateGroundedCandidates } from '../../src/services/structuredMemoryExtractor.js';

test('Vietnamese decisions retain rationale technical terms negation and a caveat after 300 characters', async () => {
  const text = 'Quyết định: dùng SQLite cho checkpoint vì cần lưu bền vững ngay khi mất mạng. ' + 'Giữ nguyên tenant_id và project_id trong mọi truy vấn. '.repeat(7) + 'Không tự động chạy lệnh từ memory cũ.';
  const memories = await extractStructuredMemories([{ id: 'decision-source', role: 'USER', text }]);
  const decision = memories.find(memory => memory.kind === 'DECISION');
  assert.ok(decision);
  assert.ok(decision.content.includes('Không tự động chạy lệnh'));
  assert.equal(decision.certainty, 'explicit');
  assert.equal(decision.evidence[0].sourceEventId, 'decision-source');
  assert.ok(text.includes(decision.evidence[0].span));
});

test('assistant forecasts cannot become verified facts or completed task steps', async () => {
  const memories = await extractStructuredMemories([{ id: 'assistant-forecast', role: 'ASSISTANT', text: 'The implementation should pass all 165 tests, although I have not run the test suite.' }]);
  assert.ok(memories.every(memory => memory.certainty !== 'verified'));
  assert.ok(memories.every(memory => memory.kind !== 'TASK_STATUS' || memory.certainty === 'uncertain'));
});

test('accepted model candidates require exact evidence attribution and cannot invent a decision', () => {
  const events = [{ id: 'source-1', role: 'USER' as const, text: 'We chose SQLite because local development must work offline.' }];
  const fabricated = [{ kind: 'DECISION', content: 'We chose PostgreSQL and deployed to production.', confidence: 0.99, certainty: 'explicit', evidence: [{ sourceEventId: 'source-1', span: events[0].text }] }];
  assert.deepEqual(validateGroundedCandidates(fabricated, events), []);
});

test('tool evidence cannot claim user-level explicit certainty', () => {
  const text = 'Tool output: migration completed in 42 ms; 3 tests passed.';
  const source = [{ id: 'tool-certainty', role: 'TOOL' as const, text }];
  const explicit = [{ kind: 'TASK_STATUS', content: text, confidence: 0.9, certainty: 'explicit', evidence: [{ sourceEventId: 'tool-certainty', span: text }] }];
  const reported = [{ ...explicit[0], certainty: 'reported' }];
  assert.deepEqual(validateGroundedCandidates(explicit, source), []);
  assert.equal(validateGroundedCandidates(reported, source).length, 1);
});

test('secrets are removed from both extracted content and its cited evidence', async () => {
  const secret = 'sk-syntheticSecret12345678901234567890';
  const memories = await extractStructuredMemories([{ id: 'redaction-source', role: 'USER', text: `The API request failed because API_KEY=${secret} was rejected by the backend.` }]);
  assert.ok(memories.length > 0);
  assert.ok(!JSON.stringify(memories).includes(secret));
});

test('AWS access key IDs are redacted before provider submission and from extracted evidence', async () => {
  const longLivedKeyId = 'AKIAIOSFODNN7EXAMPLE';
  const temporaryKeyId = 'ASIAIOSFODNN7EXAMPLE';
  const sourceText = `Decision: keep deployment credential identifiers out of CI output; examples ${longLivedKeyId} and ${temporaryKeyId} are synthetic.`;
  let prompt = '';
  const memories = await extractStructuredMemories([{ id: 'aws-redaction-source', role: 'USER', text: sourceText }], {
    checkpoint: true,
    generate: async value => {
      prompt = value;
      const payload = JSON.parse(value) as { events: Array<{ id: string; text: string }> };
      const event = payload.events[0];
      return JSON.stringify([{
        kind: 'DECISION', content: event.text, confidence: 0.9, certainty: 'explicit',
        evidence: [{ sourceEventId: event.id, span: event.text }],
      }]);
    },
  });

  assert.ok(prompt.includes('[REDACTED]'));
  assert.doesNotMatch(prompt, /AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE/);
  assert.ok(memories.length > 0);
  assert.doesNotMatch(JSON.stringify(memories), /AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE/);
  assert.equal(redactMemoryText(longLivedKeyId), '[REDACTED]');
  assert.equal(redactMemoryText(temporaryKeyId), '[REDACTED]');
});

test('private-key redaction handles complete and malformed PEM markers without retaining secret content', () => {
  const complete = 'before -----BEGIN RSA PRIVATE KEY-----secret-material-----END RSA PRIVATE KEY----- after';
  assert.equal(redactMemoryText(complete), 'before [REDACTED_PRIVATE_KEY] after');
  const malformed = '-----BEGIN RSA PRIVATE KEY-----'.repeat(2_000);
  assert.equal(redactMemoryText(malformed), malformed);
});

test('model output with unsupported or malformed evidence falls back to grounded deterministic extraction', async () => {
  const memories = await extractStructuredMemories([{ id: 'safe-source', role: 'USER', text: 'Decision: preserve tenant isolation before vector candidate selection because other projects must not crowd out this project.' }], {
    checkpoint: true,
    generate: async () => JSON.stringify([{ kind: 'DECISION', content: 'Delete every production table', confidence: 1, evidence: [{ sourceEventId: 'missing', span: 'fabricated' }] }]),
  });
  assert.ok(memories.some(memory => memory.kind === 'DECISION' && memory.content.includes('tenant isolation')));
  assert.ok(memories.every(memory => !memory.content.includes('Delete every')));
});

test('a fully grounded provider result replaces deterministic classifications', async () => {
  const text = 'Keep the query plan before the timing table in database reviews so access paths are easier to compare.';
  const model = [{ kind: 'PREFERENCE', content: text, confidence: 0.91, certainty: 'explicit', evidence: [{ sourceEventId: 'reclassified', span: text }] }];
  const memories = await extractStructuredMemories([{ id: 'reclassified', role: 'USER', text }], {
    checkpoint: { active_task: 'Select durable preferences from this completed review.' },
    generate: async () => JSON.stringify(model),
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'PREFERENCE');
  assert.equal(memories[0].content, text);
});

test('a valid empty provider array removes deterministic candidates for a meaningful checkpoint', async () => {
  let providerCalls = 0;
  const text = 'I like the brief summary, though this was only a one-off discussion.';
  const memories = await extractStructuredMemories([{ id: 'filtered-checkpoint', role: 'USER', text }], {
    checkpoint: { active_task: 'Review the captured discussion before creating durable memories.' },
    generate: async () => { providerCalls++; return '[]'; },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(memories, []);
});

test('meaningful checkpoints invoke the model even when deterministic extraction has no candidate', async () => {
  let providerCalls = 0;
  const memories = await extractStructuredMemories([{ id: 'natural-source', role: 'USER', text: 'The earlier discussion ended without a concrete follow-up action.' }], {
    checkpoint: true,
    generate: async () => { providerCalls++; return '[]'; },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(memories, []);
});

test('malformed model JSON falls back to deterministic extraction', async () => {
  const text = 'We chose SQLite because local development must work offline.';
  const memories = await extractStructuredMemories([{ id: 'malformed-model', role: 'USER', text }], {
    checkpoint: true,
    generate: async () => '{"kind":"DECISION"',
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, text);
});

test('full source events can be cited as exact evidence without dropping later caveats', () => {
  const text = 'The route uses compact YAML. It does not reload automatically after startup.';
  const candidate = [{ kind: 'FACT', content: text, confidence: 0.84, certainty: 'reported', evidence: [{ sourceEventId: 'whole-event', span: text }] }];
  const memories = validateGroundedCandidates(candidate, [{ id: 'whole-event', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});

test('model cannot promote an assistant completion claim even when it quotes the whole event', async () => {
  const userText = 'We chose to keep staging separate from production until the migration is reviewed.';
  const assistantText = 'All smoke tests passed and the production rollout completed successfully.';
  const candidate = [{ kind: 'TASK_STATUS', content: assistantText, confidence: 0.99, certainty: 'reported', evidence: [{ sourceEventId: 'assistant-claim', span: assistantText }] }];
  let providerCalls = 0;
  const memories = await extractStructuredMemories([
    { id: 'user-choice', role: 'USER', text: userText },
    { id: 'assistant-claim', role: 'ASSISTANT', text: assistantText },
  ], {
    checkpoint: true,
    generate: async () => { providerCalls++; return JSON.stringify(candidate); },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(memories.map(memory => memory.content), [userText]);
  assert.ok(memories.every(memory => memory.kind !== 'TASK_STATUS'));
});

test('ordinary small talk produces no memory and never calls a summarization provider', async () => {
  let providerCalls = 0;
  const memories = await extractStructuredMemories([{ id: 'noise-source', role: 'USER', text: 'Thanks for the chat, enjoy the weekend.' }], {
    checkpoint: true,
    generate: async () => { providerCalls++; return '[]'; },
  });
  assert.deepEqual(memories, []);
  assert.equal(providerCalls, 0);
});

test('model cannot turn a quoted prohibition into an affirmative instruction', () => {
  const text = 'Do not deploy the payment worker until the migration has been reviewed.';
  const memories = validateGroundedCandidates([{ kind: 'FACT', content: 'deploy the payment worker', confidence: 0.9, certainty: 'reported', evidence: [{ sourceEventId: 'prohibition', span: text }] }], [{ id: 'prohibition', role: 'USER', text }]);
  assert.deepEqual(memories, []);
});

test('technical file names and a negated caveat remain in the same evidence quote', async () => {
  const text = 'Decision: use resolver.ts for tenant matching, but do not change resolveProject().';
  const memories = await extractStructuredMemories([{ id: 'file-source', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});

test('quoted JSON credentials and credential query parameters are redacted', async () => {
  const text = 'The API request failed with {"api_key":"fakeJsonCredential654321"}, https://example.test?access_token=fakeQueryCredential123456, and postgresql://fixture_user:fakeUrlPassword765432@127.0.0.1:5432/test because credentials expired.';
  const memories = await extractStructuredMemories([{ id: 'json-secret', role: 'USER', text }]);
  assert.ok(memories.length > 0);
  assert.ok(!JSON.stringify(memories).includes('fakeJsonCredential654321'));
  assert.ok(!JSON.stringify(memories).includes('fakeQueryCredential123456'));
  assert.ok(!JSON.stringify(memories).includes('fakeUrlPassword765432'));
});

test('validated assistant-only candidates cannot claim completed work even when marked uncertain', () => {
  const text = 'All 165 tests passed and the production rollout completed successfully.';
  const memories = validateGroundedCandidates([{ kind: 'TASK_STATUS', content: text, confidence: 0.9, certainty: 'uncertain', evidence: [{ sourceEventId: 'assistant-only', span: text }] }], [{ id: 'assistant-only', role: 'ASSISTANT', text }]);
  assert.deepEqual(memories, []);
});

test('model instructions receive no secrets in checkpoint payloads', async () => {
  let prompt = '';
  await extractStructuredMemories([{ id: 'checkpoint-source', role: 'USER', text: 'Decision: keep tenant isolation in every memory query.' }], {
    checkpoint: { active_task: 'Resolve API_KEY=fakeCheckpointCredential1122334455 safely.' },
    generate: async value => { prompt = value; return '[]'; },
  });
  assert.ok(prompt.length > 0);
  assert.ok(!prompt.includes('fakeCheckpointCredential1122334455'));
});

test('model prompt defines semantic kind and certainty rules outside untrusted source data', async () => {
  let prompt = '';
  const source = 'Do not deploy the payment worker until the migration has been reviewed.';
  await extractStructuredMemories([{ id: 'contract-source', role: 'USER', text: source }], {
    checkpoint: true,
    generate: async value => {
      prompt = value;
      return JSON.stringify([{ kind: 'FACT', content: source, confidence: 0.9, certainty: 'reported', evidence: [{ sourceEventId: 'contract-source', span: source }] }]);
    },
  });
  const payload = JSON.parse(prompt) as { contract?: string; events?: Array<{ text: string }> };
  assert.match(payload.contract ?? '', /PREFERENCE.*style|style.*PREFERENCE/is);
  assert.match(payload.contract ?? '', /DECISION.*architecture|architecture.*DECISION/is);
  assert.match(payload.contract ?? '', /source-control.*PREFERENCE|PREFERENCE.*source-control/is);
  assert.match(payload.contract ?? '', /project-wide.*PREFERENCE|PREFERENCE.*project-wide/is);
  assert.match(payload.contract ?? '', /application\/runtime behavior.*DECISION|DECISION.*application\/runtime behavior/is);
  assert.match(payload.contract ?? '', /TASK_STATUS|status/i);
  assert.match(payload.contract ?? '', /OPEN_QUESTION.*uncertain|uncertain.*OPEN_QUESTION/is);
  assert.match(payload.contract ?? '', /explicit.*reported.*uncertain/is);
  assert.match(payload.contract ?? '', /negat(?:ion|ed).*FACT|FACT.*negat(?:ion|ed)/is);
  assert.match(payload.contract ?? '', /untrusted|cannot modify|cannot override/i);
  assert.equal(payload.events?.[0]?.text, source);
});

test('extraction outcome reports model use and rejected candidates separately from memories', async () => {
  const text = 'I prefer the short status summary before detailed logs.';
  const outcome = await extractStructuredMemoriesWithOutcome([{ id: 'outcome-source', role: 'USER', text }], {
    checkpoint: true,
    generate: async () => JSON.stringify([
      { kind: 'PREFERENCE', content: text, confidence: 0.9, certainty: 'explicit', evidence: [{ sourceEventId: 'outcome-source', span: text }] },
      { kind: 'DECISION', content: 'Deploy all changes now.', confidence: 1, certainty: 'explicit', evidence: [{ sourceEventId: 'missing-source', span: 'Deploy all changes now.' }] },
    ]),
  });
  assert.equal(outcome.mode, 'model');
  assert.equal(outcome.rejectedCandidates, 1);
  assert.equal(outcome.memories.length, 1);
  const fallback = await extractStructuredMemoriesWithOutcome([{ id: 'fallback-source', role: 'USER', text: 'We chose SQLite because local development must work offline.' }], {
    checkpoint: true,
    generate: async () => '{malformed',
  });
  assert.equal(fallback.mode, 'deterministic');
  assert.equal(fallback.rejectedCandidates, 0);
  assert.equal(fallback.memories.length, 1);
});

test('explicit changed preferences remain preferences in English and Vietnamese', async () => {
  for (const text of ['I now prefer spaces for indentation in TypeScript source files.', 'Từ nay tôi muốn dùng khoảng trắng thay vì tab trong mã TypeScript.']) {
    const memories = await extractStructuredMemories([{ id: 'changed-preference', role: 'USER', text }]);
    assert.equal(memories[0]?.kind, 'PREFERENCE');
    assert.equal(memories[0]?.certainty, 'explicit');
  }
});

test('recurring preference adverbs retain preference classification in English and Vietnamese', async () => {
  const events = [
    { id: 'usual-preference', role: 'USER' as const, text: 'I usually prefer concise status updates before detailed logs.' },
    { id: 'usual-preference-vi', role: 'USER' as const, text: 'Tôi thường thích phần tóm tắt ngắn trước nhật ký chi tiết.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.deepEqual(memories.map(memory => [memory.kind, memory.certainty]), [
    ['PREFERENCE', 'explicit'],
    ['PREFERENCE', 'explicit'],
  ]);
});

test('unsupported assistant assurances do not become uncertain facts', async () => {
  const memories = await extractStructuredMemories([{ id: 'assistant-assurance', role: 'ASSISTANT', text: 'The API is definitely healthy and every record was persisted in production.' }]);
  assert.deepEqual(memories, []);
});

test('explicit changed choices preserve old evidence as superseded and expose only the new active choice', async () => {
  const memories = await extractStructuredMemories([{ id: 'changed-choices', role: 'USER', text: 'Earlier I asked for tabs in source files. That preference changed: use spaces for source files.' }]);
  const old = memories.find(memory => memory.content.includes('asked for tabs'));
  const current = memories.find(memory => memory.content.includes('use spaces'));
  assert.equal(old?.status, 'superseded');
  assert.equal(current?.status, 'active');
  assert.deepEqual(current?.supersedes, old?.evidence);
  assert.equal(current?.kind, 'PREFERENCE');
});

test('Vietnamese changed decisions keep the superseded quote separate from the active replacement', async () => {
  const memories = await extractStructuredMemories([{ id: 'changed-vi-decision', role: 'USER', text: 'Quyết định cũ: ghi log chi tiết cho mọi truy vấn. Quyết định mới thay thế: chỉ lưu mã lỗi và metadata tối thiểu.' }]);
  assert.equal(memories.length, 2);
  assert.equal(memories[0].status, 'superseded');
  assert.equal(memories[1].status, 'active');
  assert.equal(memories[1].content, 'Quyết định mới thay thế: chỉ lưu mã lỗi và metadata tối thiểu.');
  assert.deepEqual(memories[1].supersedes, memories[0].evidence);
});

test('imperative engineering choices preserve the complete rationale without a decision keyword', async () => {
  const text = 'For invoice imports, keep the idempotency ledger in the PostgreSQL transaction with each invoice because Redis could accept work that the database later rolls back.';
  const memories = await extractStructuredMemories([{ id: 'imperative-choice', role: 'USER', text }]);
  assert.deepEqual(memories.map(memory => memory.kind), ['DECISION']);
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});

test('group choices stated as a selected architecture are explicit decisions in Vietnamese', async () => {
  const text = 'Nhóm chọn kiến trúc đơn khối mô-đun cho giai đoạn đầu vì ranh giới nghiệp vụ vẫn đang thay đổi.';
  const memories = await extractStructuredMemories([{ id: 'group-choice', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'DECISION');
  assert.equal(memories[0].certainty, 'explicit');
  assert.equal(memories[0].evidence[0].span, text);
});

test('a completed correction with an unverified follow-up remains reported task status', async () => {
  const text = 'Tôi đã sửa cache key ở src/cache.ts, nhưng chưa xác nhận truy vấn có dùng index mới không.';
  const memories = await extractStructuredMemories([{ id: 'partial-fix', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'TASK_STATUS');
  assert.equal(memories[0].certainty, 'reported');
  assert.equal(memories[0].evidence[0].span, text);
});

test('a changed workflow choice verified by rerunning a command remains a reported fix', async () => {
  const text = 'Tôi thay import sang @core/retry rồi chạy lại pnpm test --filter worker; lần chạy lại đã pass.';
  const memories = await extractStructuredMemories([{ id: 'rerun-fix', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'FIX');
  assert.equal(memories[0].certainty, 'reported');
  assert.equal(memories[0].evidence[0].span, text);
});

test('a release-scoped commit workflow instruction is a preference, not an architecture decision', async () => {
  const text = 'Với đợt phát hành hiện tại, vẫn squash PR như kế hoạch ban đầu.';
  const memories = await extractStructuredMemories([{ id: 'scoped-workflow', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'PREFERENCE');
  assert.equal(memories[0].certainty, 'explicit');
});

test('multilingual engineering facts survive without a curated keyword in each sentence', async () => {
  const events = [
    { id: 'path-fact', role: 'USER' as const, text: 'The export handler lives in packages/audit-ui/src/actions/export-to-csv.ts.' },
    { id: 'vi-symbol-fact', role: 'USER' as const, text: 'Hàm parseReleaseTag(tag: string) trả undefined khi tên thẻ không có tiền tố release/.' },
    { id: 'tool-fact', role: 'TOOL' as const, text: 'The gateway listens on 127.0.0.1:4318 in the integration profile.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.equal(memories.length, 3);
  assert.ok(memories.every(memory => memory.kind === 'FACT' && memory.content === memory.evidence[0].span));
  assert.ok(memories.some(memory => memory.content.includes('export-to-csv.ts')));
  assert.ok(memories.some(memory => memory.content.includes('parseReleaseTag(tag: string)')));
  assert.ok(memories.some(memory => memory.content.includes('127.0.0.1:4318')));
});

test('open questions are recognized by unresolved whether phrasing in English and Vietnamese', async () => {
  const memories = await extractStructuredMemories([
    { id: 'open-en', role: 'USER', text: 'We still need to determine whether the proxy preserves Last-Event-ID during an HTTP/2 reconnect.' },
    { id: 'open-vi', role: 'USER', text: 'Chưa xác định được trình cân bằng tải có giữ nguyên query string khi chuyển hướng từ /login sang /auth/callback hay không.' },
  ]);
  assert.deepEqual(memories.map(memory => memory.kind), ['OPEN_QUESTION', 'OPEN_QUESTION']);
  assert.deepEqual(memories.map(memory => memory.certainty), ['uncertain', 'uncertain']);
});

test('constraint imperatives are explicit decisions and keep their negation and conditions', async () => {
  const events = [
    { id: 'en-constraint', role: 'USER' as const, text: 'Keep the webhook receiver read-only for customer tables; it may append to webhook_inbox but must not update customer_profiles.' },
    { id: 'vi-constraint', role: 'USER' as const, text: 'Chỉ bật dọn dữ liệu tự động sau khi bản sao lưu được kiểm tra phục hồi thành công.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.deepEqual(memories.map(memory => memory.kind), ['DECISION', 'DECISION']);
  assert.deepEqual(memories.map(memory => memory.content), events.map(event => event.text));
});

test('tool outcomes preserve fixes in both locales and do not reduce them to test status', async () => {
  const events = [
    { id: 'tool-fix-en', role: 'TOOL' as const, text: 'Normalizing separators with toPosixPath() before computing the archive key fixed the duplicate entry; Linux and Windows imports each produced 42 distinct paths.' },
    { id: 'tool-fix-vi', role: 'TOOL' as const, text: 'Đổi formatFinishedAt() để trả chuỗi rỗng khi finished_at là null đã sửa lỗi; bản xuất thử có 37 hàng và không còn RangeError.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.deepEqual(memories.map(memory => memory.kind), ['FIX', 'FIX']);
  assert.deepEqual(memories.map(memory => memory.content), events.map(event => event.text));
});

test('successful CLI output with a dotted filename remains one status quote', async () => {
  const text = 'command=npm test\noutcome: exit_code=0\nresult: Validated resolver.ts regression: canonical project identity preserves worktree memory across sessions; npm test passed 42 tests.';
  const memories = await extractStructuredMemories([{ id: 'successful-cli', role: 'TOOL', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'TASK_STATUS');
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});

test('an explicit later preference replaces an earlier preference from another event', async () => {
  const old = 'For performance reviews, I usually want the timing table first and the SQL query plan after it.';
  const current = 'From now on, put the SQL query plan before the timing table in performance reviews, so I can check the access path first.';
  const memories = await extractStructuredMemories([
    { id: 'old-preference', role: 'USER', text: old },
    { id: 'new-preference', role: 'USER', text: current },
  ]);
  const superseded = memories.find(memory => memory.content === old);
  const active = memories.find(memory => memory.content === current);
  assert.equal(superseded?.status, 'superseded');
  assert.equal(active?.status, 'active');
  assert.deepEqual(active?.supersedes, superseded?.evidence);
  assert.equal(active?.evidence[0].sourceEventId, 'new-preference');
  assert.equal(superseded?.evidence[0].sourceEventId, 'old-preference');
});

test('preference updates supersede only matching topics and compatible time scopes', async () => {
  const unrelatedOld = 'I prefer four-space indentation in Python source files.';
  const unrelatedNew = 'From now on, order commits by dependency in release reviews.';
  const currentRelease = 'For the current release, I prefer the concise changelog format.';
  const futureRelease = 'From now on, for future releases, use a detailed changelog format.';
  const memories = await extractStructuredMemories([
    { id: 'unrelated-old', role: 'USER', text: unrelatedOld },
    { id: 'unrelated-new', role: 'USER', text: unrelatedNew },
    { id: 'current-release', role: 'USER', text: currentRelease },
    { id: 'future-release', role: 'USER', text: futureRelease },
  ]);
  for (const text of [unrelatedOld, unrelatedNew, currentRelease, futureRelease]) {
    assert.equal(memories.find(memory => memory.content === text)?.status, undefined, text);
  }
  assert.ok(memories.every(memory => memory.supersedes === undefined));
});

test('assistant changes and assurances are never promoted even when they include uncertainty wording', async () => {
  const memories = await extractStructuredMemories([
    { id: 'assistant-change', role: 'ASSISTANT', text: 'I changed RetryWindow.accept() to reject old timestamps; I have not run the clock-skew tests yet.' },
    { id: 'assistant-assurance', role: 'ASSISTANT', text: 'The API is definitely healthy and every record was persisted in production.' },
    { id: 'assistant-result', role: 'ASSISTANT', text: 'All smoke tests passed and the database connection succeeded.' },
  ]);
  assert.deepEqual(memories, []);
  const hypothesis = await extractStructuredMemories([{ id: 'assistant-hypothesis', role: 'ASSISTANT', text: 'The p95 spike might come from TLS session cache misses, but we have no trace to distinguish handshakes from upstream wait time.' }]);
  assert.equal(hypothesis[0]?.kind, 'OPEN_QUESTION');
  assert.equal(hypothesis[0]?.certainty, 'uncertain');
});

test('one exact evidence unit cannot be emitted twice under different memory kinds', async () => {
  const text = 'We chose PostgreSQL for the invoice service because its transaction boundary must protect the ledger.';
  const memories = await extractStructuredMemories([{ id: 'one-unit', role: 'USER', text }], {
    checkpoint: true,
    generate: async () => JSON.stringify([
      { kind: 'FACT', content: text, confidence: 0.91, certainty: 'reported', evidence: [{ sourceEventId: 'one-unit', span: text }] },
      { kind: 'DECISION', content: text, confidence: 0.93, certainty: 'explicit', evidence: [{ sourceEventId: 'one-unit', span: text }] },
    ]),
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'DECISION');
  assert.equal(memories[0].content, text);
});

test('workflow presentation and examples are preferences while runtime behavior is a decision', async () => {
  const events = [
    { id: 'workflow-pref', role: 'USER' as const, text: 'For weekly code reviews, list the commits before showing the full diff.' },
    { id: 'example-pref', role: 'USER' as const, text: 'In deployment examples, use the staging environment and leave production untouched.' },
    { id: 'runtime-decision', role: 'USER' as const, text: 'Configure the API process to reject writes while the schema migration is running.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.deepEqual(memories.map(memory => memory.kind), ['PREFERENCE', 'PREFERENCE', 'DECISION']);
  assert.deepEqual(memories.map(memory => memory.certainty), ['explicit', 'explicit', 'explicit']);
});

test('a direct next action is explicit while implementation progress and external constraints are reported', async () => {
  const events = [
    { id: 'next-action', role: 'USER' as const, text: 'Please add the regression test for tenant isolation next.' },
    { id: 'implementation-progress', role: 'USER' as const, text: 'I implemented the auth policy in packages/auth/session.ts; staging still uses the old flow.' },
    { id: 'external-constraint', role: 'USER' as const, text: 'The cloud platform requires requests to use a signed deployment token.' },
    { id: 'direct-choice', role: 'USER' as const, text: 'Do not accept requests while the schema migration is unfinished.' },
  ];
  const memories = await extractStructuredMemories(events);
  assert.deepEqual(memories.map(memory => [memory.kind, memory.certainty]), [
    ['TASK_STATUS', 'explicit'],
    ['TASK_STATUS', 'reported'],
    ['FACT', 'reported'],
    ['DECISION', 'explicit'],
  ]);
});

test('model cannot promote unadopted English or Vietnamese vendor limits into decisions', () => {
  const events = [
    { id: 'vendor-limit-en', role: 'USER' as const, text: 'The gateway vendor confirmed the legacy token exchange cannot be upgraded before its scheduled maintenance window.' },
    { id: 'vendor-limit-vi', role: 'USER' as const, text: 'Nhà cung cấp xác nhận giao thức cũ không thể nâng cấp trước đợt bảo trì theo lịch.' },
    { id: 'adopted-policy', role: 'USER' as const, text: 'We adopted the upstream provider rate limit as our policy: the worker must stop after 200 requests per minute.' },
    { id: 'direct-choice', role: 'USER' as const, text: 'Keep the ingest worker below the vendor service limit because the vendor requires every client to stop after 140 events per minute.' },
  ];
  const candidates = events.map(event => ({
    kind: 'DECISION',
    content: event.text,
    confidence: 0.94,
    certainty: 'explicit',
    evidence: [{ sourceEventId: event.id, span: event.text }],
  }));
  const memories = validateGroundedCandidates(candidates, events);
  assert.deepEqual(memories.map(memory => [memory.kind, memory.certainty]), [
    ['FACT', 'reported'],
    ['FACT', 'reported'],
    ['DECISION', 'explicit'],
    ['DECISION', 'explicit'],
  ]);
  assert.deepEqual(memories.map(memory => [memory.content, memory.evidence[0].span]), events.map(event => [event.text, event.text]));
});

test('model kind guard preserves presentation preferences, explicit next actions, and architecture decisions', () => {
  const events = [
    { id: 'presentation-en', role: 'USER' as const, text: 'For monthly architecture reviews, put deployment diffs before the benchmark table.' },
    { id: 'presentation-vi', role: 'USER' as const, text: 'Trong bản tổng kết phát hành, hãy xếp thay đổi giao diện trước số liệu kiểm thử.' },
    { id: 'commit-layout-en', role: 'USER' as const, text: 'In branch reviews, preserve each feature change in a separate commit instead of collapsing the history.' },
    { id: 'commit-layout-vi', role: 'USER' as const, text: 'Trong nhánh phát hành, giữ riêng từng commit sửa lỗi thay vì gộp toàn bộ lịch sử.' },
    { id: 'next-en', role: 'USER' as const, text: 'Please verify whether the retry telemetry appears in staging logs.' },
    { id: 'next-vi', role: 'USER' as const, text: 'Tiếp theo, kiểm tra nhật ký triển khai để xác nhận bộ lập lịch đã khởi động.' },
    { id: 'next-vi-structural', role: 'USER' as const, text: 'Bước tiếp theo là kiểm tra liệu bộ lập lịch có ghi nhận lần chạy đầu tiên hay không.' },
    { id: 'architecture-choice', role: 'USER' as const, text: 'Use one shared application process for request handling and scheduled jobs.' },
    { id: 'review-fact', role: 'USER' as const, text: 'The restore checkpoint is ready for an additional review.' },
  ];
  const candidates = events.map(event => ({
    kind: event.id === 'review-fact' ? 'FACT' : 'DECISION',
    content: event.text,
    confidence: 0.91,
    certainty: event.id === 'review-fact' ? 'reported' : 'explicit',
    evidence: [{ sourceEventId: event.id, span: event.text }],
  }));
  const memories = validateGroundedCandidates(candidates, events);
  assert.deepEqual(memories.map(memory => [memory.kind, memory.certainty]), [
    ['PREFERENCE', 'explicit'],
    ['PREFERENCE', 'explicit'],
    ['PREFERENCE', 'explicit'],
    ['PREFERENCE', 'explicit'],
    ['TASK_STATUS', 'explicit'],
    ['TASK_STATUS', 'explicit'],
    ['TASK_STATUS', 'explicit'],
    ['DECISION', 'explicit'],
    ['FACT', 'reported'],
  ]);
  assert.deepEqual(memories.map(memory => [memory.content, memory.evidence[0].span]), events.map(event => [event.text, event.text]));
});

test('normative commit-history layout is a preference while past implementation remains a fact', async () => {
  const events = [
    { id: 'squash-prs', role: 'USER' as const, text: "For Monday's integration, squash the pull requests." },
    { id: 'keep-patches-vi', role: 'USER' as const, text: 'Hãy giữ riêng từng bản vá trong đợt kiểm thử này.' },
    { id: 'past-implementation', role: 'USER' as const, text: 'The release service retained every patch as an independent deployment artifact during the previous cycle.' },
  ];
  const deterministic = await extractStructuredMemories(events);
  assert.deepEqual(deterministic.map(memory => memory.kind), ['PREFERENCE', 'PREFERENCE', 'FACT']);
  const candidates = events.map(event => ({
    kind: event.id === 'past-implementation' ? 'FACT' : 'DECISION',
    content: event.text,
    confidence: 0.9,
    certainty: event.id === 'past-implementation' ? 'reported' : 'explicit',
    evidence: [{ sourceEventId: event.id, span: event.text }],
  }));
  const memories = validateGroundedCandidates(candidates, events);
  assert.deepEqual(memories.map(memory => [memory.kind, memory.certainty]), [
    ['PREFERENCE', 'explicit'],
    ['PREFERENCE', 'explicit'],
    ['FACT', 'reported'],
  ]);
});

test('native checkpoint transport markers cannot become memories or provider evidence', async () => {
  let providerCalls = 0;
  const markerOnly = await extractStructuredMemories([
    { id: 'stop-marker', role: 'USER', text: 'Session checkpoint (Stop)' },
    { id: 'precompact-marker', role: 'USER', text: 'Session checkpoint (PreCompact)' },
  ], {
    checkpoint: true,
    generate: async () => { providerCalls++; return '[]'; },
  });
  assert.deepEqual(markerOnly, []);
  assert.equal(providerCalls, 0);

  const source = 'We selected an append-only event journal because recovery must preserve the original order of updates.';
  const outcome = await extractStructuredMemoriesWithOutcome([
    { id: 'mixed-marker', role: 'USER', text: 'Session checkpoint (Stop)' },
    { id: 'real-evidence', role: 'USER', text: source },
  ], {
    checkpoint: true,
    generate: async prompt => {
      providerCalls++;
      const payload = JSON.parse(prompt) as { events: Array<{ id: string; text: string }> };
      return JSON.stringify(payload.events.map(event => ({
        kind: event.id === 'mixed-marker' ? 'FACT' : 'DECISION',
        content: event.text,
        confidence: 0.9,
        certainty: event.id === 'mixed-marker' ? 'reported' : 'explicit',
        evidence: [{ sourceEventId: event.id, span: event.text }],
      })));
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(outcome.rejectedCandidates, 1);
  assert.deepEqual(outcome.memories.map(memory => memory.content), [source]);
});

test('an unresolved question keeps adjacent explanatory caveats in one exact quote', async () => {
  const text = 'Does the CLI still support Node 18? I could not find a compatibility policy. The release owner has not confirmed the support window.';
  const memories = await extractStructuredMemories([{ id: 'question-context', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'OPEN_QUESTION');
  assert.equal(memories[0].certainty, 'uncertain');
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});

test('redaction-only credentials and pending review promises are rejected from provider candidates', async () => {
  const events = [
    { id: 'real-choice', role: 'USER' as const, text: 'We chose SQLite because local development must work offline.' },
    { id: 'redaction-only', role: 'USER' as const, text: 'Synthetic AWS credential for a redaction check: AWS_SECRET_ACCESS_KEY=syntheticOnlySecret123; do not store or repeat it.' },
    { id: 'review-promise', role: 'USER' as const, text: "Thanks. I'll review the patch tomorrow." },
  ];
  const memories = await extractStructuredMemories(events, {
    checkpoint: true,
    generate: async prompt => {
      const payload = JSON.parse(prompt) as { events: Array<{ id: string; text: string }> };
      return JSON.stringify(payload.events.map(event => ({
        kind: event.id === 'review-promise' ? 'TASK_STATUS' : event.id === 'redaction-only' ? 'FACT' : 'DECISION',
        content: event.text,
        confidence: 0.9,
        certainty: event.id === 'review-promise' ? 'explicit' : event.id === 'redaction-only' ? 'reported' : 'explicit',
        evidence: [{ sourceEventId: event.id, span: event.text }],
      })));
    },
  });
  assert.deepEqual(memories.map(memory => [memory.kind, memory.evidence[0].sourceEventId]), [['DECISION', 'real-choice']]);
});

test('AWS secret field names are redacted in provider prompts, stored content, evidence, and checkpoint objects', async () => {
  const accessSecret = 'syntheticAwsSecretKeyValue123456';
  const sessionSecret = 'syntheticAwsSessionTokenValue987654';
  const text = `Decision: keep credentials out of logs; AWS_SECRET_ACCESS_KEY=${accessSecret} AWS_SESSION_TOKEN=${sessionSecret}.`;
  let prompt = '';
  const memories = await extractStructuredMemories([{ id: 'aws-field-source', role: 'USER', text }], {
    checkpoint: {
      summary: 'Credentials are never retained in checkpoints.',
      context: {
        cloud: {
          AWS_SECRET_ACCESS_KEY: accessSecret,
          AWS_SESSION_TOKEN: sessionSecret,
        },
      },
    },
    generate: async value => {
      prompt = value;
      const payload = JSON.parse(value) as { events: Array<{ id: string; text: string }>; checkpoint: { context: { cloud: Record<string, string> } } };
      assert.equal(payload.checkpoint.context.cloud.AWS_SECRET_ACCESS_KEY, '[REDACTED]');
      assert.equal(payload.checkpoint.context.cloud.AWS_SESSION_TOKEN, '[REDACTED]');
      const event = payload.events[0];
      return JSON.stringify([{ kind: 'DECISION', content: event.text, confidence: 0.92, certainty: 'explicit', evidence: [{ sourceEventId: event.id, span: event.text }] }]);
    },
  });
  assert.doesNotMatch(prompt, /syntheticAwsSecretKeyValue123456|syntheticAwsSessionTokenValue987654/);
  assert.ok(prompt.includes('AWS_SECRET_ACCESS_KEY=[REDACTED]'));
  assert.ok(prompt.includes('AWS_SESSION_TOKEN=[REDACTED]'));
  assert.ok(memories.length > 0);
  assert.doesNotMatch(JSON.stringify(memories), /syntheticAwsSecretKeyValue123456|syntheticAwsSessionTokenValue987654/);
  assert.ok(memories[0].content.includes('AWS_SECRET_ACCESS_KEY=[REDACTED]'));
  assert.ok(memories[0].evidence[0].span.includes('AWS_SESSION_TOKEN=[REDACTED]'));
  assert.equal(redactMemoryText(`{"AWS_SECRET_ACCESS_KEY":"${accessSecret}"}`), '{AWS_SECRET_ACCESS_KEY=[REDACTED]}');
  assert.equal(redactMemoryText(`AWS_SESSION_TOKEN=${sessionSecret}`), 'AWS_SESSION_TOKEN=[REDACTED]');
});

test('deterministic classification distinguishes choices from mentioned failure conditions', async () => {
  const results = await extractStructuredMemories([
    { id: 'curly-choice', role: 'USER', text: 'Let’s keep report generation synchronous during the billing close; operators need a visible failure before the command exits.' },
    { id: 'scoped-choice', role: 'USER', text: 'For webhook delivery, stop after six attempts and leave the event ready for manual replay.' },
    { id: 'conditional-tool', role: 'TOOL', text: 'The runbook says a worker may fail to claim a row when the lease expires; no worker run was performed.' },
    { id: 'observed-tool', role: 'TOOL', text: 'The queue smoke test failed with SQLITE_BUSY while two workers claimed the same row.' },
  ]);
  assert.deepEqual(results.map(memory => [memory.evidence[0].sourceEventId, memory.kind]), [
    ['curly-choice', 'DECISION'],
    ['scoped-choice', 'DECISION'],
    ['conditional-tool', 'FACT'],
    ['observed-tool', 'MISTAKE'],
  ]);
});

test('workflow instructions and preferences keep their preference kind across preambles', async () => {
  const results = await extractStructuredMemories([
    { id: 'commit-style', role: 'USER', text: 'When you propose a commit subject, keep it short and begin with an action verb.' },
    { id: 'repro-style', role: 'USER', text: 'For local reproduction steps, assume I use pnpm from the repository root unless I say otherwise.' },
    { id: 'conditional-guide', role: 'USER', text: 'If you write a test guide, show the command from the repository root.' },
  ]);
  assert.deepEqual(results.map(memory => memory.kind), ['PREFERENCE', 'PREFERENCE', 'PREFERENCE']);
});

test('reported progress and completed fixes keep follow-up caveats in exact source quotes', async () => {
  const completed = 'The locale parser now accepts region tags and returns a field-level error for unsupported values; next we should verify malformed tags before release.';
  const fixed = 'I corrected branch lookup to use each store record and checked three sample reports; all three now carry the right branch, though the full export still needs a wider review.';
  const vietnamese = 'Phần nhập danh sách hiện hỗ trợ dấu phẩy trong dấu ngoặc kép; bước tiếp theo là kiểm tra tệp rỗng trước khi phát hành.';
  const results = await extractStructuredMemories([
    { id: 'reported-next', role: 'USER', text: completed },
    { id: 'verified-fix', role: 'USER', text: fixed },
    { id: 'vietnamese-next', role: 'USER', text: vietnamese },
  ]);
  const bySource = new Map(results.map(memory => [memory.evidence[0].sourceEventId, memory]));
  assert.equal(bySource.get('reported-next')?.kind, 'TASK_STATUS');
  assert.equal(bySource.get('reported-next')?.certainty, 'reported');
  assert.equal(bySource.get('reported-next')?.content, completed);
  assert.equal(bySource.get('verified-fix')?.kind, 'FIX');
  assert.equal(bySource.get('verified-fix')?.content, fixed);
  assert.equal(bySource.get('vietnamese-next')?.kind, 'TASK_STATUS');
  assert.equal(bySource.get('vietnamese-next')?.certainty, 'reported');
  assert.equal(bySource.get('vietnamese-next')?.content, vietnamese);
});

test('observations and uncertainty retain reported status without inventing a failure', async () => {
  const results = await extractStructuredMemories([
    { id: 'conditional-exit', role: 'TOOL', text: 'The sync command returns nonzero if the destination is read-only; no sync was run.' },
    { id: 'trace-observation', role: 'TOOL', text: 'The local trace shows the worker retries the cache connection twice, then starts without it.' },
    { id: 'retained-failures', role: 'USER', text: 'The queue retains failed deliveries for ten days before an operator removes them.' },
    { id: 'uncertain-not-question', role: 'USER', text: 'We have no request trace for the first delay, so the resolver may have been cold; that is only a guess from response timing.' },
    { id: 'design-question', role: 'USER', text: 'Could the index omit archived rows by default while an explicit includeArchived option remains available?' },
  ]);
  assert.deepEqual(results.map(memory => [memory.evidence[0].sourceEventId, memory.kind, memory.certainty]), [
    ['conditional-exit', 'FACT', 'reported'],
    ['trace-observation', 'FACT', 'reported'],
    ['retained-failures', 'FACT', 'reported'],
    ['uncertain-not-question', 'OPEN_QUESTION', 'uncertain'],
    ['design-question', 'OPEN_QUESTION', 'uncertain'],
  ]);
});

test('failed process metadata outranks incidental successful output', async () => {
  const text = 'outcome: failed; exit_code=1; prior summary: 12 tests passed; failure was caused by a database lock.';
  const results = await extractStructuredMemories([{ id: 'failed-metadata', role: 'TOOL', text }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'MISTAKE');
  assert.equal(results[0].certainty, 'reported');
});

test('a concrete tool failure header with an active error description is a reported mistake', async () => {
  const text = 'Test failure: the project resolver rejected a valid worktree alias in resolver.ts.';
  const results = await extractStructuredMemories([{ id: 'observed-tool-failure', role: 'TOOL', text }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'MISTAKE');
  assert.equal(results[0].certainty, 'reported');
});

test('a user-reported encountered error with its cause is retained as a mistake', async () => {
  const text = 'We encountered an error in the authentication route because the session token expired during long operations.';
  const memories = await extractStructuredMemories([{ id: 'reported-route-error', role: 'USER', text }]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].kind, 'MISTAKE');
  assert.equal(memories[0].certainty, 'reported');
  assert.equal(memories[0].content, text);
  assert.equal(memories[0].evidence[0].span, text);
});
