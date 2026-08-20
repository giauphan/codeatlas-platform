import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const opts = { exports: { default: mockObj, ...mockObj } };
  const specs = new Set<string>([specifier]);

  if (specifier.startsWith('/')) {
    specs.add(pathToFileURL(specifier).href);

    const basePath = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier.endsWith('.ts') ? specifier.slice(0, -2) : specifier;

    for (const p of [basePath + '.js', basePath + '.ts']) {
      specs.add(p);
      specs.add(pathToFileURL(p).href);
    }

    if (basePath.includes('/src/')) {
      for (const distPath of [basePath.replace('/src/', '/dist/'), basePath.replace('/src/', '/dist/src/')]) {
        for (const ext of ['.js', '.ts']) {
          const p = distPath + ext;
          specs.add(p);
          specs.add(pathToFileURL(p).href);
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
// Mock Dependencies BEFORE importing the module under test
// ═════════════════════════════════════════════════════════════════════

const mockCheckAuth = mock.fn();
const mockLogActivity = mock.fn();
const mockLoadAnalysis = mock.fn();
const mockSaveDreamMemory = mock.fn();
const mockQueryDreamMemories = mock.fn();

// Mock authService
const authServiceMock = { checkAuth: mockCheckAuth, logActivity: mockLogActivity };
safeMockModule(path.join(srcDir, 'services/authService.js'), authServiceMock);

// Mock dreamingService
const mockDreamingSvc = {
  saveDreamMemory: mockSaveDreamMemory,
  queryDreamMemories: mockQueryDreamMemories,
};
const dreamingServiceMock = { OracleDreamingService: mockDreamingSvc };
safeMockModule(path.join(srcDir, 'services/dreamingService.js'), dreamingServiceMock);

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

// Mock llmService & firebase
safeMockModule(path.join(srcDir, 'services/llmService.js'), { summarizeConversationForDreams: mock.fn() });
safeMockModule('firebase-admin/auth', { getAuth: () => ({ verifyIdToken: mock.fn() }) });
safeMockModule('firebase-admin/firestore', { getFirestore: () => ({ collection: () => ({ doc: () => ({ get: mock.fn() }) }) }) });

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
    mockAuthStore.run.mock.mockImplementation((_store: unknown, fn: () => unknown) => fn());

    // Reset call counts
    mockCheckAuth.mock.resetCalls();
    mockLogActivity.mock.resetCalls();
    mockLoadAnalysis.mock.resetCalls();
    mockSaveDreamMemory.mock.resetCalls();
    mockQueryDreamMemories.mock.resetCalls();
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
      mockCheckAuth.mock.mockImplementation(async () => {
        throw new Error('Authentication: Invalid API key');
      });

      const res = await fetch(
        `${baseUrl}/api/dreams/query?query=test`,
      );

      assert.strictEqual(res.status, 401);
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
  });
});
