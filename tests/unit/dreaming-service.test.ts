import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
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
    specs.add(specifier + '/index.js');
    specs.add(specifier + '/lib/index.js');
    try {
      const resolvedPkg = import.meta.resolve(specifier);
      specs.add(resolvedPkg);
      specs.add(pathToFileURL(resolvedPkg).href);
    } catch {}
  } else {
    const absPath = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(import.meta.dirname, specifier);

    const rawBasePath = absPath.endsWith('.js')
      ? absPath.slice(0, -3)
      : absPath.endsWith('.ts')
        ? absPath.slice(0, -2)
        : absPath;

    const basePaths = new Set<string>([rawBasePath]);
    if (rawBasePath.includes('/src/')) {
      basePaths.add(rawBasePath.replace('/src/', '/dist/'));
      basePaths.add(rawBasePath.replace('/src/', '/dist/src/'));
    }
    if (rawBasePath.includes('/dist/src/')) {
      basePaths.add(rawBasePath.replace('/dist/src/', '/src/'));
    }
    if (rawBasePath.includes('/dist/')) {
      basePaths.add(rawBasePath.replace('/dist/', '/src/'));
    }

    for (const b of basePaths) {
      for (const ext of ['', '.js', '.ts']) {
        const p = b + ext;
        specs.add(p);
        specs.add(pathToFileURL(p).href);
        try {
          if (fs.existsSync(p)) {
            const realP = fs.realpathSync(p);
            specs.add(realP);
            specs.add(pathToFileURL(realP).href);
          }
        } catch {}
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
  const _origDbTypeForFile = process.env.CODEATLAS_DB_TYPE;

  after(() => {
    if (_origDbTypeForFile === undefined) delete process.env.CODEATLAS_DB_TYPE;
    else process.env.CODEATLAS_DB_TYPE = _origDbTypeForFile;
  });

  beforeEach(async () => {
    // Default every test to the Oracle path. CI's SQLite job sets
    // CODEATLAS_DB_TYPE=sqlite in the environment, which would otherwise
    // reroute these Oracle-targeted tests through the adapter branch and
    // break their connection-level assertions. The non-Oracle suite below
    // overrides this per-test.
    process.env.CODEATLAS_DB_TYPE = 'oracle';

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

  // ── SQLite / Postgres backend (CODEATLAS_DB_TYPE) ───────────────────
  // Guards the migration to SQLite-as-default: these paths must never touch
  // the Oracle pool, otherwise the UI fails with
  // "ORACLE_PASSWORD environment variable is required".
  describe('non-Oracle backends via CODEATLAS_DB_TYPE', () => {
    const origDbType = process.env.CODEATLAS_DB_TYPE;

    // Lowercase keys — what SQLite/Postgres drivers actually return
    const sqliteRows = [
      {
        id: 'memory_1',
        session_id: 's1',
        project: 'test-project',
        provider: 'claude',
        memory_type: 'KNOWLEDGE',
        content: 'Node.js uses an event loop',
        importance: 8,
        created_at: '2026-08-01T00:00:00.000Z',
        confidence: 0.7,
        status: 'active',
        evidence_count: 3,
        access_count: 1,
        version: 1,
        scope: 'auth/login',
        tags: '["jwt"]',
        related_ids: null,
      },
      {
        id: 'memory_2',
        session_id: 's2',
        project: 'test-project',
        provider: 'claude',
        memory_type: 'PREFERENCE',
        content: 'Use TypeScript strict mode',
        importance: 5,
        created_at: '2026-08-02T00:00:00.000Z',
        confidence: 0.5,
        status: 'active',
        evidence_count: 1,
        access_count: 0,
        version: 1,
        scope: null,
        tags: null,
        related_ids: null,
      },
    ];

    async function initPoolMock() {
      const { initPool } = await import(path.join(srcDir, 'database/connection.js'));
      return initPool;
    }

    afterEach(() => {
      if (origDbType === undefined) delete process.env.CODEATLAS_DB_TYPE;
      else process.env.CODEATLAS_DB_TYPE = origDbType;
    });

    beforeEach(() => {
      // Parent beforeEach only resets call history, not implementations —
      // restore a real embedding vector so vector-search paths are exercised.
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));
      mockDbAdapter.searchVector.mock.mockImplementation(() => Promise.resolve([
        { id: 'memory_1', score: 0.9 },
        { id: 'memory_2', score: 0.8 },
      ]));
    });

    for (const dbType of ['sqlite', 'postgres']) {
      test(`queryDreamMemories (${dbType}) never calls initPool`, async () => {
        process.env.CODEATLAS_DB_TYPE = dbType;
        mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
        mockConnection.execute.mock.mockImplementation(async () => {
          throw new Error('Oracle pool must not be used when CODEATLAS_DB_TYPE=' + dbType);
        });

        const rows = await OracleDreamingService.queryDreamMemories('test-project', 'how does node work?', 10);

        assert.strictEqual(rows.length, 2);
        const initPool = await initPoolMock();
        assert.strictEqual(initPool.mock.calls.length, 0, 'initPool must not be called');
        assert.strictEqual(mockPool.getConnection.mock.calls.length, 0);
        assert.strictEqual(mockConnection.execute.mock.calls.length, 0);
        assert.strictEqual(mockConnection.close.mock.calls.length, 0);
      });

      test(`deleteDreamMemory (${dbType}) never calls initPool`, async () => {
        process.env.CODEATLAS_DB_TYPE = dbType;
        mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));

        const deleted = await OracleDreamingService.deleteDreamMemory('memory_1');

        assert.strictEqual(deleted, true);
        const initPool = await initPoolMock();
        assert.strictEqual(initPool.mock.calls.length, 0, 'initPool must not be called');
        assert.strictEqual(mockDbAdapter.execute.mock.calls.length, 1);

        const sql = mockDbAdapter.execute.mock.calls[0].arguments[0] as string;
        const binds = mockDbAdapter.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.ok(sql.includes('DELETE FROM ai_dreaming_memory'));
        assert.strictEqual(binds.id, 'memory_1');
        assert.strictEqual(binds.tenantId, 'test-user');
      });
    }

    test('deleteDreamMemory (sqlite) returns false when no row matched', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 0 }));

      const deleted = await OracleDreamingService.deleteDreamMemory('missing-id');
      assert.strictEqual(deleted, false);
    });

    test('non-vector query (sqlite) uses LIMIT/OFFSET, not Oracle FETCH NEXT', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await OracleDreamingService.queryDreamMemories('test-project', 'anything', 7, 14);

      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
      const sql = mockDbAdapter.query.mock.calls[0].arguments[0] as string;
      const binds = mockDbAdapter.query.mock.calls[0].arguments[1] as Record<string, unknown>;

      assert.ok(sql.includes('LIMIT :limit OFFSET :offset'), 'must use SQLite pagination syntax');
      assert.ok(!sql.includes('FETCH NEXT'), 'must not emit Oracle-only FETCH NEXT');
      assert.ok(sql.includes('ORDER BY created_at DESC'));
      assert.strictEqual(binds.limit, 7);
      assert.strictEqual(binds.offset, 14);
      // searchVector skipped when there is no embedding
      assert.strictEqual(mockDbAdapter.searchVector.mock.calls.length, 0);
    });

    test('vector query (sqlite) binds searchVector ids and omits pagination binds', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await OracleDreamingService.queryDreamMemories('test-project', 'event loop', 10);

      assert.strictEqual(mockDbAdapter.searchVector.mock.calls.length, 1);
      const sql = mockDbAdapter.query.mock.calls[0].arguments[0] as string;
      const binds = mockDbAdapter.query.mock.calls[0].arguments[1] as Record<string, unknown>;

      assert.ok(sql.includes('id IN (:vecId0, :vecId1)'));
      assert.strictEqual(binds.vecId0, 'memory_1');
      assert.strictEqual(binds.vecId1, 'memory_2');
      // Pagination happens in memory for vector queries
      assert.ok(!sql.includes('LIMIT'));
      assert.strictEqual(binds.limit, undefined);
      assert.strictEqual(binds.offset, undefined);
    });

    test('empty searchVector result (sqlite) short-circuits without querying', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.searchVector.mock.mockImplementationOnce(() => Promise.resolve([]));

      const rows = await OracleDreamingService.queryDreamMemories('test-project', 'no match', 10);

      assert.deepStrictEqual(rows, []);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 0);
    });

    test('filters (sqlite) bind scope, tags and memory_type the same as Oracle', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await OracleDreamingService.queryDreamMemories(
        'test-project', 'filtered', 10, 0,
        'SESSION_SUMMARY, KNOWLEDGE', 'claude', undefined, undefined, 'auth', ['jwt', 'login'],
      );

      const sql = mockDbAdapter.query.mock.calls[0].arguments[0] as string;
      const binds = mockDbAdapter.query.mock.calls[0].arguments[1] as Record<string, unknown>;

      assert.strictEqual(binds.scopeExact, 'auth');
      assert.strictEqual(binds.scopeLike, 'auth/%');
      assert.strictEqual(binds.tag_like_0, '%"jwt"%');
      assert.strictEqual(binds.tag_like_1, '%"login"%');
      assert.strictEqual(binds.type0, 'SESSION_SUMMARY');
      assert.strictEqual(binds.type1, 'KNOWLEDGE');
      assert.strictEqual(binds.provider, 'claude');
      assert.ok(sql.includes('memory_type IN (:type0, :type1)'));
      assert.ok(sql.includes("status IN ('active', 'superseded')"));
      // No USER_TAB_COLUMNS probe — that is Oracle-only metadata
      assert.ok(!sql.includes('USER_TAB_COLUMNS'));
    });

    test('date filters (sqlite) are bound as Date objects', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      const start = new Date('2026-01-01');
      const end = new Date('2026-12-31');
      await OracleDreamingService.queryDreamMemories(
        'test-project', 'ranged', 10, 0, undefined, undefined, start, end,
      );

      const sql = mockDbAdapter.query.mock.calls[0].arguments[0] as string;
      const binds = mockDbAdapter.query.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.ok(sql.includes('created_at >= :startDate'));
      assert.ok(sql.includes('created_at <= :endDate'));
      assert.strictEqual(binds.startDate, start);
      assert.strictEqual(binds.endDate, end);
    });

    test('vector scoring (sqlite) reads lowercase keys and ranks by score', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      // memory_2 wins on vector score despite lower importance/confidence
      mockDbAdapter.searchVector.mock.mockImplementationOnce(() => Promise.resolve([
        { id: 'memory_1', score: 0.1 },
        { id: 'memory_2', score: 0.9 },
      ]));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      const rows = await OracleDreamingService.queryDreamMemories('test-project', 'ranked', 10) as Array<Record<string, unknown>>;

      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].id, 'memory_2', 'higher vector score must sort first');
      // Rows keep their original lowercase shape (no array conversion)
      assert.strictEqual(rows[0].memory_type, 'PREFERENCE');
      assert.strictEqual(rows[0].content, 'Use TypeScript strict mode');
    });

    test('scope boost (sqlite) prefers exact scope match over vector score', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.searchVector.mock.mockImplementationOnce(() => Promise.resolve([
        { id: 'memory_1', score: 0.30 },
        { id: 'memory_2', score: 0.50 },
      ]));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      // memory_1 has scope 'auth/login'; querying scope 'auth' gives it a 0.15 prefix boost
      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'scoped', 10, 0, undefined, undefined, undefined, undefined, 'auth',
      ) as Array<Record<string, unknown>>;

      assert.strictEqual(rows[0].id, 'memory_1');
    });

    test('in-memory pagination (sqlite) applies offset and limit after scoring', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.searchVector.mock.mockImplementationOnce(() => Promise.resolve([
        { id: 'memory_1', score: 0.9 },
        { id: 'memory_2', score: 0.1 },
      ]));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      const rows = await OracleDreamingService.queryDreamMemories(
        'test-project', 'paged', 1, 1,
      ) as Array<Record<string, unknown>>;

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 'memory_2', 'offset=1 must skip the top-scored row');
    });

    test('access_count bump failure (sqlite) is non-fatal', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.execute.mock.mockImplementation(async () => {
        throw new Error('database is locked');
      });

      const rows = await OracleDreamingService.queryDreamMemories('test-project', 'bump fails', 10);

      assert.strictEqual(rows.length, 2, 'results must still be returned');
      assert.ok(
        mockLogger.warn.mock.calls.length >= 1,
        'bump failure should be logged as a warning, not thrown',
      );
    });

    test('access_count bump (sqlite) updates each returned row', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));

      await OracleDreamingService.queryDreamMemories('test-project', 'bump ok', 10);

      assert.strictEqual(mockDbAdapter.execute.mock.calls.length, 2);
      const sql = mockDbAdapter.execute.mock.calls[0].arguments[0] as string;
      assert.ok(sql.includes('access_count = access_count + 1'));
      assert.ok(sql.includes('last_accessed_at = CURRENT_TIMESTAMP'));
    });

    test('unset CODEATLAS_DB_TYPE still uses the Oracle pool (no silent regression)', async () => {
      delete process.env.CODEATLAS_DB_TYPE;
      mockConnection.execute.mock.mockImplementation(async () => ({ rows: [] }));

      await OracleDreamingService.queryDreamMemories('test-project', 'oracle default', 10);

      const initPool = await initPoolMock();
      assert.ok(initPool.mock.calls.length >= 1, 'Oracle remains the default backend');
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 0);
    });

    test('unknown CODEATLAS_DB_TYPE falls back to the Oracle pool', async () => {
      process.env.CODEATLAS_DB_TYPE = 'mysql';
      mockConnection.execute.mock.mockImplementation(async () => ({ rows: [] }));

      await OracleDreamingService.queryDreamMemories('test-project', 'unknown backend', 10);

      const initPool = await initPoolMock();
      assert.ok(initPool.mock.calls.length >= 1);
    });

    test('CODEATLAS_DB_TYPE is case-insensitive', async () => {
      process.env.CODEATLAS_DB_TYPE = 'SQLite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await OracleDreamingService.queryDreamMemories('test-project', 'mixed case', 10);

      const initPool = await initPoolMock();
      assert.strictEqual(initPool.mock.calls.length, 0);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
    });
  });
});
