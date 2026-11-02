import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/presentation/mcpTools.js';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { resetDatabaseAdapter, setDatabaseAdapter } from '../../src/database/factory.js';
import { DreamPipelineService } from '../../src/services/dreamPipelineService.js';
import { DreamCaptureStore } from '../../src/services/dreamCaptureStore.js';
import { SessionCheckpointService } from '../../src/services/sessionCheckpointService.js';
import { DreamingService } from '../../src/services/dreamingService.js';
import { GenomeService } from '../../src/services/genomeService.js';
import { WikiService } from '../../src/services/wikiService.js';
import { authStorage } from '../../src/utils/context.js';

type RegisteredTool = { description: string; schema: any; handler: (args: any) => Promise<any> };

describe('platform MCP memory tools', () => {
  let adapter: SQLiteAdapter;
  let tools: Map<string, RegisteredTool>;
  const tenant = { tier: 'enterprise', uid: 'memory-mcp-tenant', keyId: 'memory-mcp-key' };

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    if (adapter.initialize) await adapter.initialize();
    else {
      await adapter.connect();
      await adapter.initializeSchema();
    }
    setDatabaseAdapter(adapter);
    tools = new Map();
    const server = {
      tool: (name: string, description: string, schema: any, handler: RegisteredTool['handler']) => {
        tools.set(name, { description, schema, handler });
      },
    } as unknown as McpServer;
    registerTools(server, tenant);
  });

  afterEach(async () => {
    if (adapter.close) await adapter.close();
    else await adapter.disconnect();
    resetDatabaseAdapter();
  });

  test('legacy transcript ingestion delegates to the central pipeline and returns its real zero-save result', async (t) => {
    let received: unknown;
    const resultFromPipeline = {
      success: true,
      sessionId: 'legacy-session',
      session_id: 'legacy-session',
      project: 'legacy-project',
      provider: 'claude',
      dreamsExtracted: 0,
      noiseBlocked: 1,
      genesSaved: 0,
      wikiUpdated: false,
      dreams: [],
      startedAt: '2026-10-20T00:00:00.000Z',
      completedAt: '2026-10-20T00:00:00.001Z',
      durationMs: 1,
    };
    t.mock.method(DreamPipelineService, 'runSessionIngestion', async (options) => {
      received = options;
      return resultFromPipeline;
    });

    const result = await tools.get('ingest_session_transcript')!.handler({
      transcript: '[USER]\nI wrote a shopping list for the weekend.',
      session_id: 'legacy-session',
      project: 'legacy-project',
      provider: 'claude',
    });
    const payload = JSON.parse(result.content[0].text);

    assert.deepEqual(received, {
      content: '[USER]\nI wrote a shopping list for the weekend.',
      sessionId: 'legacy-session',
      project: 'legacy-project',
      provider: 'claude',
    });
    assert.deepEqual(payload, resultFromPipeline);
    assert.doesNotMatch(result.content[0].text, /__noise_blocked__/);
  });

  test('save_dream_memory acknowledges filtered input without a fake id or raw content in activity logs', async (t) => {
    let received: unknown;
    t.mock.method(DreamingService, 'saveDreamMemory', async () => '__noise_blocked__');
    t.mock.method(DreamingService, 'saveDreamMemoryWithAck', async (input) => {
      received = input;
      return { status: 'filtered', persisted: false, reason_code: 'noise_blocked' };
    });
    const secret = 'api_key=RAW_MCP_SECRET_SENTINEL_78291';
    const result = await tools.get('save_dream_memory')!.handler({
      memory_type: 'KNOWLEDGE', content: secret, importance: 6, session_id: 'manual-session',
      project: 'manual-project', provider: 'claude',
    });
    const payload = JSON.parse(result.content[0].text);
    const activity = await adapter.query<{ params: string }>(
      "SELECT params FROM activity_log WHERE tool = 'save_dream_memory'",
    );

    assert.deepEqual(received, {
      project: 'manual-project', sessionId: 'manual-session', memoryType: 'KNOWLEDGE',
      content: secret, importance: 6, aiModel: 'claude',
    });
    assert.equal(payload.success, true);
    assert.equal(payload.status, 'filtered');
    assert.equal(payload.persisted, false);
    assert.equal(payload.id, undefined);
    assert.equal(payload.reason_code, 'noise_blocked');
    assert.equal(activity.length, 1);
    assert.doesNotMatch(activity[0].params, /RAW_MCP_SECRET_SENTINEL_78291/);
    assert.match(activity[0].params, /content_length/);
    assert.doesNotMatch(result.content[0].text, /__noise_blocked__/);
  });

  test('save_dream_memory returns ids only for persisted stored or duplicate acknowledgements', async (t) => {
    t.mock.method(DreamingService, 'saveDreamMemory', async () => '__noise_blocked__');
    const acknowledgements = [
      { status: 'stored' as const, persisted: true, id: 'stored-memory-id' },
      { status: 'duplicate' as const, persisted: true, id: 'duplicate-memory-id' },
    ];
    let index = 0;
    t.mock.method(DreamingService, 'saveDreamMemoryWithAck', async () => acknowledgements[index++]);

    for (const expected of acknowledgements) {
      const result = await tools.get('save_dream_memory')!.handler({
        memory_type: 'PREFERENCE', content: `use ${expected.status} receipt`,
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.success, true);
      assert.equal(payload.status, expected.status);
      assert.equal(payload.persisted, true);
      assert.equal(payload.id, expected.id);
    }
  });

  test('save_dream_memory reports rejected acknowledgements as errors without ids', async (t) => {
    t.mock.method(DreamingService, 'saveDreamMemory', async () => '__noise_blocked__');
    t.mock.method(DreamingService, 'saveDreamMemoryWithAck', async () => ({
      status: 'rejected', persisted: false, id: 'must-not-leak', reason_code: 'idempotency_key_reused',
    }));
    const result = await tools.get('save_dream_memory')!.handler({
      memory_type: 'KNOWLEDGE', content: 'A rejected memory write.',
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(result.isError, true);
    assert.equal(payload.success, false);
    assert.equal(payload.status, 'rejected');
    assert.equal(payload.persisted, false);
    assert.equal(payload.id, undefined);
    assert.equal(payload.reason_code, 'idempotency_key_reused');
  });

  test('session-start context is returned to the caller and the raw task is omitted from activity logs', async (t) => {
    t.mock.method(DreamingService, 'queryDreamMemories', async () => [
      { memoryType: 'FACT', content: 'Use immutable event IDs from persisted capture.', importance: 8 },
    ]);
    t.mock.method(GenomeService, 'searchGenes', async () => []);
    t.mock.method(GenomeService, 'buildImmuneContext', async () => '');
    t.mock.method(WikiService, 'getInstance', () => ({ searchWiki: async () => ({ pages: [] }) }) as any);

    const rawTask = 'TASK_LOG_SENTINEL_29103';
    const result = await tools.get('load_context_at_session_start')!.handler({
      session_id: 'context-session', project: 'context-project', task: rawTask,
    });
    const payload = JSON.parse(result.content[0].text);
    const activity = await adapter.query<{ params: string }>(
      "SELECT params FROM activity_log WHERE tool = 'load_context_at_session_start'",
    );

    assert.match(payload.context, /Use immutable event IDs from persisted capture/);
    assert.equal(payload.hasContext, true);
    assert.equal(payload.automatic_injection, false);
    assert.equal(result._meta?.automatic_injection, false);
    assert.equal(activity.length, 1);
    assert.doesNotMatch(activity[0].params, new RegExp(rawTask));
  });

  test('context reload returns the delivery payload and does not log its raw task', async (t) => {
    t.mock.method(DreamingService, 'queryDreamMemories', async () => [
      { memoryType: 'DECISION', content: 'Keep checkpoint evidence tied to its project.', importance: 7 },
    ]);
    t.mock.method(GenomeService, 'searchGenes', async () => []);
    t.mock.method(GenomeService, 'buildImmuneContext', async () => '');
    t.mock.method(WikiService, 'getInstance', () => ({ searchWiki: async () => ({ pages: [] }) }) as any);

    const rawTask = 'RELOAD_TASK_LOG_SENTINEL_29104';
    const result = await tools.get('reload_context_mid_session')!.handler({
      session_id: 'reload-session', project: 'reload-project', task: rawTask,
    });
    const payload = JSON.parse(result.content[0].text);
    const activity = await adapter.query<{ params: string }>(
      "SELECT params FROM activity_log WHERE tool = 'reload_context_mid_session'",
    );

    assert.match(payload.context, /Keep checkpoint evidence tied to its project/);
    assert.equal(payload.delivery_status, 'unsupported');
    assert.equal(payload.automatic_injection, false);
    assert.equal(result._meta?.automatic_injection, false);
    assert.equal(activity.length, 1);
    assert.doesNotMatch(activity[0].params, new RegExp(rawTask));
  });

  test('memory bootstrap restores the latest checkpoint without a task and isolates it by tenant', async () => {
    const otherTenant = { ...tenant, uid: 'other-memory-mcp-tenant', keyId: 'other-memory-mcp-key' };
    await authStorage.run(tenant, async () => {
      await DreamCaptureStore.accept({
        eventId: 'tenant-a-decision', sessionId: 'tenant-a-session', project: 'display-project',
        projectId: 'canonical-project', actorRole: 'USER',
        content: 'Decision: keep checkpoint evidence in the canonical project scope.',
      });
      await DreamCaptureStore.accept({
        eventId: 'tenant-a-marker', sessionId: 'tenant-a-session', project: 'display-project',
        projectId: 'canonical-project', actorRole: 'TOOL', content: 'Session checkpoint (PreCompact)',
        checkpoint: { trigger: 'PreCompact' },
      });
    });
    await authStorage.run(otherTenant, async () => {
      await DreamCaptureStore.accept({
        eventId: 'tenant-b-decision', sessionId: 'tenant-b-session', project: 'display-project',
        projectId: 'canonical-project', actorRole: 'USER',
        content: 'Decision: expose another tenant private deployment credentials.',
      });
      await DreamCaptureStore.accept({
        eventId: 'tenant-b-marker', sessionId: 'tenant-b-session', project: 'display-project',
        projectId: 'canonical-project', actorRole: 'TOOL', content: 'Session checkpoint (Stop)',
        checkpoint: { trigger: 'Stop' },
      });
    });

    const tool = tools.get('memory_bootstrap')!;
    assert.equal(tool.schema.project_id.safeParse(undefined).success, false);
    for (const optionalField of ['project', 'display_name', 'session_id', 'task']) {
      assert.equal(tool.schema[optionalField].safeParse(undefined).success, true, `${optionalField} is optional`);
    }
    const result = await tool.handler({ project_id: 'canonical-project', project: 'display-project' });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.status, 'restored');
    assert.equal(payload.project_id, 'canonical-project');
    assert.equal(payload.automatic_injection, false);
    assert.equal(result._meta?.automatic_injection, false);
    assert.match(payload.context, /untrusted reference/i);
    assert.match(payload.context, /canonical project scope/);
    assert.doesNotMatch(payload.context, /another tenant private deployment/);
    assert.ok(payload.source_event_ids.includes('tenant-a-decision'));
    assert.ok(!payload.source_event_ids.includes('tenant-b-decision'));
    assert.ok(payload.context.length <= 5000);
  });

  test('memory bootstrap reports an empty project distinctly and discloses host delivery limits', async () => {
    const result = await tools.get('memory_bootstrap')!.handler({ project_id: 'empty-canonical-project' });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.status, 'empty');
    assert.equal(payload.checkpoint, null);
    assert.equal(payload.context, '');
    assert.equal(payload.delivery_status, 'unsupported');
    assert.equal(payload.automatic_injection, false);
    assert.equal(result._meta?.automatic_injection, false);
  });

  test('memory bootstrap reports storage failures as errors rather than empty checkpoints', async (t) => {
    t.mock.method(SessionCheckpointService, 'latest', async () => {
      throw new Error('checkpoint storage unavailable');
    });
    const result = await tools.get('memory_bootstrap')!.handler({ project_id: 'unavailable-project' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /checkpoint storage unavailable/);
    assert.doesNotMatch(result.content[0].text, /"status": "empty"/);
  });
});
