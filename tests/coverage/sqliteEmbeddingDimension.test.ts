import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));

describe('SQLite Embedding Dimension Filter', () => {
  let adapter: InstanceType<typeof SQLiteAdapter>;

  beforeEach(() => {
    process.env.CODEATLAS_SQLITE_PATH = ':memory:';
    adapter = new SQLiteAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  test('query with 1024-dim vector returns matching 1024-dim results', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const vector1024 = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.01);
    const blob1024 = new Uint8Array(new Float32Array(vector1024).buffer);

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-1024', 'Test 1024-dim embedding content', blob1024, 'tenant-1']
    );

    const results = await adapter.searchVector('ai_dreaming_memory', vector1024, 5, 'tenant-1');
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'dream-1024');
    assert.ok(results[0].score > 0.99);
  });

  test('old 4096-dim rows are skipped by dimension filter', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Insert a 4096-dim (legacy) vector - 16384 bytes
    const vector4096 = Array.from({ length: 4096 }, (_, i) => Math.sin(i) * 0.01);
    const blob4096 = new Uint8Array(new Float32Array(vector4096).buffer);

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-4096', 'Legacy 4096-dim embedding content', blob4096, 'tenant-1']
    );

    // Query with 1024-dim vector - should skip the 4096-dim row
    const queryVector1024 = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.01);
    const results = await adapter.searchVector('ai_dreaming_memory', queryVector1024, 5, 'tenant-1');

    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0, '4096-dim row should be skipped when querying with 1024-dim vector');
  });

  test('mixed dimensions do not crash and return only matching dimension', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Insert 1024-dim vector
    const vector1024 = Array.from({ length: 1024 }, (_, i) => Math.cos(i) * 0.01);
    const blob1024 = new Uint8Array(new Float32Array(vector1024).buffer);
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-1024', 'Current 1024-dim embedding', blob1024, 'tenant-1']
    );

    // Insert 4096-dim legacy vector
    const vector4096 = Array.from({ length: 4096 }, (_, i) => Math.cos(i) * 0.01);
    const blob4096 = new Uint8Array(new Float32Array(vector4096).buffer);
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-4096', 'Legacy 4096-dim embedding', blob4096, 'tenant-1']
    );

    // Query with 1024-dim vector
    const results = await adapter.searchVector('ai_dreaming_memory', vector1024, 10, 'tenant-1');

    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 1, 'Should return only 1024-dim row');
    assert.strictEqual(results[0].id, 'dream-1024');
  });

  test('embedding dimension filter uses correct byte calculation', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const dimensions = [128, 256, 512, 1024, 2048, 4096];

    for (const dim of dimensions) {
      const vector = Array.from({ length: dim }, (_, i) => i * 0.001);
      const blob = new Uint8Array(new Float32Array(vector).buffer);
      
      // Verify byte length calculation: each float32 = 4 bytes
      assert.strictEqual(blob.byteLength, dim * 4);
      assert.strictEqual(new Float32Array(blob.buffer).length, dim);
    }
  });

  test('truncation of 4096-dim to 1024-dim works correctly', () => {
    // Create a 4096-dim vector with distinct values
    const original4096 = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) {
      original4096[i] = i * 0.001;
    }

    // Convert to buffer (16384 bytes)
    const buffer = original4096.buffer;
    assert.strictEqual(buffer.byteLength, 16384);

    // Truncate to 1024-dim using the correct method
    const truncated1024 = new Float32Array(buffer, 0, 1024);

    // Verify dimensions
    assert.strictEqual(truncated1024.length, 1024);
    assert.strictEqual(truncated1024.byteLength, 4096);

    // Verify values are preserved (first 1024 elements)
    for (let i = 0; i < 1024; i++) {
      assert.strictEqual(truncated1024[i], original4096[i]);
    }
  });

  test('truncation respects buffer offset for sliced buffers', () => {
    // Create a larger buffer with padding before the embedding
    const paddingBytes = 16;
    const totalBuffer = new ArrayBuffer(paddingBytes + 16384);
    const fullView = new Uint8Array(totalBuffer);

    // Fill padding with sentinel values
    for (let i = 0; i < paddingBytes; i++) {
      fullView[i] = 0xFF;
    }

    // Create 4096-dim embedding starting at offset
    const embeddingView = new Float32Array(totalBuffer, paddingBytes, 4096);
    for (let i = 0; i < 4096; i++) {
      embeddingView[i] = i * 0.001;
    }

    // Truncate using the buffer offset (this is the correct pattern)
    const truncated = new Float32Array(totalBuffer, paddingBytes, 1024);

    assert.strictEqual(truncated.length, 1024);
    assert.strictEqual(truncated.byteLength, 4096);

    // Verify first and last values
    assert.strictEqual(truncated[0], 0);
    assert.strictEqual(truncated[1023], 1.023);

    // Verify padding was not included
    const firstBytes = new Uint8Array(truncated.buffer, truncated.byteOffset, 4);
    const firstFloat = new Float32Array(firstBytes.buffer, firstBytes.byteOffset, 1)[0];
    assert.strictEqual(firstFloat, 0);
  });

  test('empty/null embeddings are handled gracefully', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Insert row with null embedding
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-null', 'Null embedding content', null, 'tenant-1']
    );

    // Query with valid vector
    const queryVector = Array.from({ length: 1024 }, () => 0.1);
    const results = await adapter.searchVector('ai_dreaming_memory', queryVector, 5, 'tenant-1');

    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0, 'Rows with null embeddings should be skipped');
  });

  test('zero-length embedding is handled gracefully', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    // Insert row with zero-length blob
    const emptyBlob = new Uint8Array(0);
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-empty', 'Empty embedding content', emptyBlob, 'tenant-1']
    );

    // Query with valid vector
    const queryVector = Array.from({ length: 1024 }, () => 0.1);
    const results = await adapter.searchVector('ai_dreaming_memory', queryVector, 5, 'tenant-1');

    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0, 'Rows with empty embeddings should be skipped');
  });

  test('tenant isolation works with dimension filter', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.01);
    const blob = new Uint8Array(new Float32Array(vector).buffer);

    // Insert same vector for two tenants
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-tenant1', 'Tenant 1 content', blob, 'tenant-1']
    );

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id) VALUES (?, ?, ?, ?)`,
      ['dream-tenant2', 'Tenant 2 content', blob, 'tenant-2']
    );

    // Query as tenant-1
    const results1 = await adapter.searchVector('ai_dreaming_memory', vector, 5, 'tenant-1');
    assert.strictEqual(results1.length, 1);
    assert.strictEqual(results1[0].id, 'dream-tenant1');

    // Query as tenant-2
    const results2 = await adapter.searchVector('ai_dreaming_memory', vector, 5, 'tenant-2');
    assert.strictEqual(results2.length, 1);
    assert.strictEqual(results2[0].id, 'dream-tenant2');
  });

  test('filterBinds are preserved with dimension filter', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.01);
    const blob = new Uint8Array(new Float32Array(vector).buffer);

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id, project) VALUES (?, ?, ?, ?, ?)`,
      ['dream-project1', 'Project 1 content', blob, 'tenant-1', 'project-1']
    );

    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, content, embedding, tenant_id, project) VALUES (?, ?, ?, ?, ?)`,
      ['dream-project2', 'Project 2 content', blob, 'tenant-1', 'project-2']
    );

    // Query with project filter in table expression
    const results = await adapter.searchVector(
      'ai_dreaming_memory WHERE tenant_id = :tenantId AND project = :project',
      vector,
      5,
      'tenant-1',
      { project: 'project-1' }
    );

    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'dream-project1');
  });
});
