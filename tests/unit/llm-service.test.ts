import { test, describe, before, after, beforeEach, mock } from 'node:test';
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

const mockQueryDreamMemories = mock.fn();
const mockSaveDreamMemory = mock.fn();
const mockCheckNoiseBlocklist = mock.fn();
const mockLogger = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
};

safeMockModule(path.join(srcDir, 'services/dreamingService.js'), {
  OracleDreamingService: {
    queryDreamMemories: mockQueryDreamMemories,
    saveDreamMemory: mockSaveDreamMemory,
  },
});

safeMockModule(path.join(srcDir, 'services/noiseBlocklist.js'), {
  checkNoiseBlocklist: mockCheckNoiseBlocklist,
});

safeMockModule(path.join(srcDir, 'utils/logger.js'), {
  logger: mockLogger,
});

describe('llmService Unit Tests', () => {
  let summarizeConversationForDreams: typeof import('../../src/services/llmService.js').summarizeConversationForDreams;
  let loadContextAtSessionStart: typeof import('../../src/services/llmService.js').loadContextAtSessionStart;
  let reloadCleanedContext: typeof import('../../src/services/llmService.js').reloadCleanedContext;
  let triggerContextReload: typeof import('../../src/services/llmService.js').triggerContextReload;

  before(async () => {
    const mod = await import(path.join(srcDir, 'services/llmService.js'));
    summarizeConversationForDreams = mod.summarizeConversationForDreams;
    loadContextAtSessionStart = mod.loadContextAtSessionStart;
    reloadCleanedContext = mod.reloadCleanedContext;
    triggerContextReload = mod.triggerContextReload;
  });

  beforeEach(() => {
    mockQueryDreamMemories.mock.resetCalls();
    mockSaveDreamMemory.mock.resetCalls();
    mockCheckNoiseBlocklist.mock.resetCalls();
    mockLogger.info.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();
    mockLogger.error.mock.resetCalls();
    mockLogger.debug.mock.resetCalls();
    mockCheckNoiseBlocklist.mock.mockImplementation(() => ({ isNoise: false }));
  });

  describe('summarizeConversationForDreams', () => {
    test('extracts MISTAKE, PREFERENCE, and KNOWLEDGE dreams from valid transcript segments', async () => {
      const transcript = [
        '[USER]',
        'We encountered an error in the authentication route because the session token expired during long operations.',
        '',
        '---',
        '',
        '[ASSISTANT]',
        'I prefer to use TypeScript strict mode across all modules to prevent unhandled runtime exceptions in production code.',
        '',
        '---',
        '',
        '[USER]',
        'The database adapter uses connection pooling to handle concurrent queries safely.',
      ].join('\n');

      const dreams = await summarizeConversationForDreams(transcript, 'claude', 'test-project', 'sess-1');

      assert.ok(Array.isArray(dreams));
      assert.ok(dreams!.length >= 2);

      const types = dreams!.map((d) => d.memoryType);
      assert.ok(types.includes('MISTAKE'));
      assert.ok(types.includes('PREFERENCE'));

      const mistake = dreams!.find((d) => d.memoryType === 'MISTAKE');
      assert.ok(mistake?.content.toLowerCase().includes('error'));
    });

    test('ignores non-matching or overly short segments', async () => {
      const transcript = [
        'Invalid header without user/assistant indicator',
        'Short line',
        '',
        '---',
        '',
        '[USER]',
        'Too short text.',
      ].join('\n');

      const dreams = await summarizeConversationForDreams(transcript, 'claude', 'test-project', 'sess-2');
      assert.strictEqual(dreams?.length ?? 0, 0);
    });

    test('deduplicates identical sentences within a single transcript', async () => {
      const transcript = [
        '[USER]',
        'We encountered an error in the authentication route because the session token expired during long operations.',
        '',
        '---',
        '',
        '[ASSISTANT]',
        'We encountered an error in the authentication route because the session token expired during long operations.',
      ].join('\n');

      const dreams = await summarizeConversationForDreams(transcript, 'claude', 'test-project', 'sess-3');
      assert.strictEqual(dreams?.length, 1);
    });

    test('skips noise-blocklisted sentences', async () => {
      mockCheckNoiseBlocklist.mock.mockImplementation((text: string) => ({
        isNoise: text.includes('noise sentence'),
        reason: 'test-block',
      }));

      const transcript = [
        '[USER]',
        'This is a noise sentence that contains a bug and should be blocked completely.',
        '',
        '---',
        '',
        '[ASSISTANT]',
        'This is a valid fix for the database query error that improves response time across all endpoints.',
      ].join('\n');

      const dreams = await summarizeConversationForDreams(transcript, 'claude', 'test-project', 'sess-4');
      assert.strictEqual(dreams?.length, 1);
      assert.ok(!dreams![0].content.includes('noise sentence'));
    });
  });

  describe('loadContextAtSessionStart', () => {
    test('queries dreams for explicit project and formats output context array', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => [
        {
          ID: 'mem-1',
          MEMORY_TYPE: 'MISTAKE',
          CONTENT: 'Always check token expiry before sending auth headers to backend service',
          IMPORTANCE: 8,
          CREATED_AT: '2026-08-01',
        },
        {
          id: 'mem-2',
          memory_type: 'PREFERENCE',
          content: 'Use SQLite-first persistence for local testing',
          importance: 7,
          created_at: '2026-08-02',
        },
      ]);

      const context = await loadContextAtSessionStart('sess-10', 'my-app', 'authentication fix');

      assert.strictEqual(mockQueryDreamMemories.mock.calls.length, 1);
      const [proj, task, limit] = mockQueryDreamMemories.mock.calls[0].arguments;
      assert.strictEqual(proj, 'my-app');
      assert.strictEqual(task, 'authentication fix');
      assert.strictEqual(limit, 10);

      assert.ok(context.includes('### MISTAKE'));
      assert.ok(context.includes('### PREFERENCE'));
    });

    test('returns empty string if querying throws an error', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => {
        throw new Error('Database disconnected');
      });

      const context = await loadContextAtSessionStart('sess-11', 'my-app', 'task-err');
      assert.strictEqual(context, '');
    });
  });

  describe('reloadCleanedContext & triggerContextReload', () => {
    test('reloadCleanedContext delegates to loadContextAtSessionStart', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);
      const context = await reloadCleanedContext('sess-20', 'my-app', 'refresh');

      assert.strictEqual(context, '');
      assert.strictEqual(mockQueryDreamMemories.mock.calls.length, 1);
    });

    test('triggerContextReload logs warning and executes reload', async () => {
      mockQueryDreamMemories.mock.mockImplementation(async () => []);
      await triggerContextReload('sess-30', 'my-app', 'noise_detected');

      assert.strictEqual(mockLogger.warn.mock.calls.length, 1);
      assert.strictEqual(mockQueryDreamMemories.mock.calls.length, 1);
    });
  });
});
