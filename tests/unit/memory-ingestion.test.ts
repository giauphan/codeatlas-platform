import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';
let db: SQLiteAdapter;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => db } });
mock.module('../../src/services/embeddingService.js', { namedExports: { generateEmbedding: async () => null } });
const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { MemoryIngestionService } = await import('../../src/services/memoryIngestionService.js');
const { DreamDiagnostics } = await import('../../src/services/dreamDiagnostics.js');
const tenant = { uid: 'ingest-tenant', tier: 'enterprise', keyId: 'fixture' };
beforeEach(async () => { db = new SQLiteAdapter(':memory:'); await db.initialize(); await DreamingService.initialize(); });
afterEach(async () => { await db.disconnect(); });
async function capture(eventId: string, content: string, extra = {}) {
  return DreamCaptureStore.accept({ eventId, sessionId: 'source-session', project: 'display', projectId: 'canonical', actorRole: 'USER', content, ...extra });
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function seedHistoricalDecisionClassification(eventId: string, content: string): Promise<string> {
  // Build a real, grounded fallback row first, then convert its persisted
  // semantic identity to the shape of a historical wrong DECISION result.
  // This keeps the curation regression independent from today's heuristic.
  const source = await db.query<{ session_id: string; memory_ids_json: string; status: string }>(
    'SELECT session_id, memory_ids_json, status FROM dream_capture_events WHERE event_id = :eventId', { eventId },
  );
  assert.equal(source[0]?.status, 'processed');
  const oldIds = JSON.parse(source[0].memory_ids_json) as string[];
  assert.equal(oldIds.length, 1);
  const oldId = oldIds[0];
  const prior = await db.query<{ idempotency_key: string }>(
    'SELECT idempotency_key FROM ai_dreaming_memory WHERE id = :oldId', { oldId },
  );
  const legacyKey = `extract:${sha256(`grounded-v1\0${eventId}\0DECISION\0${content}`)}`;
  const legacyRequestHash = sha256(JSON.stringify({
    projectId: 'canonical', sessionId: source[0].session_id, memoryType: 'KNOWLEDGE', content,
    importance: 7, aiModel: 'grounded-v1', scope: null, tags: null, relatedIds: null,
  }));
  await db.execute(
    "UPDATE ai_dreaming_memory SET memory_type = 'KNOWLEDGE', importance = 7, idempotency_key = :legacyKey, request_hash = :requestHash WHERE id = :oldId",
    { legacyKey, requestHash: legacyRequestHash, oldId },
  );
  await db.execute(
    "UPDATE dream_memory_provenance SET kind = 'DECISION', certainty = 'explicit' WHERE memory_id = :oldId",
    { oldId },
  );
  if (prior[0]?.idempotency_key) {
    await db.execute(
      'UPDATE dream_save_receipts SET idempotency_key = :legacyKey, request_hash = :requestHash WHERE project = :project AND idempotency_key = :priorKey',
      { project: 'canonical', priorKey: prior[0].idempotency_key, legacyKey, requestHash: legacyRequestHash },
    );
  }
  return oldId;
}

test('reconciliation persists grounded memories and source evidence once across replays', async () => {
  await authStorage.run(tenant, async () => {
    await capture('decision-1', 'Decision: use SQLite for local storage because offline operation is required.');
    const diagnosticsBefore = DreamDiagnostics.snapshot();
    const first = await MemoryIngestionService.processPending({ projectId: 'canonical' });
    assert.equal(first.success, true);
    assert.equal(first.stored, 1);
    assert.equal(first.events_processed, 1);
    assert.equal(first.memory_ids.length, 1);
    const diagnosticsAfter = DreamDiagnostics.snapshot();
    assert.equal(diagnosticsAfter.reconciliation_runs - diagnosticsBefore.reconciliation_runs, 1);
    assert.equal(diagnosticsAfter.reconciliation_processed - diagnosticsBefore.reconciliation_processed, 1);
    assert.ok(diagnosticsAfter.reconciliation_duration_ms_total >= diagnosticsBefore.reconciliation_duration_ms_total);
    assert.equal((await MemoryIngestionService.processPending()).stored, 0);
    const evidence = await db.query<{ source_event_id: string; span: string }>('SELECT source_event_id, span FROM dream_memory_evidence');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].source_event_id, 'decision-1');
    assert.match(evidence[0].span, /because offline operation/);
    const result = await DreamingService.queryDreamMemoriesWithStatus('display', 'SQLite', 10, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'canonical');
    assert.ok(result.memories.some(row => row.id === first.memory_ids[0]));
    const replay = await capture('decision-1', 'Decision: use SQLite for local storage because offline operation is required.');
    assert.deepEqual(replay.memory_ids, first.memory_ids);
  });
});

