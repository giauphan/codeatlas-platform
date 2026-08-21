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

  test('supports named parameters for execute, query, and executeMany', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    await adapter.execute(
      `INSERT INTO tenants (id, name, tier) VALUES (:id, :name, :tier)`,
      { id: 'named-tenant-1', name: 'Named Tenant', tier: 'enterprise' }
    );

    const tenants = await adapter.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenants WHERE id = :id`,
      { id: 'named-tenant-1' }
    );
    assert.deepStrictEqual(tenants, [{ id: 'named-tenant-1', name: 'Named Tenant' }]);

    const result = await adapter.executeMany(
      `INSERT INTO tenants (id, name, tier) VALUES (:id, :name, :tier)`,
      [
        { id: 'named-tenant-2', name: 'Named Tenant 2', tier: 'free' },
        { id: 'named-tenant-3', name: 'Named Tenant 3', tier: 'free' },
      ]
    );
    assert.strictEqual(result.rowsAffected, 2);
  });

  test('named INSERT with more binds than columns does not throw (dream-memory regression)', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Mirrors OracleDreamingService.saveDreamMemory's SQLite path: many named binds,
    // some reused across the ON CONFLICT clause. Previously threw
    // "Too many parameter values were provided" when binds were spread positionally.
    const embedding = new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer);
    const sql = `
      INSERT INTO ai_dreaming_memory (
        id, session_id, project, provider, memory_type, content, embedding,
        importance, content_hash, confidence, status, evidence_count,
        access_count, version, tenant_id, scope, tags, related_ids
      ) VALUES (
        :id, :sessionId, :project, :provider, :memoryType, :content, :embedding,
        :importance, :contentHash, :initialConfidence, 'active', 1, 0, 1,
        :tenantId, :scope, :tagsJson, :relatedIdsJson
      )
      ON CONFLICT(project, memory_type, content_hash, tenant_id) DO UPDATE SET
        embedding = :embedding,
        content   = :content
    `;

    await adapter.execute(sql, {
      id: 'd1',
      sessionId: 's1',
      project: 'proj1',
      provider: 'claude',
      memoryType: 'KNOWLEDGE',
      content: 'A learning worth persisting across sessions.',
      embedding,
      importance: 6,
      contentHash: 'hash-1',
      initialConfidence: 0.6,
      tenantId: 't1',
      scope: null,
      tagsJson: null,
      relatedIdsJson: null,
    });

    const rows = await adapter.query<{ id: string; content: string }>(
      `SELECT id, content FROM ai_dreaming_memory WHERE id = :id`,
      { id: 'd1' }
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].content, 'A learning worth persisting across sessions.');
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

  // These exercise the exact SQL shapes OracleDreamingService emits on the
  // SQLite path, against a real in-memory DB — the migration to SQLite-default
  // must keep query/delete working end-to-end, not just in mocks.
  test('dream-memory query: named binds with LIMIT/OFFSET pagination', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const rows = [
      { id: 'd1', mt: 'KNOWLEDGE', created: '2026-08-01', imp: 8 },
      { id: 'd2', mt: 'PREFERENCE', created: '2026-08-02', imp: 5 },
      { id: 'd3', mt: 'MISTAKE', created: '2026-08-03', imp: 9 },
    ];
    for (const r of rows) {
      await adapter.execute(
        `INSERT INTO ai_dreaming_memory (id, memory_type, content, importance, status, tenant_id, created_at)
         VALUES (:id, :mt, :content, :imp, 'active', :tenantId, :created)`,
        { id: r.id, mt: r.mt, content: `content for ${r.id} long enough`, imp: r.imp, tenantId: 't1', created: r.created }
      );
    }

    // Page 1: newest first, 2 per page
    const page1 = await adapter.query<{ id: string }>(
      `SELECT id, memory_type, created_at FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND (status IS NULL OR status IN ('active', 'superseded'))
       ORDER BY created_at DESC
       LIMIT :limit OFFSET :offset`,
      { tenantId: 't1', limit: 2, offset: 0 }
    );
    assert.deepStrictEqual(page1.map(r => r.id), ['d3', 'd2']);

    // Page 2: remaining row
    const page2 = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND (status IS NULL OR status IN ('active', 'superseded'))
       ORDER BY created_at DESC
       LIMIT :limit OFFSET :offset`,
      { tenantId: 't1', limit: 2, offset: 2 }
    );
    assert.deepStrictEqual(page2.map(r => r.id), ['d1']);
  });

  test('dream-memory query: id IN (:vecId0, :vecId1) vector-id filter', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    for (const id of ['v1', 'v2', 'v3']) {
      await adapter.execute(
        `INSERT INTO ai_dreaming_memory (id, memory_type, content, status, tenant_id) VALUES (?, ?, ?, 'active', ?)`,
        [id, 'KNOWLEDGE', `content ${id} padded out to forty chars minimum`, 't1']
      );
    }

    const rows = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND id IN (:vecId0, :vecId1)`,
      { tenantId: 't1', vecId0: 'v1', vecId1: 'v3' }
    );
    assert.deepStrictEqual(rows.map(r => r.id).sort(), ['v1', 'v3']);
  });

  test('dream-memory query: scope, tags and memory_type IN filters', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, memory_type, content, status, tenant_id, scope, tags)
       VALUES (:id, :mt, :content, 'active', :tenantId, :scope, :tags)`,
      { id: 's1', mt: 'KNOWLEDGE', content: 'scoped auth login knowledge entry here', tenantId: 't1', scope: 'auth/login', tags: '["jwt","security"]' }
    );
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, memory_type, content, status, tenant_id, scope, tags)
       VALUES (:id, :mt, :content, 'active', :tenantId, :scope, :tags)`,
      { id: 's2', mt: 'PREFERENCE', content: 'unrelated preference entry padded out here', tenantId: 't1', scope: 'db/query', tags: '["sql"]' }
    );

    const rows = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId
         AND memory_type IN (:type0, :type1)
         AND (scope = :scopeExact OR scope LIKE :scopeLike)
         AND (tags LIKE :tag_like_0)`,
      {
        tenantId: 't1',
        type0: 'KNOWLEDGE', type1: 'SESSION_SUMMARY',
        scopeExact: 'auth', scopeLike: 'auth/%',
        tag_like_0: '%"jwt"%',
      }
    );
    assert.deepStrictEqual(rows.map(r => r.id), ['s1']);
  });

  test('dream-memory delete: named binds report rowsAffected', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, status, tenant_id) VALUES (?, ?, 'active', ?)`,
      ['del-1', 'a memory that will be deleted shortly here', 't1']
    );

    const hit = await adapter.execute(
      `DELETE FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
      { id: 'del-1', tenantId: 't1' }
    );
    assert.strictEqual(hit.rowsAffected, 1);

    const miss = await adapter.execute(
      `DELETE FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
      { id: 'does-not-exist', tenantId: 't1' }
    );
    assert.strictEqual(miss.rowsAffected, 0);
  });

  test('dream-memory query: tenant isolation — cross-tenant rows never returned', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, status, tenant_id) VALUES (?, ?, 'active', ?)`,
      ['t1-row', 'tenant one private memory content here padded', 'tenant-1']
    );
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, status, tenant_id) VALUES (?, ?, 'active', ?)`,
      ['t2-row', 'tenant two private memory content here padded', 'tenant-2']
    );

    const rows = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory WHERE tenant_id = :tenantId`,
      { tenantId: 'tenant-1' }
    );
    assert.deepStrictEqual(rows.map(r => r.id), ['t1-row']);
  });
});
