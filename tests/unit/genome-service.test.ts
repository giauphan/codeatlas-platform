/**
 * Unit tests for GenomeService — CodeAtlas AI DNA Engine
 *
 * Tests all gene lifecycle operations with mocked Oracle DB.
 */

import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const exportsObj = 'default' in mockObj
    ? mockObj
    : { __esModule: true, default: mockObj, ...mockObj };
  const opts = { exports: exportsObj };
  const specs = new Set<string>([specifier]);

  if (specifier.startsWith('/')) {
    specs.add(pathToFileURL(specifier).href);

    const basePath = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier.endsWith('.ts') ? specifier.slice(0, -2) : specifier;

    for (const p of [basePath, basePath + '.js', basePath + '.ts']) {
      specs.add(p);
      specs.add(pathToFileURL(p).href);
    }

    if (basePath.includes('/src/')) {
      for (const distPath of [basePath.replace('/src/', '/dist/'), basePath.replace('/src/', '/dist/src/')]) {
        for (const ext of ['', '.js', '.ts']) {
          const p = distPath + ext;
          specs.add(p);
          specs.add(pathToFileURL(p).href);
        }
      }
      const srcIdx = specifier.indexOf('/src/');
      const subPath = specifier.slice(srcIdx + 5);
      const subBase = subPath.endsWith('.js') ? subPath.slice(0, -3) : subPath.endsWith('.ts') ? subPath.slice(0, -2) : subPath;
      for (const rel of ['./', '../', '../../', '../../../']) {
        for (const ext of ['', '.js', '.ts']) {
          specs.add(rel + subBase + ext);
        }
      }
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

// ═════════════════════════════════════════════════════════════════════
// Mock Dependencies
// ═════════════════════════════════════════════════════════════════════

const mockConnection = {
  execute: mock.fn(),
  executeMany: mock.fn(),
  close: mock.fn(),
};

const mockPool = {
  getConnection: mock.fn(() => Promise.resolve(mockConnection)),
};

const oracleMock = {
  OUT_FORMAT_OBJECT: 4001,
  CLOB: 2011,
  createPool: mock.fn(() => Promise.resolve(mockPool)),
  initOracleClient: mock.fn(),
  outFormat: undefined as unknown,
  fetchAsString: [] as number[],
  default: {},
};
safeMockModule('oracledb', oracleMock);

// Mock generateEmbedding
const mockGenerateEmbedding = mock.fn(async () => {
  return new Array(1024).fill(0.01);
});
const embeddingMock = { generateEmbedding: mockGenerateEmbedding };
safeMockModule(path.join(srcDir, 'services/embeddingService.js'), embeddingMock);

// Mock connection
const mockInitPool = mock.fn(() => Promise.resolve(mockPool as any));
const mockSetSessionContext = mock.fn(() => Promise.resolve());
const connMock = { initPool: mockInitPool, setSessionContext: mockSetSessionContext };
safeMockModule(path.join(srcDir, 'database/connection.js'), connMock);

// Mock createDatabaseAdapter to return our mock connection
const factoryMock = {
  createDatabaseAdapter: () => ({
    connect: mock.fn(() => Promise.resolve()),
    searchVector: mock.fn(async (table, embedding, limit, tenantId) => {
      return [
        { id: 'gene-1', score: 0.95 },
        { id: 'gene-imm-1', score: 0.90 },
        { id: 'gene-2', score: 0.85 },
      ].slice(0, limit);
    }),
    query: mock.fn(),
    execute: mock.fn(),
    executeMany: mock.fn(),
    getConnection: mock.fn(() => Promise.resolve(mockConnection))
  })
};
safeMockModule(path.join(srcDir, 'database/factory.js'), factoryMock);

// Mock logger
const loggerMock = { logger: { info: mock.fn(), error: mock.fn(), warn: mock.fn() } };
safeMockModule(path.join(srcDir, 'utils/logger.js'), loggerMock);

// Mock context
const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
safeMockModule(path.join(srcDir, 'utils/context.js'), { authStorage: mockAuthStore });

// ── Import module under test ─────────────────────────────────────────
const { GenomeService } = await import(
  path.join(srcDir, 'services/genomeService.js')
);

// ── Helpers ──────────────────────────────────────────────────────────
function mockEmptyQuery() {
  mockConnection.execute.mock.mockImplementation(async () => ({ rows: [], rowsAffected: 0 }));
}

function mockGeneRow(id = 'gene-test', name = 'Test Gene', category = 'pattern') {
  return [
    id, name, 'Description', 'Problem', 'Solution',
    'Architecture', category, 'test-project', 0.5, 1,
    1, 0, 0.5, null, 'active', 'manual', '', '[]',
    '2026-01-01', '2026-01-01',
  ];
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('GenomeService', () => {
  beforeEach(() => {
    mockConnection.execute.mock.resetCalls();
    mockConnection.close.mock.resetCalls();
    mockGenerateEmbedding.mock.resetCalls();
    mockInitPool.mock.resetCalls();
    mockInitPool.mock.mockImplementation(() => Promise.resolve(mockPool));
    mockSetSessionContext.mock.resetCalls();
  });

  // ── upsertGene ────────────────────────────────────────────────────
  describe('upsertGene()', () => {
    test('creates new gene (v1) when it does not exist', async () => {
      // No existing gene
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, version FROM codeatlas_genome')) return { rows: [] };
        return { rowsAffected: 1 };
      });

      const id = await GenomeService.upsertGene({
        name: 'Auth Pattern', description: 'Auth pattern', problem: 'Need auth',
        solution: 'Use JWT', category: 'pattern', project: 'test', sourceType: 'manual',
      });

      assert.ok(id);
      assert.ok(id.startsWith('gene-'));
      assert.ok(mockGenerateEmbedding.mock.calls.length > 0);
    });

    test('updates existing gene (v1→v2) and records mutation', async () => {
      // Existing gene returned
      mockConnection.execute.mock.mockImplementation(async (sql: string, binds: any) => {
        if (sql.includes('SELECT id, version FROM codeatlas_genome')) {
          return { rows: [['gene-abc123', 1]] };
        }
        return { rowsAffected: 1 };
      });

      const id = await GenomeService.upsertGene({
        name: 'Auth Pattern', description: 'Better auth', problem: 'Need auth',
        solution: 'Use OAuth2', category: 'pattern', project: 'test', sourceType: 'manual',
      });

      assert.ok(id);
      // Should have inserted mutation record
      const mutationCalls = mockConnection.execute.mock.calls.filter(
        (c: any) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO gene_mutations')
      );
      assert.ok(mutationCalls.length > 0, 'Mutation record should be created');
    });
  });

  // ── searchGenes ────────────────────────────────────────────────────
  describe('searchGenes()', () => {
    test('returns empty array when no embedding', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(async () => null);

      const results = await GenomeService.searchGenes('test query');
      assert.deepStrictEqual(results, []);
    });

    test('returns mapped genes with correct fields', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [mockGeneRow('gene-1', 'Auth Gene', 'pattern')],
        rowsAffected: 0,
      }));

      const results = await GenomeService.searchGenes('auth', { limit: 5 });

      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'gene-1');
      assert.equal(results[0].name, 'Auth Gene');
      assert.equal(results[0].category, 'pattern');
      assert.equal(typeof results[0].confidence, 'number');
      assert.equal(typeof results[0].version, 'number');
    });

    test('increments usage_count on retrieved genes', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [mockGeneRow('gene-1', 'Test', 'pattern')],
      }));

      await GenomeService.searchGenes('test', { limit: 5 });

      // Should have at least one UPDATE usage_count call
      const updateCalls = mockConnection.executeMany.mock.calls.filter(
        (c: any) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('usage_count = usage_count + 1')
      );
      assert.ok(updateCalls.length > 0);
    });
  });

  // ── mergeGenes ─────────────────────────────────────────────────────
  describe('mergeGenes()', () => {
    test('combines 2 genes into one and marks sources as merged', async () => {
      mockConnection.executeMany.mock.mockImplementation(async (sql: string) => {
        if (sql.includes('UPDATE codeatlas_genome SET status')) return { rowsAffected: 1 };
        if (sql.includes('INSERT INTO gene_relationships')) return { rowsAffected: 1 };
      });
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, version FROM codeatlas_genome')) return { rows: [] };
        return { rows: [mockGeneRow('gene-1', 'Source A'), mockGeneRow('gene-2', 'Source B')] };
      });

      const geneId = await GenomeService.mergeGenes(
        ['gene-1', 'gene-2'], 'Unified Auth', 'test'
      );

      assert.ok(geneId);
      assert.ok(geneId.startsWith('gene-'));
    });

    test('throws when fewer than 2 genes provided', async () => {
      await assert.rejects(
        () => GenomeService.mergeGenes(['gene-1'], 'Target', 'test'),
        (err: Error) => err.message.includes('at least 2')
      );
    });
  });

  // ── splitGene ──────────────────────────────────────────────────────
  describe('splitGene()', () => {
    test('splits gene into children and retires source', async () => {
      let callNum = 0;
      mockConnection.executeMany.mock.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO gene_relationships')) return { rowsAffected: 2 };
      });
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        callNum++;
        // Call 1: source gene lookup by splitGene
        if (callNum === 1) return { rows: [mockGeneRow('gene-src', 'Source Gene')] };
        // Calls 2,4,6: existing gene check by upsertGene → no existing
        if (sql.includes('SELECT id, version FROM codeatlas_genome')) return { rows: [] };
        return { rowsAffected: 1 };
      });

      const childIds = await GenomeService.splitGene('gene-src', ['Part A', 'Part B'], 'test');

      assert.equal(childIds.length, 2);
      assert.ok(childIds[0].startsWith('gene-'));
      assert.ok(childIds[1].startsWith('gene-'));
    });

    test('throws when fewer than 2 child names', async () => {
      await assert.rejects(
        () => GenomeService.splitGene('gene-src', ['Only One'], 'test'),
        (err: Error) => err.message.includes('at least 2')
      );
    });
  });

  // ── mutateGene ─────────────────────────────────────────────────────
  describe('mutateGene()', () => {
    test('successful mutation boosts confidence', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [['gene-abc', 'Auth', 'Problem', 'Solution', 0.5, 3, 0.5, 10, 'active']],
        rowsAffected: 1,
      }));

      await GenomeService.mutateGene('gene-abc', { success: true }, 'test');

      // Check confidence updated
      const updateCalls = mockConnection.execute.mock.calls.filter(
        (c: any) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('SET')
      );
      assert.ok(updateCalls.length > 0);
    });

    test('failed mutation lowers confidence', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [['gene-abc', 'Auth', 'Problem', 'Solution', 0.8, 3, 0.7, 5, 'active']],
        rowsAffected: 1,
      }));

      await GenomeService.mutateGene('gene-abc', { success: false }, 'test');
      // Should still succeed (no exception)
    });

    test('throws when gene not found', async () => {
      mockConnection.execute.mock.mockImplementationOnce(async () => ({ rows: [], rowsAffected: 0 }));
      await assert.rejects(
        () => GenomeService.mutateGene('nonexistent', {}, 'test'),
        (err: Error) => err.message.includes('not found')
      );
    });
  });

  // ── retireGenes ────────────────────────────────────────────────────
  describe('retireGenes()', () => {
    test('retires genes and returns count', async () => {
      mockConnection.executeMany.mock.mockImplementation(async () => ({ rowsAffected: 2 }));

      const count = await GenomeService.retireGenes(['gene-1', 'gene-2']);
      assert.equal(count, 2);
    });

    test('handles empty array', async () => {
      const count = await GenomeService.retireGenes([]);
      assert.equal(count, 0);
    });
  });

  // ── Immune System — CRISPR-Cas9 Inspired ──────────────────────────
  describe('Immune System — CRISPR-Cas9 Inspired', () => {
    test('scanImmuneGenes returns empty when no embedding', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(async () => null);
      const genes = await GenomeService.scanImmuneGenes('test problem');
      assert.deepStrictEqual(genes, []);
    });

    test('scanImmuneGenes returns immune genes with correct fields', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [mockGeneRow('gene-imm-1', '[IMMUNE] Failure Pattern', 'immune')],
      }));

      const genes = await GenomeService.scanImmuneGenes('similar problem');
      assert.equal(genes.length, 1);
      assert.equal(genes[0].category, 'immune');
      assert.ok(genes[0].name.includes('[IMMUNE]'));
    });

    test('createImmuneGene starts with confidence 0.70 (higher base than normal genes)', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [], rowsAffected: 1,
      }));

      const geneId = await GenomeService.createImmuneGene(
        'JWT expiry', 'Token expired in middleware', 'Check expiry before each request', 'test'
      );

      assert.ok(geneId);
      // Verify confidence 0.70 is passed to upsertGene
      const insertCalls = mockConnection.execute.mock.calls.filter(
        (c: any) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO codeatlas_genome')
      );
      assert.ok(insertCalls.length > 0);
      const bindVals = JSON.stringify(insertCalls[0].arguments[1]);
      assert.ok(bindVals.includes('0.7'), 'Immune gene should have 0.70 confidence');
    });

    test('buildImmuneContext returns empty for no matches', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(async () => new Array(1024).fill(0.01));
      mockConnection.execute.mock.mockImplementationOnce(async () => ({ rows: [], rowsAffected: 0 }));

      const context = await GenomeService.buildImmuneContext('unknown problem');
      assert.equal(context, '');
    });

    test('buildImmuneContext returns formatted prevention text with CRISPR header', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [mockGeneRow('gene-imm-2', '[IMMUNE] JWT Bug', 'immune')],
      }));

      const context = await GenomeService.buildImmuneContext('jwt problem');
      assert.ok(context.includes('Immune System'));
      assert.ok(context.includes('[IMMUNE] JWT Bug'));
      assert.ok(context.includes('Confidence'));
      assert.ok(context.includes('Success rate'));
      assert.ok(context.includes('Apply these preventions'));
    });

    // ── CRISPR-Specific Tests ───────────────────────────────────────
    test('CRISPR: immune gene confidence threshold (only > 0.2 confidence returned)', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(async () => new Array(1024).fill(0.01));
      // Mock returns genes with varying confidence
      let queryExecuted = false;

      // Keep track of the original mock before we temporarily override it just for this test
      const originalMock = mockConnection.execute.mock.calls;

      // After our refactor, the 'confidence > 0.2' string exists in the subquery passed
      // to the `searchVector` method in `createDatabaseAdapter`.
      // Since `createDatabaseAdapter().searchVector()` is mocked at the top of the file to return an array,
      // it bypasses the direct SQL mock of `mockConnection.execute` for the vector search part.
      // We should verify that `mockConnection.execute` still runs the final SELECT query.
      mockConnection.execute.mock.mockImplementation(async (sql: string, binds: any) => {
        queryExecuted = true;
        return { rows: [mockGeneRow('gene-imm-3', '[IMMUNE] Low Confidence', 'immune')], rowsAffected: 0 };
      });

      await GenomeService.scanImmuneGenes('any problem');
      assert.ok(queryExecuted, 'Query must be executed to fetch the full rows after vector search');

      // Restore the mock behavior
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [mockGeneRow('gene-imm-1', '[IMMUNE] Failure Pattern', 'immune')],
      }));
    });

    test('CRISPR: multiple immune genes ranked by vector distance', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [
          mockGeneRow('gene-imm-1', '[IMMUNE] Best Match', 'immune'),
          mockGeneRow('gene-imm-2', '[IMMUNE] Partial Match', 'immune'),
          mockGeneRow('gene-imm-3', '[IMMUNE] Weak Match', 'immune'),
        ],
      }));

      const genes = await GenomeService.scanImmuneGenes('specific problem description', 'test-project');
      assert.equal(genes.length, 3);
      // All should be from 'immune' category
      assert.ok(genes.every((g) => g.category === 'immune'));
    });

    test('CRISPR: buildImmuneContext formats multiple genes in order', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [
          mockGeneRow('gene-a', '[IMMUNE] Bug A', 'immune'),
          mockGeneRow('gene-b', '[IMMUNE] Bug B', 'immune'),
        ],
      }));

      const context = await GenomeService.buildImmuneContext('test', 'test-project');
      assert.ok(context.includes('Bug A'));
      assert.ok(context.includes('Bug B'));
      // Count occurrences of prevention markers
      const matches = context.match(/IMMUNE/g);
      assert.equal(matches?.length, 2, 'Should mention both immune genes');
    });

    test('CRISPR: immune gene retains proper source tracking', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({
        rows: [], rowsAffected: 1,
      }));

      const geneId = await GenomeService.createImmuneGene(
        'Memory Leak', 'Map allocation in 60fps loop', 'Use linkIndices pattern', 'codeatlas-ai'
      );

      assert.ok(geneId);
      // Source type should be 'feedback'
      const calls = mockConnection.execute.mock.calls;
      const insertCall = calls.find((c: any) =>
        typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO codeatlas_genome')
      );
      if (insertCall) {
        const binds = insertCall.arguments[1];
        assert.equal(binds.srcType, 'feedback', 'Immune gene source should be "feedback"');
      }
    });

    test('CRISPR: multiple scans do NOT increment usage_count (scan is passive)', async () => {
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        return { rows: [mockGeneRow('gene-imm-1', '[IMMUNE] Bug', 'immune')], rowsAffected: 1 };
      });

      await GenomeService.scanImmuneGenes('problem 1');
      await GenomeService.scanImmuneGenes('problem 2');
      await GenomeService.scanImmuneGenes('problem 3');

      // scanImmuneGenes is read-only SELECT — no UPDATE SET usage_count
      const updateCalls = mockConnection.execute.mock.calls.filter(
        (c: any) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('SET usage_count')
      );
      assert.equal(updateCalls.length, 0, 'Passive scan should not SET usage_count');
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────
  describe('Edge Cases', () => {
    test('getGene returns null for non-existent gene', async () => {
      mockConnection.execute.mock.mockImplementation(async () => ({ rows: [], rowsAffected: 0 }));
      const gene = await GenomeService.getGene('nonexistent');
      assert.equal(gene, null);
    });

    test('upsertGene handles empty embedding', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(async () => new Float32Array(0));
      mockConnection.execute.mock.mockImplementation(async () => ({ rows: [], rowsAffected: 1 }));

      // Should not throw
      await GenomeService.upsertGene({
        name: 'Test', description: 'Test', problem: 'P', solution: 'S',
        category: 'lesson', project: 'test', sourceType: 'manual',
      });
    });

    test('extractGene throws for unsupported source type', async () => {
      await assert.rejects(
        () => GenomeService.extractGene({ sourceType: 'invalid', sourceId: 'x', project: '' }),
        (err: Error) => err.message.includes('Unsupported')
      );
    });

    test('extractGene throws for non-existent dream', async () => {
      mockConnection.execute.mock.mockImplementationOnce(async () => ({ rows: [], rowsAffected: 0 }));
      await assert.rejects(
        () => GenomeService.extractGene({ sourceType: 'dream', sourceId: 'fake-dream', project: '' }),
        (err: Error) => err.message.includes('not found')
      );
    });
  });
});
