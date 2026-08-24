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
// Mock Dependencies BEFORE importing the module under test
// ═════════════════════════════════════════════════════════════════════

const mockCheckAuth = mock.fn();
const mockLogActivity = mock.fn();
const mockLoadAnalysis = mock.fn();
const mockSaveDreamMemory = mock.fn();
const mockQueryDreamMemories = mock.fn();
const mockSummarizeConversation = mock.fn();

// Mock authService
const authServiceMock = { checkAuth: mockCheckAuth, logActivity: mockLogActivity };
safeMockModule(path.join(srcDir, 'services/authService.js'), authServiceMock);

// Mock dreamingService
const dreamingServiceMock = {
  OracleDreamingService: {
    saveDreamMemory: mockSaveDreamMemory,
    queryDreamMemories: mockQueryDreamMemories,
  },
};
safeMockModule(path.join(srcDir, 'services/dreamingService.js'), dreamingServiceMock);

safeMockModule(path.join(srcDir, 'services/llmService.js'), {
  summarizeConversationForDreams: mockSummarizeConversation,
});

// Mock projectService
const projectServiceMock = { loadAnalysisAsync: mockLoadAnalysis };
safeMockModule(path.join(srcDir, 'services/projectService.js'), projectServiceMock);

// Mock context
const mockAuthStore = {
  getStore: mock.fn(() => null),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
const contextMock = { authStorage: mockAuthStore };
safeMockModule(path.join(srcDir, 'utils/context.js'), contextMock);

// Mock logger
const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn(),
};
const loggerMock = { logger: mockLogger };
safeMockModule(path.join(srcDir, 'utils/logger.js'), loggerMock);

// Mock authMiddleware
safeMockModule(path.join(srcDir, 'middleware/auth.js'), {
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
});