test('a pending Stop marker is reconciled after same-tenant user and tool sources were processed earlier', async () => {
  await authStorage.run(tenant, async () => {
    await capture('stop-prior-user', 'Next action: restore stop-checkpoint.ts context in the following session.');
    const userResult = await MemoryIngestionService.processPending({ projectId: 'canonical', eventId: 'stop-prior-user' });
    assert.equal(userResult.success, true);
    assert.equal(userResult.events_processed + userResult.events_filtered, 1);

    await DreamCaptureStore.accept({ eventId: 'stop-prior-tool', sessionId: 'source-session', project: 'display', projectId: 'canonical', actorRole: 'TOOL', toolName: 'Bash', content: '[Bash]\ninput: command=npm test\noutcome: exit_code=0\nresult: stop-checkpoint.test.ts passed 42 tests.' });
    const toolResult = await MemoryIngestionService.processPending({ projectId: 'canonical', eventId: 'stop-prior-tool' });
    assert.equal(toolResult.success, true);
    assert.equal(toolResult.events_processed + toolResult.events_filtered, 1);

    await capture('stop-marker-only-pending', 'Session checkpoint (Stop)', { checkpoint: { trigger: 'Stop' } });
    const pendingBefore = await DreamCaptureStore.reconcilePending({ projectId: 'canonical' });
    assert.deepEqual(pendingBefore.map(event => event.eventId), ['stop-marker-only-pending']);
    const result = await MemoryIngestionService.processPending({ projectId: 'canonical' });
    assert.equal(result.success, true);
    assert.equal(result.failed, 0);
    assert.equal(result.events_processed + result.events_filtered, 1);
    assert.equal((await DreamCaptureStore.reconcilePending({ projectId: 'canonical' })).length, 0);
    const statuses = await db.query<{ event_id: string; status: string }>(`SELECT event_id, status FROM dream_capture_events
      WHERE tenant_id = :tenant AND project_id = 'canonical' AND event_id IN ('stop-prior-user', 'stop-prior-tool', 'stop-marker-only-pending') ORDER BY event_id`, { tenant: tenant.uid });
    assert.deepEqual(statuses, [
      { event_id: 'stop-marker-only-pending', status: 'filtered' },
      { event_id: 'stop-prior-tool', status: 'processed' },
      { event_id: 'stop-prior-user', status: 'processed' },
    ]);
  });
});

