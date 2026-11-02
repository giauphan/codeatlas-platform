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
const mockSaveDreamMemoryWithAck = mock.fn();
const mockSummarizeConversation = mock.fn();
const mockConsolidationRun = mock.fn();
const mockExtractGene = mock.fn();
const mockUpdateProjectWiki = mock.fn();
const mockCaptureAccept = mock.fn();
const mockProcessPending = mock.fn();
const mockDatabaseQuery = mock.fn();
const acceptedCaptureEvents = new Map<string, string>();
const processedCaptureEvents = new Set<string>();
const captureStatuses: string[] = [];

safeMockModule(path.join(srcDir, 'services/dreamingService.js'), {
  DreamingService: {
    saveDreamMemory: mockSaveDreamMemory,
    saveDreamMemoryWithAck: mockSaveDreamMemoryWithAck,
  },
});

safeMockModule(path.join(srcDir, 'services/genomeService.js'), {
  GenomeService: {
    extractGene: mockExtractGene,
  },
});

safeMockModule(path.join(srcDir, 'services/wikiService.js'), {
  WikiService: class {
    static getInstance() {
      return { updateProjectWiki: mockUpdateProjectWiki };
    }
  },
});

safeMockModule(path.join(srcDir, 'services/llmService.js'), {
  summarizeConversationForDreams: mockSummarizeConversation,
});

safeMockModule(path.join(srcDir, 'services/dreamCaptureStore.js'), {
  DreamCaptureStore: { accept: mockCaptureAccept },
});

safeMockModule(path.join(srcDir, 'services/memoryIngestionService.js'), {
  MemoryIngestionService: { processPending: mockProcessPending },
});

