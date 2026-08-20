import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
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

    for (const ext of ['.js', '.ts']) {
      const p = basePath + ext;
      specs.add(p);
      specs.add(pathToFileURL(p).href);
    }

    if (basePath.includes('/src/')) {
      for (const distBase of [basePath.replace('/src/', '/dist/'), basePath.replace('/src/', '/dist/src/')]) {
        for (const ext of ['.js', '.ts']) {
          const p = distBase + ext;
          specs.add(p);
          specs.add(pathToFileURL(p).href);
        }
      }
      const srcIdx = specifier.indexOf('/src/');
      const subPath = specifier.slice(srcIdx + 5);
      const subPathBase = subPath.endsWith('.js')
        ? subPath.slice(0, -3)
        : subPath.endsWith('.ts')
          ? subPath.slice(0, -2)
          : subPath;

      for (const prefix of ['./', '../', '../../', '../../../']) {
        for (const ext of ['', '.js', '.ts']) {
          specs.add(prefix + subPathBase + ext);
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

// Mock database/connection.ts
const connMock = {
  initPool: mock.fn(() => Promise.resolve(mockPool)),
  setSessionContext: mock.fn(() => Promise.resolve()),
};
safeMockModule(path.join(srcDir, 'database/connection.js'), connMock);

// Mock database/factory.ts
const mockDbAdapter = {
  execute: mock.fn(() => Promise.resolve({ rowsAffected: 1 })),
  query: mock.fn(() => Promise.resolve([])),
  searchVector: mock.fn(() => Promise.resolve([
    { id: 'memory_1', score: 0.9 },
    { id: 'memory_2', score: 0.8 },
  ])),
};
const factoryMock = {
  createDatabaseAdapter: mock.fn(() => mockDbAdapter),
};
safeMockModule(path.join(srcDir, 'database/factory.js'), factoryMock);

// Mock embeddingService
const mockGenerateEmbedding = mock.fn(() => Promise.resolve([0.1, 0.2, 0.3]));
const embeddingMock = {
  generateEmbedding: mockGenerateEmbedding,
};
safeMockModule(path.join(srcDir, 'services/embeddingService.js'), embeddingMock);

// Mock context
const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
const contextMock = {
  authStorage: mockAuthStore,
};
safeMockModule(path.join(srcDir, 'utils/context.js'), contextMock);

// Mock logger
const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn(),
};
const loggerMock = {
  logger: mockLogger,
};
safeMockModule(path.join(srcDir, 'utils/logger.js'), loggerMock);

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
    mockDbAdapter.execute.mock.resetCalls();
    mockDbAdapter.query.mock.resetCalls();
    mockDbAdapter.searchVector.mock.resetCalls();
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
      mockDbAdapter.execute.mock.mockImplementation(async () => {
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

      // Should have executed the statement via adapter
      assert.strictEqual(mockDbAdapter.execute.mock.calls.length, 1);
      const insertSql = mockDbAdapter.execute.mock.calls[0].arguments[0] as string;
      assert.ok(insertSql.includes('ai_dreaming_memory'));
    });

    test('without embedding (null vector) still saves correctly', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const id = await OracleDreamingService.saveDreamMemory(
        'p2', 's2', 'PREFERENCE', 'no embedding content content that is definitely longer than forty characters to pass noise gate test.', 3,
      );

      assert.ok(id);
      assert.ok(id.startsWith('p2_PREFERENCE_s2'));

      // Embedding was attempted but returned null
      assert.strictEqual(mockGenerateEmbedding.mock.calls.length, 1);

      // statement still executed (with null embedding)
      assert.strictEqual(mockDbAdapter.execute.mock.calls.length, 1);
      const binds = mockDbAdapter.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      // embedding should be null when generateEmbedding returns null
      assert.strictEqual(binds.embedding, null);
    });

    test('with DB error throws error', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => {
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

      // Error should have been logged
      assert.ok(mockLogger.error.mock.calls.length >= 1);
    });

    test('with scope, tags, related_ids and SESSION_SUMMARY memory type saves correctly', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const longSummary = 'This is a detailed summary of the current working session. We implemented context retention across sessions by supporting scope, tags, and related_ids metadata fields in Oracle 26ai database and MCP server.'.repeat(2);
      const id = await OracleDreamingService.saveDreamMemory(
        'codeatlas-platform', 'session-99', 'SESSION_SUMMARY', longSummary, 8, 'claude-3-5-sonnet',
        'auth/login', ['jwt', 'security'], ['rel-1', 'rel-2']
      );

      assert.ok(id);
      assert.ok(id.includes('SESSION_SUMMARY'));

      assert.strictEqual(mockDbAdapter.execute.mock.calls.length, 1);
      const binds = mockDbAdapter.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.strictEqual(binds.scope, 'auth/login');
      assert.strictEqual(binds.tagsJson, JSON.stringify(['jwt', 'security']));
      assert.strictEqual(binds.relatedIdsJson, JSON.stringify(['rel-1', 'rel-2']));
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
      mockGenerateEmbedding.mock.mockImplementationOnce(() => Promise.resolve(null));
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

    test('supports scope, tags and memory_type filtering', async () => {
      // Setup column existence check to true for TAGS column
      const origExecute = mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        if (sql.includes('USER_TAB_COLUMNS')) {
          return { rows: [{ CNT: 1 }] };
        }
        return { rows: sampleRows };
      });

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'query filter', 10, 0, 'SESSION_SUMMARY, KNOWLEDGE', undefined, undefined, undefined, 'auth', ['jwt', 'login']
      );

      assert.strictEqual(rows.length, 2);
      // Main query + USER_TAB_COLUMNS check + connection context + bump access count
      const executeCalls = mockConnection.execute.mock.calls;
      const mainQueryCall = executeCalls.find(c => (c.arguments[0] as string).includes('FROM ai_dreaming_memory'));
      assert.ok(mainQueryCall);

      const sql = mainQueryCall.arguments[0] as string;
      const binds = mainQueryCall.arguments[1] as Record<string, unknown>;

      // Check binds
      assert.strictEqual(binds.scopeExact, 'auth');
      assert.strictEqual(binds.scopeLike, 'auth/%');
      assert.strictEqual(binds.tag_like_0, '%"jwt"%');
      assert.strictEqual(binds.tag_like_1, '%"login"%');
      assert.strictEqual(binds.type0, 'SESSION_SUMMARY');
      assert.strictEqual(binds.type1, 'KNOWLEDGE');

      // Check SQL generated filters
      assert.ok(sql.includes('scope = :scopeExact OR scope LIKE :scopeLike'));
      assert.ok(sql.includes('tags LIKE :tag_like_0 OR tags LIKE :tag_like_1'));
      assert.ok(sql.includes('memory_type IN (:type0, :type1)'));
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

      // Should have executed: table creation + 12 column checks + 12 alters + 2 cache checks + concepts + genome + mutations + relationships = 31
      assert.strictEqual(mockConnection.execute.mock.calls.length, 31);
      const sql0 = mockConnection.execute.mock.calls[0].arguments[0] as string;
      assert.ok(sql0.includes('CREATE TABLE ai_dreaming_memory'));
    });

    test('handles table already existing (ORA-00955 swallowed)', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return {};
      });

      await OracleDreamingService.initialize();

      // 1 table + 12 column checks + 12 alters + 2 cache checks + concepts + genome + mutations + relationships = 31
      assert.strictEqual(mockConnection.execute.mock.calls.length, 31);
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