test('legacy capture schema adds acknowledgement columns without losing rows or custom schema', async () => {
  await authStorage.run(tenant, async () => {
    await db.execute('DROP TABLE dream_capture_events');
    await db.execute(`CREATE TABLE dream_capture_events (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, project TEXT NOT NULL,
      display_name TEXT, workspace_path TEXT, event_id TEXT NOT NULL, session_id TEXT NOT NULL,
      actor_role TEXT, memory_type_hint TEXT, tool_name TEXT, request_hash TEXT NOT NULL,
      content_redacted TEXT NOT NULL, checkpoint_json TEXT, occurred_at TEXT, source_spans_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      capture_sequence INTEGER, operator_marker TEXT,
      PRIMARY KEY (tenant_id, project_id, event_id)
    )`);
    await db.execute(`CREATE TABLE legacy_capture_audit (event_id TEXT NOT NULL, status TEXT NOT NULL)`);
    await db.execute('CREATE INDEX idx_legacy_capture_operator_marker ON dream_capture_events(operator_marker)');
    await db.execute(`CREATE TRIGGER legacy_capture_status_audit AFTER UPDATE OF status ON dream_capture_events
      BEGIN INSERT INTO legacy_capture_audit(event_id, status) VALUES (NEW.event_id, NEW.status); END`);
    await db.execute(`INSERT INTO dream_capture_events
      (tenant_id, project_id, project, event_id, session_id, actor_role, request_hash, content_redacted, status, created_at, capture_sequence, operator_marker)
      VALUES (:tenant, 'canonical', 'display', 'legacy-existing', 'legacy-session', 'USER', 'existing-hash', 'Existing verified source.', 'processed', '2026-10-01T00:00:00Z', 41, 'preserve-this')`,
    { tenant: tenant.uid });

    await db.initialize();
    await db.initialize();
    const schema = await db.query<{ name: string }>("PRAGMA table_info(dream_capture_events)");
    assert.ok(schema.some(column => column.name === 'memory_ids_json'));
    assert.ok(schema.some(column => column.name === 'acknowledged_at'));
    const existing = await db.query<{ request_hash: string; content_redacted: string; status: string; capture_sequence: number; operator_marker: string; memory_ids_json: string; acknowledged_at: string | null }>(
      "SELECT request_hash, content_redacted, status, capture_sequence, operator_marker, memory_ids_json, acknowledged_at FROM dream_capture_events WHERE event_id = 'legacy-existing'",
    );
    assert.deepEqual(existing, [{ request_hash: 'existing-hash', content_redacted: 'Existing verified source.', status: 'processed', capture_sequence: 41, operator_marker: 'preserve-this', memory_ids_json: '[]', acknowledged_at: null }]);
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_legacy_capture_operator_marker'")).length, 1);
    assert.equal((await db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_capture_status_audit'")).length, 1);

    const content = 'Decision: use SQLite for local storage because offline operation is required.';
    const first = await capture('legacy-upgraded-new', content);
    const replayBeforeIngestion = await capture('legacy-upgraded-new', content);
    assert.equal(first.status, 'stored');
    assert.equal(first.acknowledged, true);
    assert.deepEqual(replayBeforeIngestion.memory_ids, []);
    assert.equal(replayBeforeIngestion.status, 'duplicate');
    const result = await MemoryIngestionService.processPending({ projectId: 'canonical' });
    assert.equal(result.success, true);
    assert.equal(result.stored, 1);
    assert.equal(result.memory_ids.length, 1);
    const replayAfterIngestion = await capture('legacy-upgraded-new', content);
    assert.equal(replayAfterIngestion.status, 'duplicate');
    assert.deepEqual(replayAfterIngestion.memory_ids, result.memory_ids);
    const receipt = await db.query<{ status: string; memory_ids_json: string; acknowledged_at: string | null }>(
      "SELECT status, memory_ids_json, acknowledged_at FROM dream_capture_events WHERE event_id = 'legacy-upgraded-new'",
    );
    assert.equal(receipt[0].status, 'processed');
    assert.deepEqual(JSON.parse(receipt[0].memory_ids_json), result.memory_ids);
    assert.ok(receipt[0].acknowledged_at);
    assert.equal((await db.query("SELECT event_id, status FROM legacy_capture_audit WHERE event_id = 'legacy-upgraded-new' ORDER BY rowid DESC LIMIT 1"))[0].status, 'processed');
    assert.equal((await db.query('SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = :eventId', { eventId: 'legacy-upgraded-new' })).length, 1);
  });
});

test('new source strengthens evidence exactly once without replay confidence inflation', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'Decision: use SQLite for local storage because offline operation is required.';
    await capture('a', text); await MemoryIngestionService.processPending();
    await capture('b', text); await MemoryIngestionService.processPending();
    const before = await db.query<{ evidence_count: number; confidence: number }>('SELECT evidence_count, confidence FROM ai_dreaming_memory');
    assert.equal(before.length, 1);
    assert.equal(before[0].evidence_count, 2);
    await capture('b', text); await MemoryIngestionService.processPending();
    assert.deepEqual(await db.query('SELECT evidence_count, confidence FROM ai_dreaming_memory'), before);
  });
});