safeMockModule(path.join(srcDir, 'database/factory.js'), {
  createDatabaseAdapter: () => ({ query: mockDatabaseQuery }),
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
    mockSaveDreamMemoryWithAck.mock.resetCalls();
    mockSummarizeConversation.mock.resetCalls();
    mockConsolidationRun.mock.resetCalls();
    mockUpdateProjectWiki.mock.resetCalls();
    mockCaptureAccept.mock.resetCalls();
    mockProcessPending.mock.resetCalls();
    mockDatabaseQuery.mock.resetCalls();
    acceptedCaptureEvents.clear();
    processedCaptureEvents.clear();
    captureStatuses.length = 0;
    mockCaptureAccept.mock.mockImplementation(async (event: Record<string, unknown>) => {
      const eventId = String(event.eventId);
      const payload = JSON.stringify([event.actorRole, event.content]);
      const prior = acceptedCaptureEvents.get(eventId);
      if (prior !== undefined) {
        if (prior !== payload) {
          captureStatuses.push('rejected');
          return { acknowledged: false, status: 'rejected', reason_code: 'event_id_reused' };
        }
        captureStatuses.push('duplicate');
        return { acknowledged: true, status: 'duplicate', event_id: eventId };
      }
      acceptedCaptureEvents.set(eventId, payload);
      captureStatuses.push('stored');
      return { acknowledged: true, status: 'stored', event_id: eventId };
    });
    mockProcessPending.mock.mockImplementation(async (options: { eventId?: string }) => {
      const eventId = options.eventId;
      if (!eventId || processedCaptureEvents.has(eventId)) {
        return { success: true, events_processed: 0, events_filtered: 0, stored: 0, duplicate: 0, failed: 0, memory_ids: [] };
      }
      processedCaptureEvents.add(eventId);
      return { success: true, events_processed: 1, events_filtered: 0, stored: 1, duplicate: 0, failed: 0, memory_ids: [`mem-${eventId}`] };
    });
    mockDatabaseQuery.mock.mockImplementation(async (_sql: string, binds: { id: string }) => [
      { id: binds.id, memory_type: 'KNOWLEDGE', content: 'A durable structured memory.' },
    ]);
    mockUpdateProjectWiki.mock.mockImplementation(async (projectName: string) => ({
      projectName,
      root: [],
      totalPages: 1,
    }));
  });

  describe('runDailyPipeline', () => {
    test('executes daily pipeline and returns timing metrics', async () => {
      mockConsolidationRun.mock.mockImplementation(async () => ({
        id: 'job-123',
        jobType: 'dedup+extract_concepts+score+score_dreams',
        status: 'completed',
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

    test('reports failure when consolidation captures step errors instead of throwing', async () => {
      mockConsolidationRun.mock.mockImplementation(async () => ({
        id: 'job-failed',
        jobType: 'dedup+extract_concepts+score+score_dreams',
        status: 'failed',
        dreamsProcessed: 10,
        dreamsMerged: 0,
        conceptsCreated: 0,
        dreamsArchived: 0,
        dreamsSuperseded: 0,
        invalidEmbeddingsSkipped: 0,
        errors: ['score: database unavailable'],
      }));

      const result = await DreamPipelineService.runDailyPipeline({ project: 'test-project' });
      assert.equal(result.success, false);
      assert.match(result.error || '', /consolidation operations failed/);
    });

    test('forwards scheduler run identity and UTC schedule instant to consolidation', async () => {
      mockConsolidationRun.mock.mockImplementation(async (job: unknown) => ({
        id: 'run-123', status: 'completed', errors: [],
        forwarded: job,
      }));

      await DreamPipelineService.runDailyPipeline({
        project: 'test-project',
        projectId: 'canonical-project-id',
        runId: 'run-123',
        runAt: '2026-10-19T09:00:00.000Z',
        runFence: { jobKey: 'a'.repeat(64), ownerToken: 'fence-token', fencingToken: 3 },
      });

      const job = mockConsolidationRun.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
      assert.equal(job.runId, 'run-123');
      assert.equal(job.runAt, '2026-10-19T09:00:00.000Z');
      assert.equal(job.projectId, 'canonical-project-id');
      assert.deepEqual(job.runFence, { jobKey: 'a'.repeat(64), ownerToken: 'fence-token', fencingToken: 3 });
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

    test('legacy transcript capture deduplicates exact replay and rolling-window overlap', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Structured candidate', importance: 8, evidence: [{ sourceEventId: 'candidate', span: 'Structured candidate' }] },
      ]);
      const transcript = (...segments: Array<[string, string]>) => segments
        .map(([role, content]) => `[${role}]\n${content}`)
        .join('\n\n---\n\n');
      const firstWindow = transcript(
        ['USER', 'We selected SQLite for durable local storage.'],
        ['ASSISTANT', 'The capture queue retries events until acknowledged.'],
      );

      await DreamPipelineService.runSessionIngestion({ content: firstWindow, sessionId: 'sess-rolling', project: 'project-one' });
      await DreamPipelineService.runSessionIngestion({ content: firstWindow, sessionId: 'sess-rolling', project: 'project-one' });
      await DreamPipelineService.runSessionIngestion({
        content: transcript(
          ['ASSISTANT', 'The capture queue retries events until acknowledged.'],
          ['TOOL', 'The retry command completed successfully.'],
        ),
        sessionId: 'sess-rolling',
        project: 'project-one',
      });

      const accepts = mockCaptureAccept.mock.calls.map(call => call.arguments[0] as { eventId: string; actorRole: string; content: string });
      assert.deepEqual(captureStatuses, ['stored', 'stored', 'duplicate', 'duplicate', 'duplicate', 'stored']);
      assert.deepEqual(accepts.slice(0, 2).map(({ eventId }) => eventId), accepts.slice(2, 4).map(({ eventId }) => eventId));
      assert.equal(accepts[4].eventId, accepts[1].eventId);
      assert.notEqual(accepts[4].eventId, accepts[5].eventId);
      assert.equal(new Set(accepts.map(({ eventId }) => eventId)).size, 3);
    });

    test('legacy transcript reconciliation isolates pending failures and memory IDs by source event', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Structured candidate', importance: 8, evidence: [{ sourceEventId: 'candidate', span: 'Structured candidate' }] },
      ]);
      mockProcessPending.mock.mockImplementation(async (options: { projectId?: string; eventId?: string; limit?: number }) => {
        if (!options.eventId) {
          return { success: false, events_processed: 0, events_filtered: 0, stored: 0, duplicate: 0, failed: 1, memory_ids: ['unrelated-memory'] };
        }
        return { success: true, events_processed: 1, events_filtered: 0, stored: 1, duplicate: 0, failed: 0, memory_ids: [`mem-${options.eventId}`] };
      });

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER]\nThe cache keeps repeated lookups local.\n\n---\n\n[ASSISTANT]\nThe new retry policy preserves the source event ID.',
        sessionId: 'sess-isolated',
        project: 'project-one',
      });

      const capturedIds = mockCaptureAccept.mock.calls.map(call => (call.arguments[0] as { eventId: string }).eventId);
      assert.equal(result.success, true);
      assert.deepEqual(mockProcessPending.mock.calls.map(call => call.arguments[0]), capturedIds.map(eventId => ({ projectId: 'project-one', eventId, limit: 1 })));
      assert.deepEqual(result.dreams.map(dream => dream.id), capturedIds.map(eventId => `mem-${eventId}`));
      assert.equal(result.dreams.some(dream => dream.id === 'unrelated-memory'), false);
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

    test('auto-updates existing project Wiki once with all saved dreams', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Wiki search uses deterministic scoring', importance: 7 },
        { memoryType: 'PATTERN', content: 'Session context includes project Wiki excerpts', importance: 8 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async (_project, _session, memoryType) => `mem-${memoryType}`);
      mockExtractGene.mock.mockImplementation(async () => 'gene');

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] Document the Wiki integration changes.',
        sessionId: 'sess-wiki-update',
        project: 'codeatlas-platform',
        provider: 'template',
      });

      assert.strictEqual(result.wikiUpdated, true);
      assert.strictEqual(mockUpdateProjectWiki.mock.callCount(), 1);
      const [project, context, options] = mockUpdateProjectWiki.mock.calls[0].arguments;
      assert.strictEqual(project, 'codeatlas-platform');
      assert.match(context, /\[KNOWLEDGE\] Wiki search uses deterministic scoring/);
      assert.match(context, /\[PATTERN\] Session context includes project Wiki excerpts/);
      assert.deepStrictEqual(options, { tenantId: 'test-tenant', provider: 'template' });
    });

    test('Wiki auto-update failure does not fail ingestion', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'Wiki updates after session ingestion', importance: 7 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => 'mem-wiki-fail');
      mockExtractGene.mock.mockImplementation(async () => 'gene-wiki-fail');
      mockUpdateProjectWiki.mock.mockImplementation(async () => {
        throw new Error('Wiki provider unavailable');
      });

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] Update project documentation.',
        sessionId: 'sess-wiki-fail',
        project: 'codeatlas-platform',
        provider: 'template',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.dreamsExtracted, 1);
      assert.strictEqual(result.wikiUpdated, false);
    });

    test('does not auto-update Wiki for noise-blocked dreams', async () => {
      mockSummarizeConversation.mock.mockImplementation(async () => [
        { memoryType: 'KNOWLEDGE', content: 'This is noise', importance: 1 },
      ]);
      mockSaveDreamMemory.mock.mockImplementation(async () => '__noise_blocked__');
      mockExtractGene.mock.mockImplementation(async () => 'gene-never');

      const result = await DreamPipelineService.runSessionIngestion({
        content: '[USER] This is noise',
        sessionId: 'sess-wiki-noise',
        project: 'codeatlas-platform',
        provider: 'template',
      });

      assert.strictEqual(result.wikiUpdated, false);
      assert.strictEqual(mockUpdateProjectWiki.mock.callCount(), 0);
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
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'stored', persisted: true, id: 'mem-202' }));

      const result = await DreamPipelineService.saveDreamWithMetrics({
        memory_type: 'PREFERENCE',
        content: 'Separate pipeline logic into dedicated service file',
        importance: 8,
        project: 'codeatlas-platform',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.id, 'mem-202');
      assert.strictEqual(result.status, 'stored');
      assert.strictEqual(result.persisted, true);
      assert.strictEqual(result.memory_type, 'PREFERENCE');
      assert.strictEqual(result.project, 'codeatlas-platform');
      assert.ok(result.durationMs >= 0);
    });

    test('reports noise filtering as successful without inventing a memory id', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'filtered', persisted: false, reason_code: 'noise_blocked' }));

      const result = await DreamPipelineService.saveDreamWithMetrics({
        memory_type: 'KNOWLEDGE',
        content: 'English lesson note',
        project: 'codeatlas-platform',
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'filtered');
      assert.strictEqual(result.persisted, false);
      assert.strictEqual(result.id, undefined);
      assert.strictEqual(result.reason_code, 'noise_blocked');
      assert.ok(result.durationMs >= 0);
    });

    test('reports persistence errors without a fabricated id or successful save claim', async () => {
      mockSaveDreamMemoryWithAck.mock.mockImplementation(async () => ({ status: 'error', persisted: false, reason_code: 'save_failed' }));

      const result = await DreamPipelineService.saveDreamWithMetrics({
        memory_type: 'KNOWLEDGE',
        content: 'Persist a source-grounded fact.',
        project: 'codeatlas-platform',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.persisted, false);
      assert.strictEqual(result.id, undefined);
      assert.strictEqual(result.reason_code, 'save_failed');
      assert.ok(result.durationMs >= 0);
    });
  });
});
