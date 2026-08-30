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

// Mock database/factory.ts
type SqlBinds = Record<string, unknown>;
type SqlRows = Record<string, unknown>[];
type VectorSearchResult = { id: string; score: number };

const mockDbAdapter = {
  execute: mock.fn<(sql: string, binds?: SqlBinds) => Promise<{ rowsAffected: number }>>(
    () => Promise.resolve({ rowsAffected: 1 }),
  ),
  query: mock.fn<(sql: string, binds?: SqlBinds) => Promise<SqlRows>>(
    () => Promise.resolve([]),
  ),
  searchVector: mock.fn<(table: string, vector: number[], limit: number) => Promise<VectorSearchResult[]>>(
    () => Promise.resolve([
      { id: 'memory_1', score: 0.9 },
      { id: 'memory_2', score: 0.8 },
    ]),
  ),
  connect: mock.fn<() => Promise<void>>(() => Promise.resolve()),
  initializeSchema: mock.fn<() => Promise<void>>(() => Promise.resolve()),
  checkColumnExists: mock.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  disconnect: mock.fn<() => Promise<void>>(() => Promise.resolve()),
  executeMany: mock.fn<(sql: string, binds: SqlBinds[]) => Promise<{ rowsAffected: number }>>(
    () => Promise.resolve({ rowsAffected: 1 }),
  ),
};
const factoryMock = {
  createDatabaseAdapter: mock.fn(() => mockDbAdapter),
};
safeMockModule(path.join(srcDir, 'database/factory.js'), factoryMock);

// Mock embeddingService
const mockGenerateEmbedding = mock.fn<
  (text: string, mode?: 'passage' | 'query') => Promise<number[] | null>