test('partial persistence failure remains pending and retry repairs evidence without duplicate memories', async () => {
  await authStorage.run(tenant, async () => {
    await capture('retry', 'Decision: preserve tenant boundaries for every stored memory because isolation is required.');
    const execute = db.execute.bind(db);
    let fail = true;
    db.execute = async (...args) => {
      if (fail && args[0].includes('INSERT INTO dream_memory_evidence')) { fail = false; throw new Error('simulated evidence failure'); }
      return execute(...args);
    };
    assert.equal((await MemoryIngestionService.processPending()).success, false);
    assert.equal((await DreamCaptureStore.reconcilePending()).length, 1);
    const retry = await MemoryIngestionService.processPending();
    assert.equal(retry.success, true);
    assert.equal((await db.query('SELECT id FROM ai_dreaming_memory')).length, 1);
    assert.equal((await db.query('SELECT source_event_id FROM dream_memory_evidence')).length, 1);
  });
});

test('noise is explicitly filtered with zero saved memories; assistant claims stay unverified', async () => {
  await authStorage.run(tenant, async () => {
    await capture('noise', 'Thanks, enjoy the weekend!');
    await capture('claim', 'I will deploy everything and all tests will pass tomorrow.', { actorRole: 'ASSISTANT' });
    const result = await MemoryIngestionService.processPending();
    assert.equal(result.stored, 0);
    assert.equal(result.events_filtered, 2);
    assert.equal(result.success, true);
    assert.equal((await db.query('SELECT id FROM ai_dreaming_memory')).length, 0);
    assert.equal((await DreamCaptureStore.reconcilePending()).length, 0);
    assert.equal((await capture('noise', 'Thanks, enjoy the weekend!')).status, 'filtered');
  });
});

test('explicit changed preference supersedes only the same topic and preserves audit evidence', async () => {
  await authStorage.run(tenant, async () => {
    await capture('old', 'I prefer tabs for indentation in TypeScript source files.', { occurredAt: '2026-10-01T00:00:00Z' });
    await MemoryIngestionService.processPending();
    await capture('other-topic', 'I prefer JSON for API response formatting in our service.', { occurredAt: '2026-10-02T00:00:00Z' });
    await MemoryIngestionService.processPending();
    await capture('new', 'I now prefer spaces for indentation in TypeScript source files.', { occurredAt: '2026-10-03T00:00:00Z' });
    await MemoryIngestionService.processPending();
    const rows = await db.query<{ content: string; status: string }>('SELECT content, status FROM ai_dreaming_memory');
    assert.equal(rows.find(row => row.content.includes('tabs'))?.status, 'superseded');
    assert.equal(rows.find(row => row.content.includes('JSON'))?.status, 'active');
    assert.equal(rows.find(row => row.content.includes('spaces'))?.status, 'active');
    assert.equal((await db.query('SELECT source_event_id FROM dream_memory_evidence')).length, 3);
    const retrieved = await DreamingService.queryDreamMemoriesWithStatus('display', 'indentation', 10, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'canonical');
    assert.ok(retrieved.memories.some(row => String(row.content).includes('spaces')));
    assert.ok(!retrieved.memories.some(row => String(row.content).includes('tabs')));
  });
});

test('retention removes processed source bodies only after cutoff, preserving evidence and pending work', async () => {
  await authStorage.run(tenant, async () => {
    await capture('processed', 'Decision: preserve source evidence for audit because raw session data must expire.');
    await MemoryIngestionService.processPending();
    await capture('pending', 'Decision: this event has not been processed yet and must remain retryable.');
    await db.execute("UPDATE dream_capture_events SET created_at = '2026-01-01T00:00:00Z'");
    const result = await MemoryIngestionService.expireProcessedSources({ before: '2026-02-01T00:00:00Z' });
    assert.equal(result.expired, 1);
    const rows = await db.query<{ event_id: string; content_redacted: string; status: string }>('SELECT event_id, content_redacted, status FROM dream_capture_events');
    assert.equal(rows.find(row => row.event_id === 'processed')?.content_redacted, '[SOURCE_EXPIRED]');
    assert.match(rows.find(row => row.event_id === 'pending')!.content_redacted, /must remain retryable/);
    assert.equal((await db.query('SELECT source_event_id FROM dream_memory_evidence')).length, 1);
  });
});

