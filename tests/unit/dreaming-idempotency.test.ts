import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
let temporaryDatabaseDir: string | undefined;
const embeddingInputs: string[] = [];
mock.module('../../src/database/factory.js', {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module('../../src/services/embeddingService.js', {
  namedExports: { generateEmbedding: async (content: string) => { embeddingInputs.push(content); return [1, 0, 0]; } },
});
const { DreamingService } = await import('../../src/services/dreamingService.js');

const tenantA = { uid: 'tenant-a', tier: 'enterprise', keyId: 'test-key' };
const tenantB = { uid: 'tenant-b', tier: 'enterprise', keyId: 'test-key' };
const payload = {
  project: 'test-project',
  sessionId: 'session-1',
  memoryType: 'KNOWLEDGE' as const,
  content: 'A durable idempotency record must preserve this useful memory content.',
  importance: 7,
  idempotencyKey: 'event-1',
};

beforeEach(async () => {
  embeddingInputs.length = 0;
  adapter = new SQLiteAdapter(':memory:');
  await adapter.initialize();
  DreamingService._hasContentHashColumn = null;
  DreamingService._hasLifecycleColumns = null;
  await DreamingService.initialize();
});

test('direct memory saves redact quoted credentials before embeddings and durable storage', async () => {
  const secret = 'synthetic-secret-direct-save';
  const result = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({ ...payload,
    content: `The service configuration contains {"api_key":"${secret}"}; preserve the offline authentication design and redact credentials.` }));
  assert.equal(result.status, 'stored');
  assert.ok(embeddingInputs.length > 0);
  assert.ok(embeddingInputs.every(value => !value.includes(secret)));
  const rows = await adapter.query<{ content: string }>('SELECT content FROM ai_dreaming_memory');
  assert.ok(rows.every(row => !row.content.includes(secret)));
  assert.match(rows[0].content, /REDACTED/);
});

afterEach(async () => {
  await adapter.disconnect();
  if (temporaryDatabaseDir) await rm(temporaryDatabaseDir, { recursive: true, force: true });
  temporaryDatabaseDir = undefined;
  mock.restoreAll();
});

test('replaying the same key and payload returns the persisted id without another row', async () => {
  const first = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));
  const replay = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));

  assert.deepEqual(first, { status: 'stored', persisted: true, id: first.id });
  assert.deepEqual(replay, { status: 'duplicate', persisted: true, id: first.id });
  assert.deepEqual(await adapter.query('SELECT id FROM ai_dreaming_memory'), [{ id: first.id }]);
});

test('canonical projects sharing a basename can save equal content and equal event keys independently', async () => {
  await authStorage.run(tenantA, async () => {
    const first = await DreamingService.saveDreamMemoryWithAck({ ...payload, project: 'same-basename', projectId: 'canonical-a' });
    const second = await DreamingService.saveDreamMemoryWithAck({ ...payload, project: 'same-basename', projectId: 'canonical-b' });
    assert.equal(first.status, 'stored'); assert.equal(second.status, 'stored');
    assert.notEqual(first.id, second.id);
    assert.equal((await adapter.query('SELECT id FROM ai_dreaming_memory')).length, 2);
    const replay = await DreamingService.saveDreamMemoryWithAck({ ...payload, project: 'same-basename', projectId: 'canonical-b' });
    assert.equal(replay.id, second.id); assert.equal(replay.status, 'duplicate');
  });
});

test('legacy uniqueness migration preserves IDs, content, lifecycle columns and canonical isolation', async () => {
  await adapter.execute('DROP TABLE ai_dreaming_memory');
  await adapter.execute(`CREATE TABLE ai_dreaming_memory (
    id TEXT PRIMARY KEY, project TEXT, memory_type TEXT, content_hash TEXT, content TEXT, tenant_id TEXT NOT NULL,
    confidence REAL, status TEXT, access_count INTEGER, custom_metadata TEXT,
    UNIQUE (project, memory_type, content_hash, tenant_id))`);
  await adapter.execute(`INSERT INTO ai_dreaming_memory (id, project, memory_type, content_hash, content, tenant_id, confidence, status, access_count, custom_metadata)
    VALUES ('legacy-id','shared','KNOWLEDGE','legacy-hash','Preserve this historical memory intact','tenant-a',0.7,'active',8,'custom-value')`);
  await adapter.initializeSchema();
  const rows = await adapter.query<Record<string, unknown>>("SELECT * FROM ai_dreaming_memory WHERE id = 'legacy-id'");
  assert.equal(rows.length, 1); assert.equal(rows[0].confidence, 0.7); assert.equal(rows[0].access_count, 8); assert.equal(rows[0].custom_metadata, 'custom-value');
  await adapter.execute(`INSERT INTO ai_dreaming_memory (id, project, project_id, memory_type, content_hash, tenant_id)
    VALUES ('a','shared','canonical-a','KNOWLEDGE','same-hash','tenant-a')`);
  await adapter.execute(`INSERT INTO ai_dreaming_memory (id, project, project_id, memory_type, content_hash, tenant_id)
    VALUES ('b','shared','canonical-b','KNOWLEDGE','same-hash','tenant-a')`);
  await adapter.initializeSchema();
  assert.equal((await adapter.query('SELECT id FROM ai_dreaming_memory')).length, 3);
});

