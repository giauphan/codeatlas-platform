/**
 * Opt-in real-provider integration test for model extraction through durable SQLite.
 * Run with: npm run test:memory-pipeline:model
 */
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

const enabled = process.env.RUN_MODEL_MEMORY_PIPELINE === '1';
let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module('../../src/services/embeddingService.js', {
  namedExports: { generateEmbedding: async () => null, generateEmbeddingsBatch: async () => [] },
});

const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { MemoryIngestionService } = await import('../../src/services/memoryIngestionService.js');
const { SessionCheckpointService } = await import('../../src/services/sessionCheckpointService.js');

afterEach(async () => {
  mock.restoreAll();
});

test('configured model extraction persists grounded SQLite memories, retrieval, checkpoint, and receipt replay', { skip: !enabled }, async () => {
  const endpoint = process.env.CODEATLAS_MEMORY_EXTRACTION_URL?.trim();
  const model = process.env.CODEATLAS_MEMORY_EXTRACTION_MODEL?.trim();
  assert.ok(endpoint, 'RUN_MODEL_MEMORY_PIPELINE=1 requires CODEATLAS_MEMORY_EXTRACTION_URL');
  assert.ok(model, 'RUN_MODEL_MEMORY_PIPELINE=1 requires CODEATLAS_MEMORY_EXTRACTION_MODEL');
  const endpointUrl = new URL(endpoint).toString();

  const temp = await mkdtemp(join(tmpdir(), 'codeatlas-model-pipeline-'));
  const dbPath = join(temp, 'model-pipeline.sqlite');
  const previousProcessingFlag = process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = 'true';
  adapter = new SQLiteAdapter(dbPath);

  try {
    await adapter.initialize();
    await DreamingService.initialize();
    const tenant = { uid: 'synthetic-model-pipeline-tenant', tier: 'enterprise', keyId: 'synthetic-test-key' };
    const projectId = 'synthetic-model-pipeline-project';
    const project = 'synthetic-model-pipeline-display';
    const sessionId = 'synthetic-model-pipeline-session';
    const sourceTexts = new Map([
      ['model-pipeline-decision', 'Decision: use the Kepler ledger in this synthetic canary because project-scoped persistence must remain isolated.'],
      ['model-pipeline-failure', 'The synthetic Kepler query initially failed because the project filter was missing.'],
      ['model-pipeline-fix', 'Adding the project_id filter fixed the synthetic Kepler query, and the replay returned 3 matching rows.'],
    ]);
    const markerId = 'model-pipeline-checkpoint';

    const networkFetch: typeof fetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === endpointUrl) providerRequests += 1;
      return networkFetch(input, init);
    }) as typeof fetch;

    const saved = await authStorage.run(tenant, async () => {
      for (const [eventId, content] of sourceTexts) {
        const actorRole = eventId.endsWith('failure') || eventId.endsWith('fix') ? 'TOOL' as const : 'USER' as const;
        const ack = await DreamCaptureStore.accept({ eventId, sessionId, projectId, project, actorRole, content });
        assert.equal(ack.source_persisted, true);
      }
      const checkpointAck = await DreamCaptureStore.accept({
        eventId: markerId,
        sessionId,
        projectId,
        project,
        content: 'Session checkpoint (Stop)',
        checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop', summary: 'Synthetic model-to-SQLite acceptance.' },
      });
      assert.equal(checkpointAck.source_persisted, true);
      assert.deepEqual(checkpointAck.memory_ids, []);
      return MemoryIngestionService.processPending({ useModel: true });
    });

    assert.equal(saved.success, true);
    assert.ok(providerRequests > 0, 'the configured extraction provider must be called');
    assert.ok(saved.memory_ids.length > 0, 'the model must select at least one meaningful memory');
    const binds: Record<string, unknown> = { tenant: tenant.uid, projectId };
    saved.memory_ids.forEach((id, index) => { binds[`memory${index}`] = id; });
    const persisted = await adapter.query<{
      id: string; content: string; status: string; kind: string; extractor_version: string;
      source_event_id: string; span: string;
    }>(`SELECT memory.id, memory.content, memory.status, provenance.kind, provenance.extractor_version,
        evidence.source_event_id, evidence.span
      FROM ai_dreaming_memory memory
      JOIN dream_memory_provenance provenance ON provenance.tenant_id = memory.tenant_id AND provenance.project_id = memory.project_id AND provenance.memory_id = memory.id
      JOIN dream_memory_evidence evidence ON evidence.tenant_id = memory.tenant_id AND evidence.project_id = memory.project_id AND evidence.memory_id = memory.id
      WHERE memory.tenant_id = :tenant AND memory.project_id = :projectId AND memory.id IN (${saved.memory_ids.map((_, index) => `:memory${index}`).join(',')})`, binds);
    assert.ok(persisted.length > 0, 'selected memory IDs must have durable provenance and evidence');
    assert.ok(persisted.every(row => row.status === 'active' && row.extractor_version.endsWith(':model')));
    assert.ok(persisted.every(row => sourceTexts.has(row.source_event_id)));
    assert.ok(persisted.every(row => row.content === row.span && row.content === sourceTexts.get(row.source_event_id)));
    assert.ok(persisted.some(row => row.kind === 'DECISION' || row.kind === 'FIX' || row.kind === 'MISTAKE'));

    await authStorage.run(tenant, async () => {
      const retrieved = await DreamingService.queryDreamMemoriesWithStatus(
        project, 'Kepler', 20, 0, undefined, undefined, undefined, undefined, undefined, undefined, projectId,
      );
      assert.ok(retrieved.memories.some(memory => saved.memory_ids.includes(String(memory.id))));
      const checkpoint = await SessionCheckpointService.latest(projectId);
      assert.ok(checkpoint);
      assert.ok(checkpoint.decisions.some(item => item.includes('Kepler ledger')));
      assert.ok(checkpoint.source_event_ids.includes('model-pipeline-decision'));
    });

    // Re-open the same pending checkpoint from its durable provider receipt.
    // The configured model endpoint is not called again, and memory IDs stay stable.
    await adapter.execute("UPDATE dream_capture_events SET status = 'pending', memory_ids_json = '[]' WHERE tenant_id = :tenant AND project_id = :projectId AND event_id = :markerId", { tenant: tenant.uid, projectId, markerId });
    const replay = await authStorage.run(tenant, () => MemoryIngestionService.processPending({ useModel: true }));
    assert.equal(replay.success, true);
    assert.deepEqual(replay.memory_ids, saved.memory_ids);
    assert.equal(providerRequests, 1, 'the receipt replay must not call the provider again');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProcessingFlag === undefined) delete process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
    else process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = previousProcessingFlag;
    await adapter.disconnect();
    await rm(temp, { recursive: true, force: true });
  }
});