test('capture reconciliation requires authentication even when a tenant is supplied', async () => {
  await assert.rejects(() => DreamCaptureStore.reconcilePending({ tenantId: tenant.uid }), /auth/i);
  await assert.rejects(() => authStorage.run(tenant, () => MemoryIngestionService.processPending({ tenantId: 'other-tenant' })), /scope|admin|tenant/i);
});

test('authoritative checkpoint reclassification retires wrong active rows and retains their audit evidence', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'Keep the query plan before the timing table in database reviews so access paths are easier to compare.';
    await capture('model-reclass-source', text);
    const fallback = await MemoryIngestionService.processPending();
    assert.equal(fallback.success, true);
    const historicalId = await seedHistoricalDecisionClassification('model-reclass-source', text);
    assert.equal((await db.query<{ kind: string }>('SELECT kind FROM dream_memory_provenance WHERE memory_id = :historicalId', { historicalId }))[0]?.kind, 'DECISION');

    await capture('model-reclass-marker', 'The checkpoint remains ready for model review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const reviewed = await MemoryIngestionService.processPending({ generate: async () => JSON.stringify([
      { kind: 'PREFERENCE', content: text, confidence: 0.91, certainty: 'explicit', evidence: [{ sourceEventId: 'model-reclass-source', span: text }] },
    ]) });
    assert.equal(reviewed.success, true);
    assert.equal(reviewed.events_filtered, 1);
    const rows = await db.query<{ id: string; content: string; status: string; kind: string }>(`SELECT memory.id, memory.content, memory.status, provenance.kind
      FROM ai_dreaming_memory memory JOIN dream_memory_provenance provenance ON provenance.memory_id = memory.id
      WHERE memory.tenant_id = :tenant AND memory.project_id = 'canonical'`, { tenant: tenant.uid });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.status === 'active').length, 1);
    assert.equal(rows.find(row => row.status === 'active')?.kind, 'PREFERENCE');
    assert.equal(rows.find(row => row.kind === 'DECISION')?.status, 'superseded');
    assert.equal((await db.query("SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = 'model-reclass-source'")).length, 2);
    const sourceReceipt = await db.query<{ status: string; memory_ids_json: string }>("SELECT status, memory_ids_json FROM dream_capture_events WHERE event_id = 'model-reclass-source'");
    assert.equal(sourceReceipt[0].status, 'processed');
    assert.deepEqual(JSON.parse(sourceReceipt[0].memory_ids_json), reviewed.memory_ids);
    const markerReceipt = await db.query<{ status: string; memory_ids_json: string }>("SELECT status, memory_ids_json FROM dream_capture_events WHERE event_id = 'model-reclass-marker'");
    assert.equal(markerReceipt[0].status, 'filtered');
    assert.deepEqual(JSON.parse(markerReceipt[0].memory_ids_json), []);
  });
});

