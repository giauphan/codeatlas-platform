import { test, describe, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
    try {
      const resolvedPkg = import.meta.resolve(specifier);
      specs.add(resolvedPkg);
      specs.add(pathToFileURL(resolvedPkg).href);
    } catch {}
  } else {
    const rawBasePath = specifier.endsWith('.js')
      ? specifier.slice(0, -3)
      : specifier.endsWith('.ts')
        ? specifier.slice(0, -2)
        : specifier;
    specs.add(rawBasePath);
    specs.add(rawBasePath + '.js');
    specs.add(rawBasePath + '.ts');
    specs.add(pathToFileURL(rawBasePath + '.js').href);
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

const mockSaveDreamMemory = mock.fn();
const mockSummarizeConversation = mock.fn();
const mockConsolidationRun = mock.fn();
const mockExtractGene = mock.fn();

safeMockModule(path.join(srcDir, 'services/dreamingService.js'), {
  DreamingService: {
    saveDreamMemory: mockSaveDreamMemory,
  },
});

safeMockModule(path.join(srcDir, 'services/genomeService.js'), {
  GenomeService: {
    extractGene: mockExtractGene,
  },
});

safeMockModule(path.join(srcDir, 'services/llmService.js'), {
  summarizeConversationForDreams: mockSummarizeConversation,
});

safeMockModule(path.join(srcDir, 'services/consolidationEngine.js'), {
  ConsolidationEngine: class {
    run(opts: unknown) {
      return mockConsolidationRun(opts);
    }
  },
});

const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-tenant', tier: 'enterprise' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
safeMockModule(path.join(srcDir, 'utils/context.js'), { authStorage: mockAuthStore });

safeMockModule(path.join(srcDir, 'utils/logger.js'), {
  logger: {
    info: mock.fn(),
    error: mock.fn(),
    warn: mock.fn(),
  },
});

const { DreamPipelineService } = await import(path.join(srcDir, 'services/dreamPipelineService.js'));

describe('DreamPipelineService', () => {
  beforeEach(() => {
    mockSaveDreamMemory.mock.resetCalls();
    mockSummarizeConversation.mock.resetCalls();
    mockConsolidationRun.mock.resetCalls();
  });

  describe('runDailyPipeline', () => {
    test('executes daily pipeline and returns timing metrics', async () => {
      mockConsolidationRun.mock.mockImplementation(async () => ({
        id: 'job-123',
        jobType: 'dedup+extract_concepts+score+score_dreams',
        dreamsProcessed: 10,
        dreamsMerged: 2,
        conceptsCreated: 3,
        dreamsArchived: 0,
        dreamsSuperseded: 0,
        invalidEmbeddingsSkipped: 0,
        errors: [],
      }));

      const result = await DreamPipelineService.runDailyPipeline({
        project: 'test-project',
        provider: 'generic',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.project, 'test-project');
      assert.strictEqual(result.provider, 'generic');
      assert.ok(result.durationMs >= 0);
      assert.ok(result.startedAt);
      assert.ok(result.completedAt);
      assert.strictEqual(result.consolidation?.dreamsMerged, 2);
      assert.strictEqual(result.consolidation?.conceptsCreated, 3);
    });

    test('exposes pipeline status via getPipelineStatus', () => {
      const status = DreamPipelineService.getPipelineStatus();
      assert.strictEqual(typeof status.isRunning, 'boolean');
      assert.ok(status.lastRunDate !== undefined);
      assert.ok(status.lastDurationMs !== undefined);
    });
  });

  describe('runSessionIngestion', () => {
    beforeEach(() => {
      mockExtractGene.mock.resetCalls();
    });

    test('processes transcript, saves dreams, and returns duration', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Design systems scale cleanly', importance: 8 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => 'mem-101');
      mockExtractGene.mock.mockImplementation(async () => 'gene-101');

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] We refactored the pipeline into a separate service.',
        sessionId: 'sess-abc',
        project: 'codeatlas-platform',
        provider: 'claude',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, 'sess-abc');
      assert.strictEqual(result.session_id, 'sess-abc');
      assert.strictEqual(result.project, 'codeatlas-platform');
      assert.strictEqual(result.provider, 'claude');
      assert.strictEqual(result.dreamsExtracted, 1);
      assert.strictEqual(result.noiseBlocked, 0);
      assert.strictEqual(result.dreams.length, 1);
      assert.strictEqual(result.dreams[0].id, 'mem-101');
      assert.ok(result.durationMs >= 0);
    });

    test('auto-saves a genome gene for each saved dream', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'PATTERN', content: 'Repository adapters isolate SQL dialects', importance: 7 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => 'mem-201');
      mockExtractGene.mock.mockImplementation(async () => 'gene-201');

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[ASSISTANT] The repository adapter isolates SQL dialects behind one interface.',
        sessionId: 'sess-gene',
        project: 'codeatlas-platform',
        provider: 'claude',
      });

      assert.strictEqual(result.genesSaved, 1);
      assert.strictEqual(mockExtractGene.mock.callCount(), 1);
      const call = mockExtractGene.mock.calls[0].arguments[0];
      assert.strictEqual(call.sourceType, 'dream');
      assert.strictEqual(call.sourceId, 'mem-201');
      assert.strictEqual(call.project, 'codeatlas-platform');
    });

    test('auto-save failure does not fail ingestion', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Embedding cache prevents duplicate API calls', importance: 6 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => 'mem-301');
      mockExtractGene.mock.mockImplementation(async () => {
        throw new Error('embedding provider unavailable');
      });

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] We cached embeddings so repeated queries do not hit the API.',
        sessionId: 'sess-fail',
        project: 'codeatlas-platform',
        provider: 'claude',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.dreamsExtracted, 1);
      assert.strictEqual(result.genesSaved, 0);
    });

    test('skips gene auto-save for noise-blocked dreams', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'This is noise', importance: 1 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => '__noise_blocked__');
      mockExtractGene.mock.mockImplementation(async () => 'gene-never');

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] This is noise',
        sessionId: 'sess-noise',
        project: 'codeatlas-platform',
        provider: 'claude',
      });

      assert.strictEqual(result.dreamsExtracted, 0);
      assert.strictEqual(result.noiseBlocked, 1);
      assert.strictEqual(result.genesSaved, 0);
      assert.strictEqual(mockExtractGene.mock.callCount(), 0);
    });
  });

  describe('saveDreamWithMetrics', () => {
    test('saves individual dream with duration tracking', async () => {
      mockSaveDreamMemory.mock.mockImplementation(async () => 'mem-202');

      const result = await DreamPipelineService.saveDreamWithMetrics({
        memory_type: 'PREFERENCE',
        content: 'Separate pipeline logic into dedicated service file',
        importance: 8,
        project: 'codeatlas-platform',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.id, 'mem-202');
      assert.strictEqual(result.memory_type, 'PREFERENCE');
      assert.strictEqual(result.project, 'codeatlas-platform');
      assert.ok(result.durationMs >= 0);
    });
  });
});