>(() => Promise.resolve([0.1, 0.2, 0.3]));
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
const { DreamingService } = await import(
  path.join(srcDir, 'services/dreamingService.js')
);

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('DreamingService', () => {
  const _origDbTypeForFile = process.env.CODEATLAS_DB_TYPE;

  after(() => {
    if (_origDbTypeForFile === undefined) delete process.env.CODEATLAS_DB_TYPE;
    else process.env.CODEATLAS_DB_TYPE = _origDbTypeForFile;
  });

  beforeEach(async () => {
    process.env.CODEATLAS_DB_TYPE = 'sqlite';

    // Reset all mock call history between tests
    mockDbAdapter.execute.mock.resetCalls();
    mockDbAdapter.query.mock.resetCalls();
    mockDbAdapter.searchVector.mock.resetCalls();
    mockDbAdapter.connect.mock.resetCalls();
    mockDbAdapter.initializeSchema.mock.resetCalls();
    mockDbAdapter.checkColumnExists.mock.resetCalls();
    mockDbAdapter.disconnect.mock.resetCalls();
    mockGenerateEmbedding.mock.resetCalls();
    mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));
    mockAuthStore.getStore.mock.resetCalls();
    mockAuthStore.run.mock.resetCalls();
    mockLogger.info.mock.resetCalls();
    mockLogger.error.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();

    mockDbAdapter.execute.mock.mockImplementation(() => Promise.resolve({ rowsAffected: 1 }));
    mockDbAdapter.query.mock.mockImplementation(() => Promise.resolve([]));
    mockDbAdapter.searchVector.mock.mockImplementation(() => Promise.resolve([
      { id: 'memory_1', score: 0.9 },
      { id: 'memory_2', score: 0.8 },
    ]));
    mockDbAdapter.connect.mock.mockImplementation(() => Promise.resolve());
    mockDbAdapter.initializeSchema.mock.mockImplementation(() => Promise.resolve());
    mockDbAdapter.checkColumnExists.mock.mockImplementation(() => Promise.resolve(true));
    mockDbAdapter.disconnect.mock.mockImplementation(() => Promise.resolve());
  });

  // ── saveDreamMemory ────────────────────────────────────────────────
  describe('saveDreamMemory()', () => {
    test('with valid inputs returns id string', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const id = await DreamingService.saveDreamMemory(
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

      const id = await DreamingService.saveDreamMemory(
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
        () => DreamingService.saveDreamMemory(
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

      const longSummary = 'This is a detailed summary of the current working session. We implemented context retention across sessions by supporting scope, tags, and related_ids metadata fields in the SQLite database and MCP server.'.repeat(2);
      const id = await DreamingService.saveDreamMemory(
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

  // ── queryDreamMemories ──────────────────────────────────────────────
  describe('queryDreamMemories()', () => {
    const sampleRows = [
      { id: 'mem-1', session_id: 's1', project: 'test-project', memory_type: 'KNOWLEDGE', content: 'Node.js uses event loop', importance: 8, created_at: new Date('2025-01-01') },
      { id: 'mem-2', session_id: 's2', project: 'test-project', memory_type: 'PREFERENCE', content: 'Use TypeScript strict mode', importance: 5, created_at: new Date('2025-01-02') },
    ];

    test('returns adapter query results after vector search', async () => {
      mockDbAdapter.searchVector.mock.mockImplementation(async () => [
        { id: 'mem-1', score: 0.9 },
        { id: 'mem-2', score: 0.8 },
      ]);
      mockDbAdapter.query.mock.mockImplementation(async () => sampleRows);
      const rows = await DreamingService.queryDreamMemories('test-project', 'how does Node work?', 10);
      assert.deepStrictEqual(rows, sampleRows);
      assert.strictEqual(mockGenerateEmbedding.mock.calls[0].arguments[1], 'query');
      assert.strictEqual(mockDbAdapter.searchVector.mock.calls.length, 1);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
    });

    test('uses LIMIT/OFFSET when no embedding is available', async () => {
      mockGenerateEmbedding.mock.mockImplementationOnce(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sampleRows);
      await DreamingService.queryDreamMemories('test-project', 'search', 3, 2);
      const [sql, binds] = mockDbAdapter.query.mock.calls[0].arguments as [string, Record<string, unknown>];
      assert.ok(sql.includes('LIMIT :limit OFFSET :offset'));
      assert.strictEqual(binds.limit, 3);
      assert.strictEqual(binds.offset, 2);
    });

    test('binds SQLite scope, tags, and memory-type filters', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sampleRows);
      await DreamingService.queryDreamMemories('test-project', 'query filter', 10, 0, 'SESSION_SUMMARY, KNOWLEDGE', undefined, undefined, undefined, 'auth', ['jwt', 'login']);
      const [sql, binds] = mockDbAdapter.query.mock.calls[0].arguments as [string, Record<string, unknown>];
      assert.strictEqual(binds.scopeExact, 'auth');
      assert.strictEqual(binds.tag_like_0, '%"jwt"%');
      assert.strictEqual(binds.type1, 'KNOWLEDGE');
      assert.ok(sql.includes('memory_type IN (:type0, :type1)'));
      assert.ok(!sql.includes('USER_TAB_COLUMNS'));
    });
  });

  // ── deleteDreamMemory ──────────────────────────────────────────────
  describe('deleteDreamMemory()', () => {
    test('returns true when adapter deletes a row', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));
      assert.strictEqual(await DreamingService.deleteDreamMemory('mem-123'), true);
      const [sql, binds] = mockDbAdapter.execute.mock.calls[0].arguments as [string, Record<string, unknown>];
      assert.ok(sql.includes('DELETE FROM ai_dreaming_memory'));
      assert.strictEqual(binds.id, 'mem-123');
    });

    test('returns false when no row matches', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 0 }));
      assert.strictEqual(await DreamingService.deleteDreamMemory('nonexistent-id'), false);
    });

    test('propagates adapter errors', async () => {
      mockDbAdapter.execute.mock.mockImplementation(async () => { throw new Error('database is locked'); });
      await assert.rejects(() => DreamingService.deleteDreamMemory('fail-id'), /database is locked/);
    });
  });

  // ── initialize ─────────────────────────────────────────────────────
  describe('initialize()', () => {
    test('initializes SQLite schema and caches column availability', async () => {
      await DreamingService.initialize();
      assert.strictEqual(mockDbAdapter.connect.mock.calls.length, 1);
      assert.strictEqual(mockDbAdapter.initializeSchema.mock.calls.length, 1);
      assert.deepStrictEqual(mockDbAdapter.checkColumnExists.mock.calls.map(call => call.arguments), [
        ['ai_dreaming_memory', 'content_hash'],
        ['ai_dreaming_memory', 'status'],
      ]);
      assert.strictEqual(mockDbAdapter.disconnect.mock.calls.length, 1);
    });

    test('disconnects when schema initialization fails', async () => {
      mockDbAdapter.initializeSchema.mock.mockImplementation(async () => { throw new Error('schema failure'); });
      await assert.rejects(() => DreamingService.initialize(), /schema failure/);
      assert.strictEqual(mockDbAdapter.disconnect.mock.calls.length, 1);
    });
  });

  // ── SQLite / Postgres backend (CODEATLAS_DB_TYPE) ───────────────────
  // Guards the migration to SQLite-as-default: these paths must never touch
  // the configured adapter, otherwise the UI fails with
  // a database configuration error.
  describe('adapter backends via CODEATLAS_DB_TYPE', () => {
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
      mockDbAdapter.executeMany.mock.resetCalls();
    });

    for (const dbType of ['sqlite', 'postgres']) {
      test(`queryDreamMemories (${dbType}) never calls initPool`, async () => {
        process.env.CODEATLAS_DB_TYPE = dbType;
        mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

        const rows = await DreamingService.queryDreamMemories('test-project', 'how does node work?', 10);

        assert.strictEqual(rows.length, 2);
        assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
      });

      test(`deleteDreamMemory (${dbType}) never calls initPool`, async () => {
        process.env.CODEATLAS_DB_TYPE = dbType;
        mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));

        const deleted = await DreamingService.deleteDreamMemory('memory_1');

        assert.strictEqual(deleted, true);

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

      const deleted = await DreamingService.deleteDreamMemory('missing-id');
      assert.strictEqual(deleted, false);
    });

    test('non-vector query (sqlite) uses LIMIT/OFFSET, not FETCH NEXT', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await DreamingService.queryDreamMemories('test-project', 'anything', 7, 14);

      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
      const sql = mockDbAdapter.query.mock.calls[0].arguments[0] as string;
      const binds = mockDbAdapter.query.mock.calls[0].arguments[1] as Record<string, unknown>;

      assert.ok(sql.includes('LIMIT :limit OFFSET :offset'), 'must use SQLite pagination syntax');
      assert.ok(!sql.includes('FETCH NEXT'), 'must not emit FETCH NEXT');
      assert.ok(sql.includes('ORDER BY created_at DESC'));
      assert.strictEqual(binds.limit, 7);
      assert.strictEqual(binds.offset, 14);
      // searchVector skipped when there is no embedding
      assert.strictEqual(mockDbAdapter.searchVector.mock.calls.length, 0);
    });

    test('vector query (sqlite) binds searchVector ids and omits pagination binds', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await DreamingService.queryDreamMemories('test-project', 'event loop', 10);

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

      const rows = await DreamingService.queryDreamMemories('test-project', 'no match', 10);

      assert.deepStrictEqual(rows, []);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 0);
    });

    test('filters (sqlite) bind scope, tags and memory_type', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await DreamingService.queryDreamMemories(
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
      // No USER_TAB_COLUMNS probe — SQLite uses pragma table_info
      assert.ok(!sql.includes('USER_TAB_COLUMNS'));
    });

    test('date filters (sqlite) are bound as Date objects', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve(null));
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      const start = new Date('2026-01-01');
      const end = new Date('2026-12-31');
      await DreamingService.queryDreamMemories(
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

      const rows = await DreamingService.queryDreamMemories('test-project', 'ranked', 10) as Array<Record<string, unknown>>;

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
      const rows = await DreamingService.queryDreamMemories(
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

      const rows = await DreamingService.queryDreamMemories(
        'test-project', 'paged', 1, 1,
      ) as Array<Record<string, unknown>>;

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 'memory_2', 'offset=1 must skip the top-scored row');
    });

    test('access_count bump failure (sqlite) is non-fatal', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.executeMany.mock.mockImplementation(async () => {
        throw new Error('database is locked');
      });

      const rows = await DreamingService.queryDreamMemories('test-project', 'bump fails', 10);

      assert.strictEqual(rows.length, 2, 'results must still be returned');
      assert.ok(
        mockLogger.warn.mock.calls.length >= 1,
        'bump failure should be logged as a warning, not thrown',
      );
    });

    test('access_count bump (sqlite) updates each returned row', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.executeMany.mock.mockImplementation(async () => ({ rowsAffected: 2 }));

      await DreamingService.queryDreamMemories('test-project', 'bump ok', 10);

      assert.strictEqual(mockDbAdapter.executeMany.mock.calls.length, 1);
      const sql = mockDbAdapter.executeMany.mock.calls[0].arguments[0] as string;
      assert.ok(sql.includes('access_count = access_count + 1'));
      assert.ok(sql.includes('last_accessed_at = CURRENT_TIMESTAMP'));
    });

    test('unset and unknown database types use the SQLite adapter', async () => {
      delete process.env.CODEATLAS_DB_TYPE;
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      await DreamingService.queryDreamMemories('test-project', 'default backend', 10);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);

      process.env.CODEATLAS_DB_TYPE = 'mysql';
      mockDbAdapter.query.mock.resetCalls();
      await DreamingService.queryDreamMemories('test-project', 'unknown backend', 10);
      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
    });

    test('CODEATLAS_DB_TYPE is case-insensitive', async () => {
      process.env.CODEATLAS_DB_TYPE = 'SQLite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);

      await DreamingService.queryDreamMemories('test-project', 'mixed case', 10);

      assert.strictEqual(mockDbAdapter.query.mock.calls.length, 1);
    });

    test('queryDreamMemories filters blocklisted content (inject-gate)', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      const sqliteRows = [
        {
          id: '1',
          session_id: 's1',
          project: 'p',
          provider: 'claude',
          memory_type: 'KNOWLEDGE',
          content: 'khi nào dùng raining and khi dùng rainy?',
          importance: 6,
          created_at: '2026-08-01T00:00:00.000Z',
          confidence: 0.7,
          status: 'active',
          evidence_count: 1,
          access_count: 0,
          version: 1,
          scope: null,
          tags: null,
          related_ids: null,
        },
        {
          id: '2',
          session_id: 's2',
          project: 'p',
          provider: 'claude',
          memory_type: 'KNOWLEDGE',
          content: 'Using a connection pool with initPool() avoids ORA-00001 collisions when upserting dream memories',
          importance: 8,
          created_at: '2026-08-02T00:00:00.000Z',
          confidence: 0.8,
          status: 'active',
          evidence_count: 1,
          access_count: 0,
          version: 1,
          scope: null,
          tags: null,
          related_ids: null,
        },
      ];
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));

      const rows = await DreamingService.queryDreamMemories('p', 'some task', 10);

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, '2');
    });

    test('queryDreamMemories drops dreams below CODEATLAS_DREAM_MIN_SCORE (relevance gate)', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));
      // memory_1 baseScore 0.9, memory_2 baseScore 0.8 (from beforeEach searchVector mock)
      mockDbAdapter.searchVector.mock.mockImplementation(() => Promise.resolve([
        { id: 'memory_1', score: 0.9 },
        { id: 'memory_2', score: 0.2 },
      ]));

      const origMinScore = process.env.CODEATLAS_DREAM_MIN_SCORE;
      process.env.CODEATLAS_DREAM_MIN_SCORE = '0.8';
      try {
        const rows = await DreamingService.queryDreamMemories('test-project', 'event loop', 10);
        assert.equal(rows.length, 1, 'only the high-score dream survives the relevance gate');
        assert.equal(rows[0].id, 'memory_1');
      } finally {
        if (origMinScore === undefined) delete process.env.CODEATLAS_DREAM_MIN_SCORE;
        else process.env.CODEATLAS_DREAM_MIN_SCORE = origMinScore;
      }
    });

    test('queryDreamMemories keeps all dreams when CODEATLAS_DREAM_MIN_SCORE unset', async () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      mockDbAdapter.query.mock.mockImplementation(async () => sqliteRows);
      mockDbAdapter.execute.mock.mockImplementation(async () => ({ rowsAffected: 1 }));
      mockDbAdapter.searchVector.mock.mockImplementation(() => Promise.resolve([
        { id: 'memory_1', score: 0.9 },
        { id: 'memory_2', score: 0.2 },
      ]));

      const origMinScore = process.env.CODEATLAS_DREAM_MIN_SCORE;
      delete process.env.CODEATLAS_DREAM_MIN_SCORE;
      try {
        const rows = await DreamingService.queryDreamMemories('test-project', 'event loop', 10);
        assert.equal(rows.length, 2, 'no relevance floor means both dreams are returned');
      } finally {
        if (origMinScore === undefined) delete process.env.CODEATLAS_DREAM_MIN_SCORE;
        else process.env.CODEATLAS_DREAM_MIN_SCORE = origMinScore;
      }
    });
  });
});

describe('noise blocklist save-gate', () => {
  test('blocks english word-choice content', () => {
    const r = DreamingService.checkNoise('KNOWLEDGE', 'Khi nào dùng raining and khi dùng rainy? Trong bài nói raining (adj)', 6);
    assert.equal(r.isNoise, true);
  });

  test('blocks shopping list content with valid length/importance', () => {
    const r = DreamingService.checkNoise('KNOWLEDGE', 'write a shopping list before going to the store and buy low-fat milk and plain yogurt', 5);
    assert.equal(r.isNoise, true);
  });

  test('blocks scheduler retry content', () => {
    const r = DreamingService.checkNoise('KNOWLEDGE', '`--retry-failed` for YouTube and clear the stuck `scheduling` records for IG/FB', 6);
    assert.equal(r.isNoise, true);
  });

  test('keeps genuine code knowledge', () => {
    const r = DreamingService.checkNoise('KNOWLEDGE', 'Using a connection pool with initPool() avoids unique-constraint collisions when upserting dream memories', 8);
    assert.equal(r.isNoise, false);
  });
});
