import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));

describe('SQLiteAdapter', () => {
  let adapter: InstanceType<typeof SQLiteAdapter>;

  beforeEach(() => {
    process.env.CODEATLAS_SQLITE_PATH = ':memory:';
    adapter = new SQLiteAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  test('connect, initializeSchema, checkColumnExists', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const hasId = await adapter.checkColumnExists('ai_dreaming_memory', 'id');
    const hasNonExistent = await adapter.checkColumnExists('ai_dreaming_memory', 'non_existent_col');

    assert.strictEqual(hasId, true);
    assert.strictEqual(hasNonExistent, false);
  });

  test('execute, query, executeMany CRUD operations', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // execute single
    const execRes = await adapter.execute(
      `INSERT INTO tenants (id, name, tier) VALUES (?, ?, ?)`,
      ['tenant-1', 'Test Tenant', 'enterprise']
    );
    assert.strictEqual(execRes.rowsAffected, 1);

    // query
    const tenants = await adapter.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenants WHERE id = ?`,
      ['tenant-1']
    );
    assert.strictEqual(tenants.length, 1);
    assert.strictEqual(tenants[0].name, 'Test Tenant');

    // executeMany
    const manyRes = await adapter.executeMany(
      `INSERT INTO tenants (id, name, tier) VALUES (?, ?, ?)`,
      [
        { id: 'tenant-2', name: 'Tenant 2', tier: 'free' },
        { id: 'tenant-3', name: 'Tenant 3', tier: 'free' },
      ]
    );
    assert.strictEqual(manyRes.rowsAffected, 2);

    const countRes = await adapter.query<{ count: number }>(`SELECT COUNT(*) as count FROM tenants`);
    assert.strictEqual(countRes[0].count, 3);
  });

  test('searchVector and BLOB operations', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const vector = [0.1, 0.2, 0.3];
    const blob = new Uint8Array(new Float32Array(vector).buffer);

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-1', 'Test Vector Content', blob, 'tenant-1']
    );

    const searchRes = await adapter.searchVector('ai_dreaming_memory', vector, 5, 'tenant-1');
    assert.ok(Array.isArray(searchRes));
  });

  test('graph operations (detectCircularDependencies, detectGodObjects, detectDeadCode)', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Insert semantic entities
    await adapter.execute(
      `INSERT INTO ai_semantic_memory (id, project_name, entity_type, entity_name, file_path, tenant_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e1', 'proj1', 'function', 'fn1', 'src/fn1.ts', 't1']
    );
    await adapter.execute(
      `INSERT INTO ai_semantic_memory (id, project_name, entity_type, entity_name, file_path, tenant_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e2', 'proj1', 'function', 'fn2', 'src/fn2.ts', 't1']
    );

    // Insert relational link
    await adapter.execute(
      `INSERT INTO ai_relational_memory (source_id, target_id, project_name, relationship_type, tenant_id) VALUES (?, ?, ?, ?, ?)`,
      ['e1', 'e2', 'proj1', 'calls', 't1']
    );

    const deadCode = await adapter.detectDeadCode('proj1', 't1');
    assert.ok(Array.isArray(deadCode));
    // e1 has no incoming links -> dead code candidate
    assert.strictEqual(deadCode.some(d => d.entity_name === 'fn1'), true);

    const godObjects = await adapter.detectGodObjects('proj1', 't1');
    assert.ok(Array.isArray(godObjects));

    const circular = await adapter.detectCircularDependencies('proj1', 't1');
    assert.ok(Array.isArray(circular));
  });
});
