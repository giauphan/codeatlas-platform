import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const named = { ...mockObj };
  delete named.default;
  const def = 'default' in mockObj ? mockObj.default : mockObj;
  const opts = { defaultExport: def, namedExports: named };

  const specs = new Set<string>([specifier]);

  if (!specifier.startsWith('/') && !specifier.startsWith('.')) {
    specs.add(specifier);
  } else {
    const absPath = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(import.meta.dirname, specifier);
    specs.add(absPath);
    specs.add(pathToFileURL(absPath).href);
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

const mockDbAdapter = {
  connect: mock.fn(() => Promise.resolve()),
  disconnect: mock.fn(() => Promise.resolve()),
  query: mock.fn(() => Promise.resolve([])),
  execute: mock.fn(() => Promise.resolve({ rowsAffected: 1 })),
  executeMany: mock.fn(() => Promise.resolve({ rowsAffected: 1 })),
  searchVector: mock.fn(() => Promise.resolve([])),
  checkColumnExists: mock.fn(() => Promise.resolve(true)),
};

safeMockModule(path.join(srcDir, 'database/factory.js'), {
  createDatabaseAdapter: () => mockDbAdapter,
});

safeMockModule(path.join(srcDir, 'utils/context.js'), {
  authStorage: {
    getStore: () => ({ uid: 'test-user-id', email: 'test@example.com' }),
  },
});

  const mockLogger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  };

safeMockModule(path.join(srcDir, 'utils/logger.js'), {
    logger: mockLogger,
});

safeMockModule(path.join(srcDir, 'services/embeddingService.js'), {
  generateEmbeddingsBatch: mock.fn(() => Promise.resolve([[0.1, 0.2, 0.3]])),
});

safeMockModule(path.join(srcDir, 'services/dreamingService.js'), {
  DreamingService: {
    _hasLifecycleColumns: true,
  },
});

const { consolidationEngine } = await import(path.join(srcDir, 'services/consolidationEngine.js'));

