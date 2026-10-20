import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const srcDir = resolve(import.meta.dirname, '../../src');

function mockSource(relativePath: string, exports: Record<string, unknown>): void {
  const sourcePath = resolve(srcDir, relativePath);
  const paths = new Set([sourcePath, `${sourcePath}.js`, pathToFileURL(sourcePath).href]);
  for (const suffix of ['.js', '.ts']) {
    const candidate = sourcePath.endsWith(suffix) ? sourcePath : `${sourcePath}${suffix}`;
    if (!existsSync(candidate)) continue;
    const realPath = realpathSync(candidate);
    paths.add(realPath);
    paths.add(pathToFileURL(realPath).href);
  }
  for (const specifier of paths) {
    try {
      mock.module(specifier, { defaultExport: exports, namedExports: exports });
    } catch {
      // Node versions can normalize the same module URL more than once.
    }
  }
}

const auth = { uid: 'synthetic-tenant', tier: 'enterprise', role: 'user' };
const runDailyPipeline = mock.fn(async () => ({ success: true, status: 'completed' }));

mockSource('services/authService', {
  checkAuth: async () => auth,
  logActivity: async () => undefined,
});
mockSource('services/sessionCheckpointService', { SessionCheckpointService: {} });
mockSource('services/dreamingService', { DreamingService: {} });
mockSource('services/projectService', { loadAnalysisAsync: async () => null });
mockSource('utils/context', {
  authStorage: {
    getStore: () => auth,
    run: (_context: unknown, callback: () => unknown) => callback(),
  },
});
mockSource('utils/logger', { logger: { info() {}, warn() {}, error() {}, debug() {} } });
mockSource('middleware/auth', { authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() });
mockSource('middleware/validation', { rejectArrayParams: () => (_req: unknown, _res: unknown, next: () => void) => next() });
mockSource('services/dreamPipelineService', {
  DreamPipelineService: {
    getPipelineStatus: () => ({}),
    runSessionIngestion: async () => ({}),
    reconcilePendingIngests: async () => ({}),
    runDailyPipeline,
  },
});
mockSource('services/dreamDiagnostics', { DreamDiagnostics: { snapshot: () => ({}), recordSave() {} } });
mockSource('services/dreamCaptureStore', { DreamCaptureStore: {} });
mockSource('services/memoryIngestionService', { MemoryIngestionService: {} });
mockSource('presentation/checkpointRoutes', { registerCheckpointRoutes() {} });

const { registerDreamingRoutes } = await import('../../src/presentation/dreamingRoutes.js');

test('daily scheduler route preserves display name and canonical project ID separately', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const app = {
    get: (path: string, ...callbacks: Array<(...args: unknown[]) => unknown>) => handlers.set(`GET ${path}`, callbacks.at(-1)!),
    post: (path: string, ...callbacks: Array<(...args: unknown[]) => unknown>) => handlers.set(`POST ${path}`, callbacks.at(-1)!),
    delete: (path: string, ...callbacks: Array<(...args: unknown[]) => unknown>) => handlers.set(`DELETE ${path}`, callbacks.at(-1)!),
  };
  registerDreamingRoutes(app as never);

  let statusCode = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
  };
  const handler = handlers.get('POST /api/dreams/generate-daily-dreams');
  assert.ok(handler);
  await handler({
    body: {
      tenant_id: auth.uid,
      project: 'display-project',
      project_id: 'canonical-project-id',
      run_id: 'scheduled-run',
      scheduled_for: '2026-10-20T14:00:00.000Z',
    },
  }, response);

  assert.equal(statusCode, 200);
  assert.deepEqual(responseBody, { success: true, status: 'completed' });
  assert.deepEqual(runDailyPipeline.mock.calls[0]?.arguments[0], {
    project: 'display-project',
    projectId: 'canonical-project-id',
    provider: undefined,
    runId: 'scheduled-run',
    runAt: '2026-10-20T14:00:00.000Z',
    runFence: undefined,
  });
});