test('authoritative empty checkpoint filters pending batch and retires fallback rows without deleting audit', async () => {
  await authStorage.run(tenant, async () => {
    await capture('model-empty-source', 'We chose SQLite because local development must work offline.');
    await MemoryIngestionService.processPending();
    await capture('model-empty-marker', 'The checkpoint has no new durable note.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const result = await MemoryIngestionService.processPending({ generate: async () => '[]' });
    assert.equal(result.success, true);
    assert.equal(result.events_filtered, 1);
    assert.equal(result.memory_ids.length, 0);
    const memories = await db.query<{ status: string }>("SELECT status FROM ai_dreaming_memory WHERE tenant_id = :tenant", { tenant: tenant.uid });
    assert.deepEqual(memories.map(row => row.status), ['superseded']);
    assert.equal((await db.query("SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = 'model-empty-source'")).length, 1);
    const captureRows = await db.query<{ event_id: string; status: string; memory_ids_json: string }>("SELECT event_id, status, memory_ids_json FROM dream_capture_events WHERE event_id IN ('model-empty-source', 'model-empty-marker')");
    assert.equal(captureRows.length, 2);
    assert.ok(captureRows.every(row => row.status === 'filtered' && JSON.parse(row.memory_ids_json).length === 0));
    const replay = await capture('model-empty-source', 'We chose SQLite because local development must work offline.');
    assert.equal(replay.status, 'filtered');
    assert.equal(replay.persisted, false);
    assert.deepEqual(replay.memory_ids, []);
    const receipts = await db.query<{ outcome_json: string }>("SELECT outcome_json FROM dream_extraction_receipts WHERE marker_event_id = 'model-empty-marker'");
    assert.equal(receipts.length, 1);
    assert.deepEqual(JSON.parse(receipts[0].outcome_json).memories, []);
  });
});

test('checkpoint selection promotes a previously filtered source before duplicate ACK', async () => {
  await authStorage.run(tenant, async () => {
    // This interrogative is intentionally outside the deterministic question grammar.
    // Model selection must still be able to promote a previously filtered source.
    const text = 'Which resolver-cache keys survive a worker restart?';
    await capture('filtered-source-model-selected', text);
    const fallback = await MemoryIngestionService.processPending();
    assert.equal(fallback.events_filtered, 1);
    assert.equal((await capture('filtered-source-model-selected', text)).status, 'filtered');

    await capture('filtered-source-model-marker', 'The checkpoint is ready for review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const reviewed = await MemoryIngestionService.processPending({ generate: async () => JSON.stringify([
      { kind: 'OPEN_QUESTION', content: text, confidence: 0.9, certainty: 'uncertain', evidence: [{ sourceEventId: 'filtered-source-model-selected', span: text }] },
    ]) });
    assert.equal(reviewed.success, true);
    assert.equal(reviewed.memory_ids.length, 1);
    const receipt = await db.query<{ status: string; memory_ids_json: string }>("SELECT status, memory_ids_json FROM dream_capture_events WHERE event_id = 'filtered-source-model-selected'");
    assert.equal(receipt[0].status, 'processed');
    assert.deepEqual(JSON.parse(receipt[0].memory_ids_json), reviewed.memory_ids);

    const replay = await capture('filtered-source-model-selected', text);
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.persisted, true);
    assert.deepEqual(replay.memory_ids, reviewed.memory_ids);
  });
});

test('provider failure uses deterministic fallback without curation retirement', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'We chose SQLite because local development must work offline.';
    await capture('model-failure', text, { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const first = await MemoryIngestionService.processPending();
    const originalId = first.memory_ids[0];
    await db.execute("UPDATE dream_capture_events SET status = 'pending', memory_ids_json = '[]' WHERE event_id = 'model-failure'");
    const retry = await MemoryIngestionService.processPending({ generate: async () => { throw new Error('synthetic provider failure'); } });
    assert.equal(retry.success, true);
    assert.deepEqual(retry.memory_ids, [originalId]);
    assert.equal((await db.query<{ status: string }>('SELECT status FROM ai_dreaming_memory WHERE id = :id', { id: originalId }))[0].status, 'active');
    assert.equal((await db.query<{ status: string }>("SELECT status FROM dream_capture_events WHERE event_id = 'model-failure'"))[0].status, 'processed');
  });
});

