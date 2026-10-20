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
const mockSaveDreamMemoryWithAck = mock.fn();
const mockAcceptCapture = mock.fn();
const mockQueryDreamMemories = mock.fn();
const mockQueryDreamMemoriesWithStatus = mock.fn(async (...args: unknown[]) => {
  const memories = await mockQueryDreamMemories(...args);
  return {
    memories,
    retrieval_status: memories.length > 0 ? 'ok' : 'empty',
    candidate_count: memories.length,
    returned_count: memories.length,
  };
});
const mockSummarizeConversation = mock.fn();

// Mock authService
const authServiceMock = { checkAuth: mockCheckAuth, logActivity: mockLogActivity };
safeMockModule(path.join(srcDir, 'services/authService.js'), authServiceMock);

// Mock dreamingService
const dreamingServiceMock = {
  DreamingService: {
    saveDreamMemory: mockSaveDreamMemory,
    saveDreamMemoryWithAck: mockSaveDreamMemoryWithAck,
    queryDreamMemories: mockQueryDreamMemories,
    queryDreamMemoriesWithStatus: mockQueryDreamMemoriesWithStatus,
  },
};
safeMockModule(path.join(srcDir, 'services/dreamingService.js'), dreamingServiceMock);
safeMockModule(path.join(srcDir, 'services/dreamCaptureStore.js'), {
  DreamCaptureStore: { accept: mockAcceptCapture },
});

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
    mockSaveDreamMemoryWithAck.mock.resetCalls();
    mockAcceptCapture.mock.resetCalls();
    mockQueryDreamMemories.mock.resetCalls();
    mockQueryDreamMemoriesWithStatus.mock.resetCalls();
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
    test('returns a typed stored acknowledgement and forwards the idempotency key', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({
        status: 'stored',
        persisted: true,
        id: 'memory-typed-1',
      }));
      const content = 'Node.js uses event loop for async I/O and this sentence is long enough.';

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'event-123', 'X-Request-ID': 'trace-test-1' },
        body: JSON.stringify({ memory_type: 'KNOWLEDGE', content, project: 'typed-project' }),
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, 'stored');
      assert.equal(body.persisted, true);
      assert.equal(body.success, true);
      assert.equal(body.id, 'memory-typed-1');
      assert.equal(body.memory_id, 'memory-typed-1');
      assert.equal(body.request_id, 'trace-test-1');
      assert.equal(res.headers.get('x-request-id'), 'trace-test-1');
      const args = mockSaveDreamMemoryWithAck.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
      assert.strictEqual(args.project, 'typed-project');
      assert.strictEqual(args.content, content);
      assert.strictEqual(args.idempotencyKey, 'event-123');
      const logArgs = mockLogActivity.mock.calls.at(-1)?.arguments[2] as Record<string, unknown>;
      assert.strictEqual(logArgs.content, undefined);
      assert.strictEqual(logArgs.content_length, content.length);
    });

    test('does not claim persistence or expose an id for filtered content', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({
        status: 'filtered',
        persisted: false,
        reason_code: 'noise_blocked',
      }));

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory_type: 'KNOWLEDGE', content: 'filtered content' }),
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, 'filtered');
      assert.equal(body.persisted, false);
      assert.equal(body.success, true);
      assert.equal(body.reason_code, 'noise_blocked');
      assert.equal(body.id, undefined);
      assert.equal(body.memory_id, undefined);
    });

    test('rejects idempotency key reuse with different content', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({
        status: 'rejected',
        persisted: false,
        reason_code: 'idempotency_key_reused',
      }));

      const res = await fetch(`${baseUrl}/api/dreams/save?apiKey=valid-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'event-123' },
        body: JSON.stringify({ memory_type: 'KNOWLEDGE', content: 'different content for same event key' }),
      });

      assert.strictEqual(res.status, 409);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, 'rejected');
      assert.equal(body.persisted, false);
      assert.equal(body.success, false);
      assert.equal(body.reason_code, 'idempotency_key_reused');
      assert.equal(body.id, undefined);
      assert.equal(body.memory_id, undefined);
    });

    test('with valid inputs returns 200 + id', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({
        status: 'stored', persisted: true, id: 'proj_KNOWLEDGE_sess_1234567890',
      }));

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
      assert.strictEqual(body.status, 'stored');
      assert.strictEqual(body.persisted, true);
      assert.strictEqual(body.id, 'proj_KNOWLEDGE_sess_1234567890');
      assert.strictEqual(body.memory_id, 'proj_KNOWLEDGE_sess_1234567890');
      assert.strictEqual(body.success, true);
      assert.ok(typeof body.request_id === 'string');

      // Verify service was called with correct params
      assert.strictEqual(mockSaveDreamMemoryWithAck.mock.calls.length, 1);
      const args = mockSaveDreamMemoryWithAck.mock.calls[0].arguments[0] as Record<string, unknown>;
      assert.strictEqual(args.project, 'test-project');
      assert.strictEqual(args.sessionId, 'sess-123');
      assert.strictEqual(args.memoryType, 'KNOWLEDGE');
      assert.strictEqual(args.content, 'Node.js uses event loop for async I/O');
      assert.strictEqual(args.importance, 7);
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
      assert.equal(body.status, 'error');
      assert.equal(body.persisted, false);
      assert.equal(body.success, false);
      assert.equal(body.reason_code, 'authentication_failed');
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
      assert.equal(body.status, 'rejected');
      assert.equal(body.persisted, false);
      assert.equal(body.success, false);
      assert.equal(body.reason_code, 'invalid_memory_type');
      assert.equal(body.request_id, res.headers.get('x-request-id'));
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
      assert.equal(body.status, 'rejected');
      assert.equal(body.persisted, false);
      assert.equal(body.success, false);
      assert.equal(body.reason_code, 'invalid_content');
      assert.equal(body.request_id, res.headers.get('x-request-id'));
    });

    test('with optional fields omitted defaults to importance=5 and session_id=unknown', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'stored', persisted: true, id: 'id-1' }));

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
      assert.strictEqual(mockSaveDreamMemoryWithAck.mock.calls.length, 1);
      const args = mockSaveDreamMemoryWithAck.mock.calls[0].arguments[0] as Record<string, unknown>;
      assert.strictEqual(args.sessionId, 'unknown');
      assert.strictEqual(args.importance, 5);
      assert.strictEqual(args.project, 'global');
    });

    test('with project that loads analysis uses resolved projectName', async () => {
      mockLoadAnalysis.mock.mockImplementation(async () => ({
        projectName: 'resolved-project-name',
      }));
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'stored', persisted: true, id: 'id-2' }));

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
      const args = mockSaveDreamMemoryWithAck.mock.calls[0].arguments[0] as Record<string, unknown>;
      assert.strictEqual(args.project, 'resolved-project-name');
    });

    test('with DB error returns 500', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'error', persisted: false, reason_code: 'save_failed' }));

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
      assert.equal(body.status, 'error');
      assert.equal(body.persisted, false);
      assert.equal(body.success, false);
      assert.equal(body.reason_code, 'save_failed');
    });
  });

  describe('GET /api/admin/dreams/diagnostics', () => {
    test('returns aggregate counters only to an admin', async () => {
      mockAuthStore.getStore.mock.mockImplementation(() => ({
        uid: 'admin-user',
        role: 'admin',
        tier: 'enterprise',
      }));

      const res = await fetch(`${baseUrl}/api/admin/dreams/diagnostics`);

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(body.counters && typeof body.counters === 'object');
      const counters = body.counters as Record<string, unknown>;
      const requiredCounters = [
        'stored', 'filtered', 'duplicate', 'failed', 'queried', 'retrieved', 'injected', 'cron',
        'events_stored', 'events_duplicate', 'events_filtered', 'events_failed',
        'capture_received', 'capture_stored', 'capture_filtered', 'capture_duplicate', 'capture_failed',
        'reconciliation_runs', 'reconciliation_processed', 'reconciliation_filtered', 'reconciliation_failed',
        'reconciliation_events', 'reconciliation_duration_ms_total', 'reconciliation_duration_ms_max',
        'reconciliation_lag_ms_latest', 'reconciliation_lag_ms_max',
        'retrieval_empty', 'retrieval_no_match', 'retrieval_filtered', 'retrieval_error',
        'scheduler_success', 'scheduler_failure', 'scheduler_lease_lost',
        'scheduler_duration_ms_total', 'scheduler_duration_ms_max',
      ];
      assert.ok(requiredCounters.every(key => Object.hasOwn(counters, key)));
      assert.ok(Object.values(counters).every(value => typeof value === 'number' && Number.isFinite(value)));
      assert.doesNotMatch(JSON.stringify(body), /content|transcript|session|tenant|project|event_id|authorization|token/i);
    });

    test('denies diagnostics to non-admins', async () => {
      mockAuthStore.getStore.mock.mockImplementation(() => ({
        uid: 'test-user',
        role: 'user',
        tier: 'enterprise',
      }));

      const res = await fetch(`${baseUrl}/api/admin/dreams/diagnostics`);

      assert.strictEqual(res.status, 403);
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
      const logArgs = mockLogActivity.mock.calls.at(-1)?.arguments[2] as Record<string, unknown>;
      assert.equal(logArgs.query, undefined);
      assert.equal(logArgs.query_length, 'how does node work'.length);
    });

    test('forwards canonical identity audit metadata without changing project scope', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);
      const res = await fetch(`${baseUrl}/api/dreams/query?apiKey=valid-key&project_id=canonical-id&project=legacy-name&display_name=Friendly%20Project&workspace_path=%2Fwork%2Frepos%2Fproject-one`);
      assert.equal(res.status, 200);
      const args = mockQueryDreamMemoriesWithStatus.mock.calls.at(-1)?.arguments ?? [];
      assert.equal(args[10], 'canonical-id');
      assert.equal(args[11], 'Friendly Project');
      assert.equal(args[12], '/work/repos/project-one');
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
      assert.equal(body.error, 'Query failed');
      assert.equal(body.retrieval_status, 'backend_error');
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
    // normalize them so the UI renders a stable shape.
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

    // Guards against a regression where only uppercase keys were read,
    // which would silently blank out every field under SQLite/Postgres.
    test('still maps uppercase row keys', async () => {
      const uppercaseMemories = [
        {
          ID: 'mem-uc-1',
          SESSION_ID: 'sess-uc',
          PROJECT: 'proj',
          PROVIDER: 'claude',
          MEMORY_TYPE: 'MISTAKE',
          CONTENT: 'uppercase content',
          IMPORTANCE: 9,
          CREATED_AT: '2026-08-11',
          SCOPE: null,
          TAGS: null,
          RELATED_IDS: null,
        },
      ];
      mockQueryDreamMemories.mock.mockImplementation(async () => uppercaseMemories);

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=uppercase`,
      );

      assert.strictEqual(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      const m = (body.memories as Record<string, unknown>[])[0];
      assert.strictEqual(m.id, 'mem-uc-1');
      assert.strictEqual(m.memory_type, 'MISTAKE');
      assert.strictEqual(m.content, 'uppercase content');
    });

    test('propagates database errors as 500', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => {
        throw new Error('database is locked');
      });

      const res = await fetch(
        `${baseUrl}/api/dreams/query?apiKey=valid-key&query=whatever`,
      );

      assert.strictEqual(res.status, 500);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.error, 'Query failed');
      assert.equal(body.retrieval_status, 'backend_error');
    });
  });

  describe('POST /api/dreams/ingest-session', () => {
    test('durably acknowledges a normalized event with its event id and no fake memory ids', async () => {
      mockAcceptCapture.mock.mockImplementation(async () => ({
        success: true,
        status: 'stored',
        persisted: true,
        acknowledged: true,
        event_id: 'evt-123',
        memory_ids: [],
      }));
      const res = await fetch(`${baseUrl}/api/dreams/ingest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'valid-key' },
        body: JSON.stringify({
          event_id: 'evt-123',
          session_id: 'session-1',
          actor_role: 'USER',
          project_id: 'project-id',
          project: 'display-project',
          display_name: 'Friendly Project',
          workspace_path: '/work/repos/project-one',
          content: 'A bounded normalized event segment.',
          checkpoint: { kind: 'progress' },
        }),
      });
      const body = await res.json() as Record<string, unknown>;

      assert.equal(res.status, 200);
      assert.equal(body.status, 'stored');
      assert.equal(body.persisted, true);
      assert.equal(body.acknowledged, true);
      assert.equal(body.event_id, 'evt-123');
      assert.deepEqual(body.memory_ids, []);
      assert.equal(mockAcceptCapture.mock.callCount(), 1);
      const input = mockAcceptCapture.mock.calls[0].arguments[0] as Record<string, unknown>;
      assert.equal(input.eventId, 'evt-123');
      assert.equal(input.actorRole, 'USER');
      assert.equal(input.projectId, 'project-id');
      assert.equal(input.displayName, 'Friendly Project');
      assert.equal(input.workspacePath, '/work/repos/project-one');
      assert.deepEqual(input.checkpoint, { kind: 'progress' });
    });

    test('does not acknowledge a malformed event and retains legacy transcript flow without event_id', async () => {
      const invalid = await fetch(`${baseUrl}/api/dreams/ingest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'valid-key' },
        body: JSON.stringify({ event_id: 'evt-123', content: 'missing session and project' }),
      });
      const invalidBody = await invalid.json() as Record<string, unknown>;
      assert.equal(invalid.status, 400);
      assert.equal(invalidBody.acknowledged, false);
      assert.equal(mockAcceptCapture.mock.callCount(), 0);

      mockSummarizeConversation.mock.mockImplementation(async () => []);
      const legacy = await fetch(`${baseUrl}/api/dreams/ingest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'valid-key' },
        body: JSON.stringify({ content: 'legacy transcript content' }),
      });
      assert.equal(legacy.status, 200);
      assert.equal((await legacy.json() as Record<string, unknown>).dreamsExtracted, 0);
      assert.equal(mockAcceptCapture.mock.callCount(), 0);
    });

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
