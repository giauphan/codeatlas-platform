import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));

describe('SQLite embedding dimension safety', () => {
  let adapter: InstanceType<typeof SQLiteAdapter>;

  beforeEach(async () => {
    process.env.CODEATLAS_SQLITE_PATH = ':memory:';
    adapter = new SQLiteAdapter();
    await adapter.connect();
    await adapter.initializeSchema();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  async function insertDream(id: string, vector: number[], tenantId = 'tenant-1'): Promise<void> {
    const embedding = new Uint8Array(new Float32Array(vector).buffer);
    await adapter.execute(
      'INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)',
      [id, `memory ${id}`, embedding, tenantId],
    );
  }

  test('returns a matching 1024-dim vector', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => Math.sin(index) * 0.01);
    await insertDream('current', vector);

    const results = await adapter.searchVector('ai_dreaming_memory', vector, 5, 'tenant-1');

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'current');
    assert.ok(results[0].score > 0.99);
  });

  test('skips legacy 4096-dim vectors instead of crashing', async () => {
    const legacy = Array.from({ length: 4096 }, (_, index) => Math.sin(index) * 0.01);
    const query = Array.from({ length: 1024 }, (_, index) => Math.sin(index) * 0.01);
    await insertDream('legacy', legacy);

    const results = await adapter.searchVector('ai_dreaming_memory', query, 5, 'tenant-1');

    assert.deepEqual(results, []);
  });

  test('returns only same-dimension rows when legacy and current embeddings coexist', async () => {
    const current = Array.from({ length: 1024 }, (_, index) => Math.cos(index) * 0.01);
    const legacy = Array.from({ length: 4096 }, (_, index) => Math.cos(index) * 0.01);
    await insertDream('current', current);
    await insertDream('legacy', legacy);

    const results = await adapter.searchVector('ai_dreaming_memory', current, 5, 'tenant-1');

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'current');
  });

  test('preserves tenant isolation with dimension filtering', async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => Math.sin(index) * 0.01);
    await insertDream('tenant-1-dream', vector, 'tenant-1');
    await insertDream('tenant-2-dream', vector, 'tenant-2');

    const results = await adapter.searchVector('ai_dreaming_memory', vector, 5, 'tenant-1');

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'tenant-1-dream');
  });

  test('uses four bytes per float32 for the dimension filter', () => {
    const legacy = new Float32Array(4096);
    const current = new Float32Array(legacy.buffer, legacy.byteOffset, 1024);

    assert.equal(legacy.byteLength, 16384);
    assert.equal(current.length, 1024);
    assert.equal(current.byteLength, 4096);
  });
});