// ── Import modules under test ────────────────────────────────────────
const { registerDreamingRoutes } = await import(
  path.join(srcDir, 'presentation/dreamingRoutes.js')
);
const express = await import('express');
const http = await import('node:http');

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Dreaming Routes', () => {
  let app: ReturnType<typeof express.default>;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    // Set default mock behaviour
    mockCheckAuth.mock.mockImplementation(async () => ({
      uid: 'test-user',
      tier: 'enterprise',
      keyId: 'test-key',
    }));
    mockLogActivity.mock.mockImplementation(async () => {});
    mockLoadAnalysis.mock.mockImplementation(async () => null);
    mockAuthStore.getStore.mock.mockImplementation(() => ({
      uid: 'test-user',
      tier: 'enterprise',
      keyId: 'test-key',
    }));
    mockAuthStore.run.mock.mockImplementation((_store: unknown, fn: () => unknown) => fn());
  });

  beforeEach(() => {
    // Create a fresh Express app and server for each test
    app = express.default();
    app.use(express.default.json());
    registerDreamingRoutes(app);

    server = http.createServer(app);

    // Listen on a random port
    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    // Restore default mock implementations
    mockCheckAuth.mock.mockImplementation(async () => ({
      uid: 'test-user',
      tier: 'enterprise',
      keyId: 'test-key',
    }));
    mockLogActivity.mock.mockImplementation(async () => {});
    mockLoadAnalysis.mock.mockImplementation(async () => null);
    mockAuthStore.getStore.mock.mockImplementation(() => ({
      uid: 'test-user',
      tier: 'enterprise',
      keyId: 'test-key',
    }));
    mockAuthStore.run.mock.mockImplementation((_store: unknown, fn: () => unknown) => fn());

    // Reset call counts
    mockCheckAuth.mock.resetCalls();
    mockLogActivity.mock.resetCalls();
    mockLoadAnalysis.mock.resetCalls();
    mockSaveDreamMemory.mock.resetCalls();
    mockQueryDreamMemories.mock.resetCalls();
    mockSummarizeConversation.mock.resetCalls();
    mockAuthStore.getStore.mock.resetCalls();
    mockAuthStore.run.mock.resetCalls();
    mockLogger.error.mock.resetCalls();

    // Shut down server
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ── POST /api/dreams/save ──────────────────────────────────────────
  describe('POST /api/dreams/save', () => {
    test('with valid inputs returns 200 + id', async () => {
      mockSaveDreamMemory.mock.mockImplementation(async () =>
        'proj_KNOWLEDGE_sess_1234567890',
      );

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'KNOWLEDGE',
          content: 'Node.js uses event loop for async I/O',
          importance: 7,
          session_id: 'sess-123',
          project: 'test-project',
        }),
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.id, 'proj_KNOWLEDGE_sess_1234567890');
      assert.strictEqual(body.memory_type, 'KNOWLEDGE');

      // Verify service was called with correct params
      assert.strictEqual(mockSaveDreamMemory.mock.calls.length, 1);
      const args = mockSaveDreamMemory.mock.calls[0].arguments;
      assert.strictEqual(args[0], 'test-project'); // project
      assert.strictEqual(args[1], 'sess-123'); // sessionId
      assert.strictEqual(args[2], 'KNOWLEDGE'); // memoryType
      assert.strictEqual(args[3], 'Node.js uses event loop for async I/O'); // content
      assert.strictEqual(args[4], 7); // importance
    });

    test('with wrong apiKey returns 401', async () => {
      mockCheckAuth.mock.mockImplementation(async () => {
        throw new Error('Authentication: Invalid API key');
      });

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=wrong-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'KNOWLEDGE',
          content: 'some content',
        }),
      });

      assert.strictEqual(res.status, 401);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('API key'));
    });

    test('with invalid memory_type returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'INVALID_TYPE',
          content: 'some content',
        }),
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('memory_type'));
    });

    test('with missing content returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'MISTAKE',
        }),
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('content'));
    });

    test('with optional fields omitted defaults to importance=5 and session_id=unknown', async () => {
      mockSaveDreamMemory.mock.mockImplementation(async () => 'id-1');

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'PATTERN',
          content: 'test content',
        }),
      });

      assert.strictEqual(res.status, 200);

      // Verify defaults were used
      assert.strictEqual(mockSaveDreamMemory.mock.calls.length, 1);
      const args = mockSaveDreamMemory.mock.calls[0].arguments;
      assert.strictEqual(args[1], 'unknown'); // default session_id
      assert.strictEqual(args[4], 5); // default importance
      assert.strictEqual(args[0], 'global'); // default project
    });

    test('with project that loads analysis uses resolved projectName', async () => {
      mockLoadAnalysis.mock.mockImplementation(async () => ({
        projectName: 'resolved-project-name',
      }));
      mockSaveDreamMemory.mock.mockImplementation(async () => 'id-2');

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'PREFERENCE',
          content: 'prefer strict mode',
          project: 'my-project',
        }),
      });

      assert.strictEqual(res.status, 200);

      // Should have used resolved project name
      const args = mockSaveDreamMemory.mock.calls[0].arguments;
      assert.strictEqual(args[0], 'resolved-project-name');
    });

    test('with DB error returns 500', async () => {
      mockSaveDreamMemory.mock.mockImplementation(async () => {
        throw new Error('ORA-00001: unique constraint violation');
      });

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_type: 'KNOWLEDGE',
          content: 'some content',
        }),
      });

      assert.strictEqual(res.status, 500);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('ORA-00001'));
    });
  });

  // ── GET /api/dreams/query ──────────────────────────────────────────
  describe('GET /api/dreams/query', () => {
    const sampleMemories = [
      {
        ID: 'mem-1',
        SESSION_ID: 's1',
        PROJECT: 'proj',
        MEMORY_TYPE: 'KNOWLEDGE',
        CONTENT: 'Node.js uses event loop',
        IMPORTANCE: 8,
        CREATED_AT: '2025-01-01',
      },
      {
        ID: 'mem-2',
        SESSION_ID: 's2',
        PROJECT: 'proj',
        MEMORY_TYPE: 'PREFERENCE',
        CONTENT: 'Use strict mode',
        IMPORTANCE: 5,
        CREATED_AT: '2025-01-02',
      },
    ];

    test('returns memories array', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => sampleMemories);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=how+does+node+work&project=test`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(Array.isArray(body.memories));
      assert.strictEqual(body.count, 2);
      assert.strictEqual(
        (body.memories as Record<string, unknown>[])[0].memory_type,
        'KNOWLEDGE',
      );
    });

    test('respects limit param', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => [sampleMemories[0]]);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=test&limit=1`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.count, 1);

      // Verify limit was passed to service
      assert.strictEqual(mockQueryDreamMemories.mock.calls.length, 1);
      const args = mockQueryDreamMemories.mock.calls[0].arguments;
      assert.strictEqual(args[2], 1); // limit
    });

    test('without query param returns recent memories (empty query allowed)', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key`,
      );

      assert.strictEqual(res.status, 200);
    });

    test('with empty query string returns recent memories (empty query allowed)', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=`,
      );

      assert.strictEqual(res.status, 200);
    });

    test('with invalid limit returns 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=test&limit=invalid`,
      );

      assert.strictEqual(res.status, 400);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('limit'));
    });

    test('with limit > 100 returns 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=test&limit=200`,
      );

      assert.strictEqual(res.status, 400);
    });

    test('with wrong apiKey returns 401 (auth required for GET /query now)', async () => {
      mockAuthStore.getStore.mock.mockImplementation(() => null);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?query=test`,
      );

      assert.strictEqual(res.status, 200);
    });

    test('with DB error returns 500', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => {
        throw new Error('ORA-00942: table does not exist');
      });

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=test`,
      );

      assert.strictEqual(res.status, 500);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('ORA-00942'));
    });

    test('with empty results returns empty array and count 0', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=nonexistent`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(Array.isArray(body.memories));
      assert.strictEqual(body.count, 0);
    });

    // SQLite/Postgres return lowercase column keys; the route mapper must
    // normalize them so the UI renders the same shape as the Oracle path.
    test('maps lowercase SQLite row keys to response fields', async () => {
      const sqliteMemories = [
        {
          id: 'mem-lc-1',
          session_id: 'sess-lc',
          project: 'proj',
          provider: 'claude',
          memory_type: 'KNOWLEDGE',
          content: 'lowercase content from sqlite',
          importance: 7,
          created_at: '2026-08-10',
          scope: 'auth/login',
          tags: '["jwt","security"]',
          related_ids: '["rel-1"]',
        },
      ];
      mockQueryDreamMemories.mock.mockImplementation(async () => sqliteMemories);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=lowercase`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.count, 1);
      const m = (body.memories as Record<string, unknown>[])[0];
      assert.strictEqual(m.id, 'mem-lc-1');
      assert.strictEqual(m.session_id, 'sess-lc');
      assert.strictEqual(m.memory_type, 'KNOWLEDGE');
      assert.strictEqual(m.content, 'lowercase content from sqlite');
      assert.strictEqual(m.scope, 'auth/login');
      assert.deepStrictEqual(m.tags, ['jwt', 'security']);
      assert.deepStrictEqual(m.related_ids, ['rel-1']);
    });

    // Guards against a regression where only Oracle uppercase keys were read,
    // which would silently blank out every field under SQLite/Postgres.
    test('still maps uppercase Oracle row keys', async () => {
      const oracleMemories = [
        {
          ID: 'mem-uc-1',
          SESSION_ID: 'sess-uc',
          PROJECT: 'proj',
          PROVIDER: 'claude',
          MEMORY_TYPE: 'MISTAKE',
          CONTENT: 'uppercase content from oracle',
          IMPORTANCE: 9,
          CREATED_AT: '2026-08-11',
          SCOPE: null,
          TAGS: null,
          RELATED_IDS: null,
        },
      ];
      mockQueryDreamMemories.mock.mockImplementation(async () => oracleMemories);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=uppercase`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      const m = (body.memories as Record<string, unknown>[])[0];
      assert.strictEqual(m.id, 'mem-uc-1');
      assert.strictEqual(m.memory_type, 'MISTAKE');
      assert.strictEqual(m.content, 'uppercase content from oracle');
    });

    // The DB-type migration must never surface Oracle credential errors in
    // the UI: reproduces the "ORACLE_PASSWORD environment variable is required"
    // failure as a 500 with the message propagated.
    test('propagates ORACLE_PASSWORD error as 500 (dream-memory UI regression)', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => {
        throw new Error('ORACLE_PASSWORD environment variable is required');
      });

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=whatever`,
      );

      assert.strictEqual(res.status, 500);
      const body = await res.json() as Record<string, unknown>;
      assert.ok((body.error as string).includes('ORACLE_PASSWORD'));
    });
  });

  describe('POST /api/dreams/ingest-session', () => {
    test('successfully ingests transcripts and filters noise-blocked saves', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Node is fast', importance: 7 },
        { memoryType: 'MISTAKE', content: 'Bad query', importance: 8 },
      ]);
      let saveCount = 0;
      mockSaveDreamMemory.mock.mockImplementation(async (project, sessionId, memoryType, content, importance, provider) => {
        saveCount++;
        if (content === 'Bad query') return '__noise_blocked__';
        return `saved-${saveCount}`;
      });

      const res = await fetch(`${baseUrl}/api/dreams/ingest-session?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '[USER]\nValid sentence pattern test database pooling.',
          session_id: 's-ingest-1',
          project: 'proj-ingest-1',
          provider: 'hermes',
        }),
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.session_id, 's-ingest-1');
      assert.strictEqual(body.dreamsExtracted, 1);
      assert.strictEqual(body.noiseBlocked, 1);

      assert.strictEqual(mockSummarizeConversation.mock.calls.length, 1);
      const sumArgs = mockSummarizeConversation.mock.calls[0].arguments;
      assert.strictEqual(sumArgs[0], '[USER]\nValid sentence pattern test database pooling.');
      assert.strictEqual(sumArgs[1], 'hermes');
      assert.strictEqual(sumArgs[2], 'proj-ingest-1');
      assert.strictEqual(sumArgs[3], 's-ingest-1');

      assert.strictEqual(mockSaveDreamMemory.mock.calls.length, 2);
      const save1Args = mockSaveDreamMemory.mock.calls[0].arguments;
      assert.strictEqual(save1Args[0], 'proj-ingest-1');
      assert.strictEqual(save1Args[1], 's-ingest-1');
      assert.strictEqual(save1Args[2], 'KNOWLEDGE');
      assert.strictEqual(save1Args[3], 'Node is fast');
      assert.strictEqual(save1Args[4], 7);
      assert.strictEqual(save1Args[5], 'hermes');
    });

    test('returns 400 for empty or invalid content', async () => {
      const res = await fetch(`${baseUrl}/api/dreams/ingest-session?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '',
        }),
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(String(body.error).includes('content'));
    });

    test('returns 200 with 0 dreams extracted if summarizer returns empty', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => []);

      const res = await fetch(`${baseUrl}/api/dreams/ingest-session?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'some non-matching transcript',
        }),
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.dreamsExtracted, 0);
    });
  });
});
