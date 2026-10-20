import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';
import { DreamRunLedger } from '../../src/services/dreamScheduler.js';

let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => adapter } });
mock.module('../../src/services/embeddingService.js', {
  namedExports: { generateEmbeddingsBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]) },
});
mock.module('../../src/services/dreamingService.js', {
  namedExports: { DreamingService: { _hasLifecycleColumns: true, calcInitialConfidence: () => 0.7 } },
});
const { ConsolidationEngine } = await import('../../src/services/consolidationEngine.js');

const auth = { uid: 'scheduler-tenant', tier: 'premium', keyId: 'scheduler-test' };
const embedding = new Uint8Array(new Float32Array([1, 0, 0]).buffer);

beforeEach(async () => {
  adapter = new SQLiteAdapter(':memory:');
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.close();
  mock.restoreAll();
});

test('replaying extract_concepts after an operation/ledger crash does not create duplicate concepts', async () => {
  for (const id of ['d1', 'd2', 'd3']) {
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, project, memory_type, content, embedding, importance, tenant_id)
       VALUES (:id, 'project-a', 'KNOWLEDGE', :content, :embedding, 7, :tenantId)`,
      { id, content: `evidence ${id}`, embedding, tenantId: auth.uid },
    );
  }

  const engine = new ConsolidationEngine();
  await authStorage.run(auth, () => engine.run({ operations: ['extract_concepts'] }));
  await authStorage.run(auth, () => engine.run({ operations: ['extract_concepts'] }));

  const concepts = await adapter.query<{ id: string; evidence_count: number }>(
    `SELECT id, evidence_count FROM codeatlas_concepts WHERE tenant_id = :tenantId`,
    { tenantId: auth.uid },
  );
  assert.equal(concepts.length, 1);
  assert.equal(concepts[0].evidence_count, 3);
});

test('replaying score_dreams at the same scheduled instant produces the same confidence', async () => {
  await adapter.execute(
    `INSERT INTO ai_dreaming_memory (
       id, project, provider, memory_type, content, embedding, importance, confidence, status,
       evidence_count, access_count, created_at, last_accessed_at, tenant_id
     ) VALUES (
       'd-score', 'project-a', 'test', 'KNOWLEDGE', 'stable evidence', :embedding, 7, 0.7, 'active',
       4, 3, '2026-10-01T00:00:00.000Z', '2026-10-10T00:00:00.000Z', :tenantId
     )`,
    { embedding, tenantId: auth.uid },
  );
  const engine = new ConsolidationEngine();
  const run = () => authStorage.run(auth, () => engine.run({ operations: ['score_dreams'], runAt: '2026-10-19T09:00:00.000Z' }));

  await run();
  const first = (await adapter.query<{ confidence: number }>(`SELECT confidence FROM ai_dreaming_memory WHERE id = 'd-score'`))[0].confidence;
  await run();
  const second = (await adapter.query<{ confidence: number }>(`SELECT confidence FROM ai_dreaming_memory WHERE id = 'd-score'`))[0].confidence;
  assert.equal(second, first);
});

test('a stale consolidation worker cannot mutate rows after another worker reclaims its lease', async () => {
  for (const id of ['duplicate-a', 'duplicate-b']) {
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, project, provider, memory_type, content, embedding, importance, tenant_id)
       VALUES (:id, 'project-a', 'test', 'KNOWLEDGE', :content, :embedding, 5, :tenantId)`,
      { id, content: id, embedding, tenantId: auth.uid },
    );
  }

  const ledger = new DreamRunLedger(adapter);
  const firstNow = new Date().toISOString();
  const expiredNow = new Date(Date.now() + 2000).toISOString();
  const first = await ledger.claimRun({
    jobType: 'consolidation', tenantId: auth.uid, project: 'project-a',
    scheduledFor: '2026-10-19T09:00:00.000Z', timezone: 'UTC', ownerId: 'worker-a',
    now: firstNow, leaseMs: 1000, maxAttempts: 3,
  });
  assert.ok(first);

  let entered!: () => void;
  let release!: () => void;
  const inQuery = new Promise<void>((resolve) => { entered = resolve; });
  const unblocked = new Promise<void>((resolve) => { release = resolve; });
  const originalQuery = adapter.query.bind(adapter);
  let blocked = false;
  (adapter as unknown as { query: typeof adapter.query }).query = async (sql, params) => {
    const rows = await originalQuery(sql, params);
    if (!blocked && sql.includes('SELECT id, content, embedding, importance, memory_type, project')) {
      blocked = true;
      entered();
      await unblocked;
    }
    return rows;
  };

  const engine = new ConsolidationEngine();
  const staleRun = authStorage.run(auth, () => engine.run({
    operations: ['dedup'],
    runFence: { jobKey: first.jobKey, ownerToken: first.ownerToken, fencingToken: first.fencingToken },
  }));
  await inQuery;

  const second = await ledger.claimRun({
    jobType: 'consolidation', tenantId: auth.uid, project: 'project-a',
    scheduledFor: '2026-10-19T09:00:00.000Z', timezone: 'UTC', ownerId: 'worker-b',
    now: expiredNow, leaseMs: 1000, maxAttempts: 3,
  });
  assert.ok(second);
  release();

  const report = await staleRun;
  const rows = await originalQuery<{ id: string }>(
    `SELECT id FROM ai_dreaming_memory WHERE id IN ('duplicate-a', 'duplicate-b')`,
  );
  assert.equal(report.status, 'failed');
  assert.equal(rows.length, 2, 'atomic mutation fence must block stale delete');
  assert.equal(await ledger.completeRun(first, { success: true }, new Date(Date.now() + 3000).toISOString()), false);
});
