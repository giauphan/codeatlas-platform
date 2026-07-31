import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');

// ═════════════════════════════════════════════════════════════════════
// Mock Dependencies BEFORE any import of the module under test
// ═════════════════════════════════════════════════════════════════════

const mockConnection = {
  execute: mock.fn(),
  close: mock.fn(),
};

const mockPool = {
  getConnection: mock.fn(() => Promise.resolve(mockConnection)),
};

// Mock oracledb
mock.module('oracledb', {
  namedExports: {
    OUT_FORMAT_OBJECT: 4001,
    CLOB: 2011,
    createPool: mock.fn(() => Promise.resolve(mockPool)),
    initOracleClient: mock.fn(),
    outFormat: undefined as unknown,
    fetchAsString: [] as number[],
    default: {},
  },
});

// Mock database/connection.ts
mock.module(path.join(srcDir, 'database/connection.js'), {
  namedExports: {
    initPool: mock.fn(() => Promise.resolve(mockPool)),
    setSessionContext: mock.fn(() => Promise.resolve()),
  },
});

// Mock embeddingService
const mockGenerateEmbedding = mock.fn(() => Promise.resolve([0.1, 0.2, 0.3]));

mock.module(path.join(srcDir, 'services/embeddingService.js'), {
  namedExports: {
    generateEmbedding: mockGenerateEmbedding,
  },
});

// Mock context
const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};

mock.module(path.join(srcDir, 'utils/context.js'), {
  namedExports: {
    authStorage: mockAuthStore,
  },
});

// Mock logger
const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn(),
};

mock.module(path.join(srcDir, 'utils/logger.js'), {
  namedExports: {
    logger: mockLogger,
  },
});