test('a distinct key for equal content gets a durable receipt and rejects changed content later', async () => {
  const first = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));
  const equalContentNewKey = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    idempotencyKey: 'event-2',
  }));
  const reusedKeyChangedPayload = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    content: 'A different durable request must not reuse the prior event key.',
    idempotencyKey: 'event-2',
  }));

  assert.equal(first.status, 'stored');
  assert.equal(equalContentNewKey.status, 'duplicate');
  assert.equal(equalContentNewKey.id, first.id);
  assert.deepEqual(reusedKeyChangedPayload, {
    status: 'rejected',
    persisted: false,
    reason_code: 'idempotency_key_reused',
  });
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 1);
});

test('save receipts survive an adapter restart and preserve key conflict checks', async () => {
  await adapter.disconnect();
  temporaryDatabaseDir = await mkdtemp(join(tmpdir(), 'dream-save-receipt-'));
  const dbPath = join(temporaryDatabaseDir, 'test.db');
  adapter = new SQLiteAdapter(dbPath);
  await adapter.initialize();
  DreamingService._hasContentHashColumn = null;
  DreamingService._hasLifecycleColumns = null;
  await DreamingService.initialize();
  const first = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({ ...payload, idempotencyKey: 'restart-key' }));

  await adapter.disconnect();
  adapter = new SQLiteAdapter(dbPath);
  await adapter.initialize();
  DreamingService._hasContentHashColumn = null;
  DreamingService._hasLifecycleColumns = null;
  await DreamingService.initialize();
  const retry = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({ ...payload, idempotencyKey: 'restart-key' }));
  const changed = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    content: 'The durable receipt must reject the same key with altered payload content.',
    idempotencyKey: 'restart-key',
  }));

  assert.equal(first.status, 'stored');
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.id, first.id);
  assert.equal(changed.status, 'rejected');
  assert.equal(changed.reason_code, 'idempotency_key_reused');
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 1);
});

test('concurrent delivery of the same event records one memory and returns one duplicate ack', async () => {
  const results = await Promise.all([
    authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload)),
    authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload)),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ['duplicate', 'stored']);
  assert.equal(results[0].id, results[1].id);
  assert.equal((await adapter.query('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 1);
});

test('concurrent reuse of one key with different payloads stores at most one and rejects the conflict', async () => {
  const results = await Promise.all([
    authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({ ...payload, idempotencyKey: 'racing-key' })),
    authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
      ...payload,
      idempotencyKey: 'racing-key',
      content: 'A different concurrent request must not reuse that idempotency key.',
    })),
  ]);

  assert.equal(results.filter((result) => result.status === 'stored').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results.filter((result) => result.status === 'error').length, 0);
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 1);
});

test('the same key can be used independently by a different tenant', async () => {
  const first = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));
  const otherTenant = await authStorage.run(tenantB, () => DreamingService.saveDreamMemoryWithAck(payload));

  assert.equal(first.status, 'stored');
  assert.equal(otherTenant.status, 'stored');
  assert.notEqual(first.id, otherTenant.id);
  assert.deepEqual(await adapter.query('SELECT tenant_id FROM ai_dreaming_memory ORDER BY tenant_id'), [
    { tenant_id: 'tenant-a' },
    { tenant_id: 'tenant-b' },
  ]);
});

test('the same key can be used independently by a different project', async () => {
  const first = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));
  const otherProject = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    project: 'another-project',
  }));

  assert.equal(first.status, 'stored');
  assert.equal(otherProject.status, 'stored');
  assert.notEqual(first.id, otherProject.id);
  assert.equal((await adapter.query('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 2);
});

test('reusing a key with different content is rejected without exposing an id', async () => {
  await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck(payload));
  const result = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    memoryType: 'PATTERN',
  }));

  assert.deepEqual(result, {
    status: 'rejected',
    persisted: false,
    reason_code: 'idempotency_key_reused',
  });
  assert.equal((await adapter.query('SELECT COUNT(*) AS count FROM ai_dreaming_memory'))[0].count, 1);
});

test('noise filtered content returns no persisted id', async () => {
  const result = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    idempotencyKey: 'filtered-event',
    content: 'tiny',
  }));

  assert.deepEqual(result, { status: 'filtered', persisted: false, reason_code: 'noise_blocked' });
  assert.deepEqual(await adapter.query('SELECT id FROM ai_dreaming_memory'), []);
  assert.deepEqual(await adapter.query('SELECT status, memory_id FROM dream_save_receipts'), [{ status: 'filtered', memory_id: null }]);

  const replay = await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({
    ...payload,
    idempotencyKey: 'filtered-event',
    content: 'tiny',
  }));
  assert.deepEqual(replay, { status: 'filtered', persisted: false, reason_code: 'noise_blocked' });
});