test('checkpoint model reviews preexisting fastpath sources and retains selected rows', async () => {
  await authStorage.run(tenant, async () => {
    const oldText = 'We chose SQLite because local development must work offline.';
    await capture('already-processed', oldText);
    const first = await MemoryIngestionService.processPending();
    const oldMemoryId = first.memory_ids[0];
    await capture('later-checkpoint', 'The checkpoint remains ready for review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    let prompt = '';
    const later = await MemoryIngestionService.processPending({ generate: async value => {
      prompt = value;
      return JSON.stringify([{ kind: 'DECISION', content: oldText, confidence: 0.9, certainty: 'explicit', evidence: [{ sourceEventId: 'already-processed', span: oldText }] }]);
    } });
    const payload = JSON.parse(prompt) as { events: Array<{ id: string }> };
    assert.ok(payload.events.some(event => event.id === 'already-processed'));
    assert.equal((await db.query<{ status: string }>('SELECT status FROM ai_dreaming_memory WHERE id = :id', { id: oldMemoryId }))[0].status, 'active');
    assert.equal(later.memory_ids.includes(oldMemoryId), true);
    assert.equal((await db.query<{ extractor_version: string }>('SELECT extractor_version FROM dream_memory_provenance WHERE memory_id = :id', { id: oldMemoryId }))[0].extractor_version, 'grounded-v1:model');
  });
});

test('model decision receipt survives a post-save crash and prevents provider re-execution', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'Keep the query plan before the timing table in database reviews so access paths are easier to compare.';
    await capture('receipt-source', text);
    await MemoryIngestionService.processPending();
    const historicalId = await seedHistoricalDecisionClassification('receipt-source', text);
    await capture('receipt-marker', 'The checkpoint remains ready for model review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const candidate = [{ kind: 'PREFERENCE', content: text, confidence: 0.91, certainty: 'explicit', evidence: [{ sourceEventId: 'receipt-source', span: text }] }];
    let providerCalls = 0;
    const execute = db.execute.bind(db);
    let failEvidence = true;
    db.execute = async (...args) => {
      if (failEvidence && args[0].includes('INSERT INTO dream_memory_evidence')) {
        failEvidence = false;
        throw new Error('simulated crash after model row save');
      }
      return execute(...args);
    };
    const first = await MemoryIngestionService.processPending({ generate: async () => { providerCalls++; return JSON.stringify(candidate); } });
    db.execute = execute;
    assert.equal(first.success, false);
    assert.equal(providerCalls, 1);
    assert.equal((await DreamCaptureStore.reconcilePending()).some(event => event.eventId === 'receipt-marker'), true);
    const receiptRows = await db.query<{ outcome_json: string; source_hash: string }>("SELECT outcome_json, source_hash FROM dream_extraction_receipts WHERE marker_event_id = 'receipt-marker'");
    assert.equal(receiptRows.length, 1);
    assert.ok(receiptRows[0].source_hash.length === 64);
    const partiallySaved = await db.query<{ id: string }>("SELECT id FROM ai_dreaming_memory WHERE content = :content AND memory_type = 'PREFERENCE'", { content: text });
    assert.equal(partiallySaved.length, 1);
    const expectedId = partiallySaved[0].id;

    const retry = await MemoryIngestionService.processPending({ generate: async () => { providerCalls++; return '[]'; } });
    assert.equal(retry.success, true);
    assert.equal(providerCalls, 1);
    assert.deepEqual(retry.memory_ids, [expectedId]);
    const rows = await db.query<{ id: string; status: string; kind: string }>(`SELECT memory.id, memory.status, provenance.kind
      FROM ai_dreaming_memory memory JOIN dream_memory_provenance provenance ON provenance.memory_id = memory.id
      WHERE memory.tenant_id = :tenant`, { tenant: tenant.uid });
    assert.equal(rows.find(row => row.id === expectedId)?.status, 'active');
    assert.equal(rows.find(row => row.id === expectedId)?.kind, 'PREFERENCE');
    assert.equal(rows.find(row => row.id === historicalId)?.status, 'superseded');
  });
});

test('checkpoint receipts are revalidated against the current redacted batch before reuse', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'I prefer the short status summary before detailed logs in progress updates.';
    await capture('receipt-validation-source', text);
    await MemoryIngestionService.processPending();
    await capture('receipt-validation-marker', 'The checkpoint remains ready for model review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    let providerCalls = 0;
    const selected = [{ kind: 'PREFERENCE', content: text, confidence: 0.91, certainty: 'explicit', evidence: [{ sourceEventId: 'receipt-validation-source', span: text }] }];
    await MemoryIngestionService.processPending({ generate: async () => { providerCalls++; return JSON.stringify(selected); } });
    const receipt = await db.query<{ source_hash: string }>("SELECT source_hash FROM dream_extraction_receipts WHERE marker_event_id = 'receipt-validation-marker'");
    assert.equal(receipt.length, 1);
    await db.execute(`UPDATE dream_extraction_receipts SET outcome_json = :outcome
      WHERE marker_event_id = 'receipt-validation-marker'`, { outcome: JSON.stringify({ mode: 'model', rejectedCandidates: 0, memories: [
        { ...selected[0], content: 'unattributed fabricated claim', evidence: [{ sourceEventId: 'receipt-validation-source', span: 'missing source quote' }] },
      ] }) });
    await db.execute("UPDATE dream_capture_events SET status = 'pending', memory_ids_json = '[]' WHERE event_id = 'receipt-validation-marker'");
    const retry = await MemoryIngestionService.processPending({ generate: async () => { providerCalls++; return '[]'; } });
    assert.equal(retry.success, true);
    assert.equal(providerCalls, 2);
    const saved = await db.query<{ outcome_json: string }>("SELECT outcome_json FROM dream_extraction_receipts WHERE marker_event_id = 'receipt-validation-marker'");
    assert.deepEqual(JSON.parse(saved[0].outcome_json).memories, []);
  });
});