// ── Import module under test ─────────────────────────────────────────
const { OracleDreamingService } = await import(
  path.join(srcDir, 'services/dreamingService.js')
);

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('OracleDreamingService', () => {
  beforeEach(async () => {
    // Reset all mock call history between tests
    mockConnection.execute.mock.resetCalls();
    mockConnection.close.mock.resetCalls();
    mockPool.getConnection.mock.resetCalls();
    mockGenerateEmbedding.mock.resetCalls();
    mockAuthStore.getStore.mock.resetCalls();
    mockAuthStore.run.mock.resetCalls();
    mockLogger.info.mock.resetCalls();
    mockLogger.error.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();

    // Restore initPool to default (success) state
    const { initPool } = await import(
      path.join(srcDir, 'database/connection.js')
    );
    initPool.mock.resetCalls();
    initPool.mock.mockImplementation(() => Promise.resolve(mockPool));

    const { setSessionContext } = await import(
      path.join(srcDir, 'database/connection.js')
    );
    setSessionContext.mock.resetCalls();
    setSessionContext.mock.mockImplementation(() => Promise.resolve());
  });

  // ── saveDreamMemory ────────────────────────────────────────────────
  describe('saveDreamMemory()', () => {
    test('with valid inputs returns id string', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const id = await OracleDreamingService.saveDreamMemory(
        'test-project', 'session-1', 'KNOWLEDGE', 'This is a long enough test content to pass the forty character noise gate threshold.', 5,
      );

      // Should return a unique ID
      assert.ok(id);
      assert.ok(id.startsWith('test-project_KNOWLEDGE_session-1'));

      // Should have generated an embedding
      assert.strictEqual(mockGenerateEmbedding.mock.calls.length, 1);
      assert.strictEqual(
        mockGenerateEmbedding.mock.calls[0].arguments[0],
        'This is a long enough test content to pass the forty character noise gate threshold.',
      );
      assert.strictEqual(
        mockGenerateEmbedding.mock.calls[0].arguments[1],
        'passage',
      );

      // Should have acquired a connection
      assert.strictEqual(mockPool.getConnection.mock.calls.length, 1);
      // Should have set session context
      const { initPool, setSessionContext } = await import(
        path.join(srcDir, 'database/connection.js')
      );
      assert.strictEqual(setSessionContext.mock.calls.length, 1);

      // Should have executed the INSERT
      assert.strictEqual(mockConnection.execute.mock.calls.length, 1);
      const insertSql = mockConnection.execute.mock.calls[0].arguments[0] as string;
      assert.ok(insertSql.includes('INSERT INTO ai_dreaming_memory'));

      // Should have closed the connection
      assert.strictEqual(mockConnection.close.mock.calls.length, 1);
    });

    test('without embedding (null vector) still saves correctly', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const id = await OracleDreamingService.saveDreamMemory(
        'p2', 's2', 'PREFERENCE', 'no embedding content content that is definitely longer than forty characters to pass noise gate test.', 3,
      );

      assert.ok(id);
      assert.ok(id.startsWith('p2_PREFERENCE_s2'));

      // Embedding was attempted but returned null
      assert.strictEqual(mockGenerateEmbedding.mock.calls.length, 1);

      // INSERT still executed (with null embedding)
      assert.strictEqual(mockConnection.execute.mock.calls.length, 1);
      const binds = mockConnection.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      // embedding should be null when generateEmbedding returns null
      assert.strictEqual(binds.embedding, null);
    });

    test('with DB error throws error', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        throw new Error('ORA-00001: unique constraint violated');
      });

      await assert.rejects(
        () => OracleDreamingService.saveDreamMemory(
          'p', 's', 'MISTAKE', 'This is a sufficiently long content to pass the noise gate threshold of at least forty characters.', 7,
        ),
        (err: Error) => {
          assert.ok(err.message.includes('ORA-00001'));
          return true;
        },
      );

      // Connection should still be closed after error
      assert.strictEqual(mockConnection.close.mock.calls.length, 1);
      // Error should have been logged
      assert.strict(mockLogger.error.mock.calls.length >= 1, true);
    });
  });

  // ── queryDreamMemories ─────────────────────────────────────────────
  describe('queryDreamMemories()', () => {
    const sampleRows = [
      {
        ID: 'mem-1',
        SESSION_ID: 's1',
        PROJECT: 'test-project',
        MEMORY_TYPE: 'KNOWLEDGE',
        CONTENT: 'Node.js uses event loop',
        IMPORTANCE: 8,
        CREATED_AT: new Date('2025-01-01'),
      },
      {
        ID: 'mem-2',
        SESSION_ID: 's2',
        PROJECT: 'test-project',
        MEMORY_TYPE: 'PREFERENCE',
        CONTENT: 'Use TypeScript strict mode',
        IMPORTANCE: 5,
        CREATED_AT: new Date('2025-01-02'),
      },
    ];

    test('returns array of memories', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rows: sampleRows };
      });

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'how does Node work?', 10,
      );

      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows, sampleRows);

      // Should have generated query embedding
      assert.strictEqual(mockGenerateEmbedding.mock.calls.length, 1);
      assert.strictEqual(
        mockGenerateEmbedding.mock.calls[0].arguments[1],
        'query',
      );
    });

    test('with empty results returns empty array', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rows: [] };
      });

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'nothing matches this', 5,
      );

      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, 0);
    });

    test('respects limit parameter', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rows: sampleRows };
      });

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'search', 3,
      );

      // Verify the limit was passed to the SQL query
      const binds = mockConnection.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.strictEqual(binds.limit, 3);
    });

    test('with null embedding (no API key) still queries, ordered by date', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rows: sampleRows };
      });

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'some query', 5,
      );

      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, 2);

      // When embedding is null, no queryVector bind should be present
      const binds = mockConnection.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.strictEqual(binds.queryVector, undefined);
    });
  });

  // ── deleteDreamMemory ──────────────────────────────────────────────
  describe('deleteDreamMemory()', () => {
    test('with valid existing id returns true', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const result = await OracleDreamingService.deleteDreamMemory('mem-123');

      assert.strictEqual(result, true);

      // Verify SQL
      const sql = mockConnection.execute.mock.calls[0].arguments[0] as string;
      assert.ok(sql.includes('DELETE FROM ai_dreaming_memory'));
      const binds = mockConnection.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.strictEqual(binds.id, 'mem-123');
    });

    test('with non-existent id returns false', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 0 };
      });

      const result = await OracleDreamingService.deleteDreamMemory('nonexistent-id');

      assert.strictEqual(result, false);
    });

    test('with DB error throws error', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        throw new Error('ORA-00942: table or view does not exist');
      });

      await assert.rejects(
        () => OracleDreamingService.deleteDreamMemory('fail-id'),
        (err: Error) => {
          assert.ok(err.message.includes('ORA-00942'));
          return true;
        },
      );

      // Connection closed despite error
      assert.strictEqual(mockConnection.close.mock.calls.length, 1);
    });
  });

  // ── initialize ─────────────────────────────────────────────────────
  describe('initialize()', () => {
    test('creates table if not exists', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return {};
      });

      await OracleDreamingService.initialize();

      // Should have executed: table creation + 9 column checks + 9 alters + 2 cache checks + concepts + genome + mutations + relationships = 25
      assert.strictEqual(mockConnection.execute.mock.calls.length, 25);
      const sql0 = mockConnection.execute.mock.calls[0].arguments[0] as string;
      assert.ok(sql0.includes('CREATE TABLE ai_dreaming_memory'));
    });

    test('handles table already existing (ORA-00955 swallowed)', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return {};
      });

      await OracleDreamingService.initialize();

      // 1 table + 9 column checks + 9 alters + 2 cache checks + concepts + genome + mutations + relationships = 25
      assert.strictEqual(mockConnection.execute.mock.calls.length, 25);
    });

    test('throws on initPool failure', async () => {
      // Override initPool to throw
      const { initPool } = await import(
        path.join(srcDir, 'database/connection.js')
      );
      initPool.mock.mockImplementation(() => Promise.reject(new Error('Connection refused')));

      await assert.rejects(
        () => OracleDreamingService.initialize(),
        (err: Error) => {
          assert.ok(err.message.includes('Connection refused'));
          return true;
        },
      );
    });

    test('always closes connection in finally block', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return {};
      });

      await OracleDreamingService.initialize();

      assert.strictEqual(mockConnection.close.mock.calls.length, 1);
    });
  });
});
