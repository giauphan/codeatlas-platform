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

  test('empty consolidation reports zero source work without claiming transcript ingestion', async () => {
    mockDbAdapter.query.mock.mockImplementation(async () => []);
    const report = await consolidationEngine.runJob({
      project: 'empty-project', provider: 'generic',
      operations: ['dedup', 'extract_concepts', 'score', 'score_dreams'],
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.dreamsProcessed, 0);
    assert.equal(report.dreamsMerged, 0);
    assert.equal(report.conceptsCreated, 0);
    assert.deepEqual(report.errors, []);
    assert.equal('transcriptsProcessed' in report, false);
  });

  test('scoreConcepts uses datetime("now") for updated_at in SQLite mode', async () => {
    mockDbAdapter.query.mock.mockImplementation(async () => [
      { id: 'concept-1', confidence: 0.5, evidence_count: 5, status: 'active' }
    ]);

    await (consolidationEngine as any).scoreConcepts('test-proj');

    assert.ok(mockDbAdapter.executeMany.mock.calls.length > 0);
    const sql = mockDbAdapter.executeMany.mock.calls[0].arguments[0] as string;
    assert.ok(sql.includes("datetime('now')"), 'SQL should use datetime("now") for SQLite');
  });

  test('scoreDreams recomputes confidence from stable source values for retry safety', async () => {
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

    mockDbAdapter.query.mock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, memory_type, importance')) return [{
        id: 'dream-1', memory_type: 'KNOWLEDGE', importance: 7, confidence: 0.7,
        created_at: '2026-10-01T00:00:00.000Z', last_accessed_at: null, evidence_count: 2, access_count: 0,
      }];
      return [];
    });
    await (consolidationEngine as any).scoreDreams('test-proj', undefined, undefined, report, '2026-10-19T09:00:00.000Z');

    assert.equal(mockDbAdapter.executeMany.mock.calls.length, 1);
    const sql = mockDbAdapter.executeMany.mock.calls[0].arguments[0] as string;
    const values = mockDbAdapter.executeMany.mock.calls[0].arguments[1] as Array<{ confidence: number }>;
    assert.ok(sql.includes("WHERE id = :id AND tenant_id = :tenantId AND status = 'active' AND project = :project"));
    assert.ok(values[0].confidence > 0.05 && values[0].confidence < 0.99);
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
