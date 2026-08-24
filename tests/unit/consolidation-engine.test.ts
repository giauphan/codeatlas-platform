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

safeMockModule(path.join(srcDir, 'utils/logger.js'), {
  logger: {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  },
});

safeMockModule(path.join(srcDir, 'services/embeddingService.js'), {
  generateEmbeddingsBatch: mock.fn(() => Promise.resolve([[0.1, 0.2, 0.3]])),
});

safeMockModule(path.join(srcDir, 'services/dreamingService.js'), {
  OracleDreamingService: {
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
      { id: 'concept-1', confidence: 0.5, evidence_count: 5, status: 'active' }
    ]);

    await (consolidationEngine as any).scoreConcepts('test-proj');

    assert.ok(mockDbAdapter.execute.mock.calls.length > 0);
    const sql = mockDbAdapter.execute.mock.calls[0].arguments[0] as string;
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

  test('getNormalizedVector correctly normalizes and handles zero-norm vectors', () => {
    // Access private method for testing
    const normalize = (consolidationEngine as any).getNormalizedVector.bind(consolidationEngine);

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
  });
});
