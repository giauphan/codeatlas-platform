import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', {
  namedExports: { createDatabaseAdapter: () => adapter },
});
const { ConsolidationEngine } = await import('../../src/services/consolidationEngine.js');
const auth = { uid: 'dedup-tenant', tier: 'premium', keyId: 'test-key' };
const embedding = Buffer.from(new Float32Array([1, 0]).buffer);

beforeEach(async () => {
  adapter = new SQLiteAdapter(':memory:');
  await adapter.connect();
  await adapter.execute(`CREATE TABLE ai_dreaming_memory (
    id TEXT PRIMARY KEY, content TEXT, embedding BLOB, importance REAL,
    memory_type TEXT, project TEXT, tenant_id TEXT, provider TEXT
  )`);
});
afterEach(async () => {
  await adapter.disconnect();
  mock.restoreAll();
});

async function insertDreams(rows: Array<Record<string, unknown>>): Promise<void> {
  await adapter.executeMany(`INSERT INTO ai_dreaming_memory
    (id, content, embedding, importance, memory_type, project, tenant_id, provider)
    VALUES (:id, 'fixture', :embedding, :importance, 'PATTERN', :project, :tenantId, 'fixture')`,
  rows.map(row => ({ embedding, importance: 0.5, tenantId: auth.uid, ...row })));
}

test('deduplication batches across projects while preserving project and tenant boundaries', async () => {
  await insertDreams([
    { id: 'a-high', project: 'a', importance: 0.9 }, { id: 'a-low', project: 'a' },
    { id: 'b-low', project: 'b' }, { id: 'b-high', project: 'b', importance: 0.9 },
    { id: 'c-high', project: 'c', importance: 0.9 }, { id: 'c-low', project: 'c' },
    { id: 'singleton-1', project: 'singleton-1' }, { id: 'singleton-2', project: 'singleton-2' },
    { id: 'invalid', project: 'a', embedding: null },
    { id: 'other-tenant', project: 'a', tenantId: 'other-tenant' },
  ]);
  const execute = mock.method(adapter, 'execute');
  const report = await authStorage.run(auth, () => new ConsolidationEngine().run({ operations: ['dedup'] }));

  assert.equal(report.status, 'completed');
  assert.equal(report.dreamsProcessed, 9);
  assert.equal(report.dreamsMerged, 3);
  assert.equal(report.invalidEmbeddingsSkipped, 1);
  assert.deepEqual(await adapter.query('SELECT id FROM ai_dreaming_memory ORDER BY id'), [
    { id: 'a-high' }, { id: 'b-high' }, { id: 'c-high' }, { id: 'invalid' },
    { id: 'other-tenant' }, { id: 'singleton-1' }, { id: 'singleton-2' },
  ]);
  const deletes = execute.mock.calls.filter(call => call.arguments[0].startsWith('DELETE'));
  assert.equal(deletes.length, 1, 'small project batches should share one DELETE');
  assert.equal((deletes[0].arguments[1] as Record<string, unknown>).tenantId, auth.uid);
});

test('deduplication bounds each DELETE to 900 IDs across many projects', async () => {
  const rows = Array.from({ length: 901 }, (_, i) => [
    { id: `${i}-high`, project: `p${i}`, importance: 0.9 },
    { id: `${i}-low`, project: `p${i}`, importance: 0.1 },
  ]).flat();
  await insertDreams(rows);
  const execute = mock.method(adapter, 'execute');
  const report = await authStorage.run(auth, () => new ConsolidationEngine().run({ operations: ['dedup'] }));

  assert.equal(report.dreamsMerged, 901);
  assert.deepEqual(await adapter.query('SELECT COUNT(*) AS remaining FROM ai_dreaming_memory'), [{ remaining: 901 }]);
  const deletes = execute.mock.calls.filter(call => call.arguments[0].startsWith('DELETE'));
  assert.equal(deletes.length, 2);
  assert.deepEqual(deletes.map(call => Object.keys(call.arguments[1]!).filter(key => key.startsWith('id')).length), [900, 1]);
  for (const call of deletes) assert.equal((call.arguments[1] as Record<string, unknown>).tenantId, auth.uid);
});