describe('ConsolidationEngine (SQLite dialect expressions)', () => {
  const origDbType = process.env.CODEATLAS_DB_TYPE;

  beforeEach(() => {
    process.env.CODEATLAS_DB_TYPE = 'sqlite';
    mockDbAdapter.query.mock.resetCalls();
    mockDbAdapter.execute.mock.resetCalls();
    mockDbAdapter.executeMany.mock.resetCalls();
  });

  afterEach(() => {
    if (origDbType === undefined) {
      delete process.env.CODEATLAS_DB_TYPE;
    } else {
      process.env.CODEATLAS_DB_TYPE = origDbType;
    }
  });

  test('scoreConcepts uses datetime("now") for updated_at in SQLite mode', async () => {
    mockDbAdapter.query.mock.mockImplementation(async () => [
      { id: '550e8400-e29b-41d4-a716-446655440000', confidence: 0.5, evidence_count: 5, status: 'active' }
    ]);

    await (consolidationEngine as any).scoreConcepts('test-proj');

    assert.ok(mockDbAdapter.executeMany.mock.calls.length > 0);
    const sql = mockDbAdapter.executeMany.mock.calls[0].arguments[0] as string;
    assert.ok(sql.includes("datetime('now')"), 'SQL should use datetime("now") for SQLite');
  });

  test('scoreDreams uses julianday for time decay in SQLite mode', async () => {
    const report = {
      startTime: new Date().toISOString(),
      endTime: '',
      durationMs: 0,
      clustersProcessed: 0,
      conceptsCreated: 0,
      conceptsScored: 0,
      dreamsArchived: 0,
      dreamsSuperseded: 0,
      invalidEmbeddingsSkipped: 0,
    };

    await (consolidationEngine as any).scoreDreams('test-proj', undefined, report);

    assert.ok(mockDbAdapter.execute.mock.calls.length > 0);
    const decaySql = mockDbAdapter.execute.mock.calls[0].arguments[0] as string;
    assert.ok(decaySql.includes("julianday('now')"), 'Decay SQL should use julianday for SQLite');
  });

  test('computeConfidence applies bayesian bounds correctly', () => {
    const computeConfidence = (consolidationEngine as any).computeConfidence.bind(consolidationEngine);

    // Initial confidence with 0 evidence
    assert.equal(computeConfidence(0.5, 0), 0.5);

    // Confidence increases with positive evidence
    assert.ok(computeConfidence(0.5, 5) > 0.5);

    // Confidence is hard-capped at 0.99
    assert.equal(computeConfidence(0.99, 100), 0.99);
    assert.ok(computeConfidence(0.98, 100) <= 0.99);
  });

  test('attemptBatchUpdate performs retries and handles errors correctly', async () => {
    const attemptBatchUpdate = (consolidationEngine as any).attemptBatchUpdate.bind(consolidationEngine);
    const mockDb = {
      executeMany: mock.fn(async () => { throw new Error('DB Error'); }),
      execute: mock.fn(async () => { throw new Error('DB Error'); })
    };

    // Test that it fails after all retries
    const start = Date.now();
    const result = await attemptBatchUpdate({ db: mockDb, updateSql: 'SQL', chunk: [{ id: '550e8400-e29b-41d4-a716-446655440000' }], batchId: 'test-batch', fallbackState: { logCount: 0 }, maxRetries: 2 }); // 2 retries
    const duration = Date.now() - start;

    assert.equal(result, false);
    assert.equal(mockDb.executeMany.mock.calls.length, 2);
    // Backoff is 500ms by default, so 2 attempts with a 500ms delay between them means at least 500ms duration
    assert.ok(duration >= 500);
  });

  test('getEnvVarNumber applies valid sizes and fallbacks correctly', () => {
    (consolidationEngine as any)._configCache.clear();
    (consolidationEngine as any)._engineConfig = null;
    const getEnvVarNumber = (consolidationEngine as any).getEnvVarNumber.bind(consolidationEngine);

    // Default configuration fallback
    delete process.env.CODEATLAS_TEST_VAR_1;
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_VAR_1', 500, 'int', 2000), 500);

    // Valid configuration
    process.env.CODEATLAS_TEST_VAR_2 = '1000';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_VAR_2', 500, 'int', 2000), 1000);

    // Valid configuration with whitespace
    process.env.CODEATLAS_TEST_VAR_3 = '  1500  ';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_VAR_3', 500, 'int', 2000), 1500);

    // Enforced maximum limit
    process.env.CODEATLAS_TEST_VAR_4 = '5000';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_VAR_4', 500, 'int', 2000), 2000);

    // Float parsing
    process.env.CODEATLAS_TEST_FLOAT = '0.75';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_FLOAT', 0.5, 'float', 1.0), 0.75);

    // Invalid string fallback
    process.env.CODEATLAS_TEST_INVALID = 'abc';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_INVALID', 300), 300);

    // Negative number fallback
    process.env.CODEATLAS_TEST_NEGATIVE = '-50';
    assert.equal(getEnvVarNumber('CODEATLAS_TEST_NEGATIVE', 300), 300);
  });

  test('getNormalizedVector correctly normalizes and handles zero-norm vectors', () => {
    // Access private method for testing
    const normalize = (consolidationEngine as any).getNormalizedVector.bind(consolidationEngine);
    const cosineSim = (consolidationEngine as any).cosineSimilarity.bind(consolidationEngine);

    // Normal vector
    const vec1 = new Float32Array([3, 4]); // Norm = 5
    const norm1 = normalize(vec1, 'id-1');
    assert.ok(Math.abs(norm1[0] - 0.6) < 0.00001);
    assert.ok(Math.abs(norm1[1] - 0.8) < 0.00001);
    // Ensure original vector wasn't mutated directly
    assert.equal(vec1[0], 3);

    // Zero-norm vector
    const vec2 = new Float32Array([0, 0, 0]);
    const norm2 = normalize(vec2, 'id-zero');
    assert.equal(norm2[0], 0);
    assert.equal(norm2[1], 0);
    assert.equal(norm2[2], 0);
    assert.equal(vec2[0], 0);

    // Negative vector
    const vec3 = new Float32Array([-3, -4]); // Norm = 5
    const norm3 = normalize(vec3, 'id-neg');
    assert.ok(Math.abs(norm3[0] + 0.6) < 0.00001);
    assert.ok(Math.abs(norm3[1] + 0.8) < 0.00001);

    // Test cosine similarity on normalized vectors
    // Dot product of (0.6, 0.8) and (-0.6, -0.8) should be -1
    const sim = cosineSim(norm1, norm3);
    assert.ok(Math.abs(sim - (-1.0)) < 0.00001);

    // Dot product with zero vector is 0
    assert.equal(cosineSim(norm1, norm2), 0);
  });

  test('cosineSimilarity heuristic triggers warning on unnormalized vectors in test mode', () => {
    mockLogger.warn.mock.resetCalls();

    const cosineSim = (consolidationEngine as any).cosineSimilarity.bind(consolidationEngine);
    const unnormalizedVec = new Float32Array([10, 20]); // Squares sum to 500
    const normalVec = new Float32Array([0.6, 0.8]);

    cosineSim(unnormalizedVec, normalVec);

    assert.equal(mockLogger.warn.mock.calls.length, 1);
    const warnMsg = mockLogger.warn.mock.calls[0].arguments[0] as string;
    assert.ok(warnMsg.includes('Un-normalized vector detected'));
  });
});