test('later provider fallback does not reactivate a model-curated source classification', async () => {
  await authStorage.run(tenant, async () => {
    const text = 'Keep the query plan before the timing table in database reviews so access paths are easier to compare.';
    await capture('selected-model-source', text);
    await MemoryIngestionService.processPending();
    const historicalId = await seedHistoricalDecisionClassification('selected-model-source', text);
    await capture('selected-model-marker', 'The checkpoint remains ready for model review.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const first = await MemoryIngestionService.processPending({ generate: async () => JSON.stringify([
      { kind: 'PREFERENCE', content: text, confidence: 0.91, certainty: 'explicit', evidence: [{ sourceEventId: 'selected-model-source', span: text }] },
    ]) });
    assert.equal(first.success, true);

    await capture('later-fallback-marker', 'Thanks.', { checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' } });
    const fallback = await MemoryIngestionService.processPending({ generate: async () => { throw new Error('synthetic provider failure'); } });
    assert.equal(fallback.success, true);
    assert.deepEqual(fallback.memory_ids, []);
    const rows = await db.query<{ status: string; kind: string; id: string; content: string; source_event_id: string }>(`SELECT memory.status, provenance.kind, memory.id, memory.content, evidence.source_event_id FROM ai_dreaming_memory memory
      JOIN dream_memory_provenance provenance ON provenance.memory_id = memory.id JOIN dream_memory_evidence evidence ON evidence.memory_id = memory.id
      WHERE memory.tenant_id = :tenant AND evidence.source_event_id = 'selected-model-source'`, { tenant: tenant.uid });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.status === 'active').length, 1);
    assert.equal(rows.find(row => row.kind === 'PREFERENCE')?.status, 'active');
    assert.equal(rows.find(row => row.id === historicalId)?.status, 'superseded');
  });
});

test('processing disabled pauses workers and leaves pending captures untouched', async () => {
  await authStorage.run(tenant, async () => {
    await capture('paused-worker', 'Decision: preserve tenant isolation for every memory query.');
    const prior = process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
    process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = 'false';
    try {
      const result = await MemoryIngestionService.processPending();
      assert.equal(result.skipped, true);
      assert.equal(result.reason_code, 'processing_disabled');
      assert.equal(result.events_processed, 0);
      assert.equal(result.stored, 0);
      assert.equal((await DreamCaptureStore.reconcilePending()).length, 1);
      assert.equal((await db.query('SELECT id FROM ai_dreaming_memory')).length, 0);
    } finally {
      if (prior === undefined) delete process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
      else process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = prior;
    }
  });
});

test('SQLite retention compares instants within the cutoff date', async () => {
  await authStorage.run(tenant, async () => {
    await capture('before-noon', 'Decision: preserve event evidence before the midday retention cutoff.');
    await capture('after-noon', 'Decision: preserve later event evidence after the midday retention cutoff.');
    await db.execute("UPDATE dream_capture_events SET status = 'processed', created_at = '2026-10-20 08:00:00' WHERE event_id = 'before-noon'");
    await db.execute("UPDATE dream_capture_events SET status = 'processed', created_at = '2026-10-20 16:00:00' WHERE event_id = 'after-noon'");
    const result = await MemoryIngestionService.expireProcessedSources({ before: '2026-10-20T12:00:00.000Z' });
    assert.equal(result.expired, 1);
    const rows = await db.query<{ event_id: string; content_redacted: string }>("SELECT event_id, content_redacted FROM dream_capture_events WHERE event_id IN ('before-noon','after-noon')");
    assert.equal(rows.find(row => row.event_id === 'before-noon')?.content_redacted, '[SOURCE_EXPIRED]');
    assert.match(rows.find(row => row.event_id === 'after-noon')!.content_redacted, /later event evidence/);
  });
});
