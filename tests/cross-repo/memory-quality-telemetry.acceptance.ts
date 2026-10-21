/**
 * Opt-in synthetic quality telemetry baseline for the memory pipeline.
 *
 * Run in an isolated HOME with:
 *   node scripts/run-tests-isolated.mjs tests/cross-repo/memory-quality-telemetry.acceptance.ts
 *
 * Uses real capture, SQLite persistence, deterministic extraction, retrieval,
 * checkpoint restoration, and startup-context services. Embeddings are
 * intentionally unavailable so retrieval exercises the lexical fallback.
 * Reported context size is a UTF-8 byte proxy, not a provider/host token count.
 */
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module('../../src/services/embeddingService.js', {
  namedExports: { generateEmbedding: async () => null, generateEmbeddingsBatch: async () => [] },
});

const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { MemoryIngestionService } = await import('../../src/services/memoryIngestionService.js');
const { SessionCheckpointService } = await import('../../src/services/sessionCheckpointService.js');
const { loadContextAtSessionStart } = await import('../../src/services/llmService.js');

const tenant = { uid: 'synthetic-quality-telemetry-tenant', tier: 'enterprise', keyId: 'synthetic-test-key' };
type TelemetryProject = { id: string; display: string };
const projectA: TelemetryProject = { id: 'synthetic-nebula-project', display: 'nebula-display' };
const projectB: TelemetryProject = { id: 'synthetic-orbit-project', display: 'orbit-display' };

type Capture = {
  eventId: string;
  sessionId: string;
  project: TelemetryProject;
  actorRole: 'USER' | 'TOOL';
  content: string;
  checkpoint?: { kind: 'SESSION_CHECKPOINT'; trigger: 'Stop' };
};

const checkpointMarker = (eventId: string, sessionId: string, project: TelemetryProject): Capture => ({
  eventId,
  sessionId,
  project,
  actorRole: 'USER',
  content: 'Session checkpoint (Stop)',
  checkpoint: { kind: 'SESSION_CHECKPOINT', trigger: 'Stop' },
});

async function countRows(table: string, tenantId: string): Promise<number> {
  const rows = await adapter.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = :tenantId`, { tenantId });
  return Number(rows[0]?.count ?? 0);
}

test('synthetic memory telemetry measures capture, dedup, ranking, checkpoints, and bootstrap with denominators', async () => {
  adapter = new SQLiteAdapter(':memory:');
  const priorProcessing = process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
  process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = 'true';

  const repeatedDecision = 'Decision: Keep the Nebula catalog in packages/nebula/catalog.ts so release metadata stays stable across sessions.';
  const preference = 'I prefer concise release notes before the detailed package changelog.';
  const toolOutcomeA = '12 tests passed for packages/nebula/catalog.test.ts; exit_code=0.';
  const nextAction = 'Next, add a contract test for Nebula alias collisions before changing the resolver.';
  const toolOutcomeB = 'The resolver suite completed with 8 tests passed and exit_code=0.';
  const otherProjectDecision = 'Decision: Keep the Orbit manifest in services/orbit/manifest.ts to preserve its isolated deployment boundary.';
  const otherProjectTool = '5 tests passed for services/orbit/manifest.test.ts; exit_code=0.';

  const captures: Capture[] = [
    { eventId: 'telemetry-a-decision', sessionId: 'telemetry-session-a', project: projectA, actorRole: 'USER', content: repeatedDecision },
    { eventId: 'telemetry-a-preference', sessionId: 'telemetry-session-a', project: projectA, actorRole: 'USER', content: preference },
    { eventId: 'telemetry-a-tool', sessionId: 'telemetry-session-a', project: projectA, actorRole: 'TOOL', content: toolOutcomeA },
    checkpointMarker('telemetry-a-stop', 'telemetry-session-a', projectA),
    { eventId: 'telemetry-b-decision-repeat', sessionId: 'telemetry-session-b', project: projectA, actorRole: 'USER', content: repeatedDecision },
    { eventId: 'telemetry-b-next', sessionId: 'telemetry-session-b', project: projectA, actorRole: 'USER', content: nextAction },
    { eventId: 'telemetry-b-tool', sessionId: 'telemetry-session-b', project: projectA, actorRole: 'TOOL', content: toolOutcomeB },
    checkpointMarker('telemetry-b-stop', 'telemetry-session-b', projectA),
    { eventId: 'telemetry-c-decision', sessionId: 'telemetry-session-c', project: projectB, actorRole: 'USER', content: otherProjectDecision },
    { eventId: 'telemetry-c-tool', sessionId: 'telemetry-session-c', project: projectB, actorRole: 'TOOL', content: otherProjectTool },
    checkpointMarker('telemetry-c-stop', 'telemetry-session-c', projectB),
  ];

  try {
    await adapter.initialize();
    await DreamingService.initialize();

    const firstSession = captures.slice(0, 4);
    const secondSession = captures.slice(4, 8);
    const thirdSession = captures.slice(8);
    const persistedCaptures: Capture[] = [];
    const capture = async (item: Capture) => {
      const ack = await DreamCaptureStore.accept({
        eventId: item.eventId,
        sessionId: item.sessionId,
        project: item.project.display,
        projectId: item.project.id,
        actorRole: item.actorRole,
        content: item.content,
        ...(item.checkpoint ? { checkpoint: item.checkpoint } : {}),
      });
      assert.equal(ack.status, 'stored');
      assert.equal(ack.source_persisted, true);
      persistedCaptures.push(item);
    };

    const ingestSession = async (items: Capture[], project: TelemetryProject) => {
      const result = await authStorage.run(tenant, async () => {
        for (const item of items) await capture(item);
        return MemoryIngestionService.processPending({ projectId: project.id });
      });
      assert.equal(result.success, true, 'synthetic source events must reconcile successfully');
      assert.equal(result.failed, 0);
      return result;
    };

    const sessionAResult = await ingestSession(firstSession, projectA);
    const sessionACheckpoint = await authStorage.run(tenant, () => SessionCheckpointService.latest(projectA.id));
    assert.ok(sessionACheckpoint);
    assert.ok(sessionACheckpoint.decisions.some(value => value === repeatedDecision));
    assert.ok(sessionACheckpoint.completed.some(value => value === toolOutcomeA));
    assert.ok(sessionACheckpoint.source_event_ids.includes('telemetry-a-decision'));

    const sessionBResult = await ingestSession(secondSession, projectA);
    const sessionBCheckpoint = await authStorage.run(tenant, () => SessionCheckpointService.latest(projectA.id));
    assert.ok(sessionBCheckpoint);
    assert.ok(sessionBCheckpoint.decisions.some(value => value === repeatedDecision));
    assert.ok(sessionBCheckpoint.completed.some(value => value === toolOutcomeB));
    assert.ok(sessionBCheckpoint.next_actions.some(value => value === nextAction));
    assert.ok(sessionBCheckpoint.source_event_ids.includes('telemetry-b-next'));

    const projectBResult = await ingestSession(thirdSession, projectB);
    const projectBCheckpoint = await authStorage.run(tenant, () => SessionCheckpointService.latest(projectB.id));
    assert.ok(projectBCheckpoint);
    assert.ok(projectBCheckpoint.decisions.some(value => value === otherProjectDecision));
    assert.ok(projectBCheckpoint.completed.some(value => value === otherProjectTool));
    assert.ok(projectBCheckpoint.source_event_ids.includes('telemetry-c-decision'));

    const memoryRows = await adapter.query<{ id: string; content: string; project_id: string }>(
      `SELECT id, content, project_id FROM ai_dreaming_memory WHERE tenant_id = :tenantId ORDER BY project_id, id`,
      { tenantId: tenant.uid },
    );
    const findMemoryId = (content: string, projectId: string) => {
      const row = memoryRows.find(item => item.content === content && item.project_id === projectId);
      assert.ok(row, 'expected source-grounded memory was not persisted');
      return String(row.id);
    };
    const decisionId = findMemoryId(repeatedDecision, projectA.id);
    const preferenceId = findMemoryId(preference, projectA.id);
    const nextActionId = findMemoryId(nextAction, projectA.id);
    findMemoryId(otherProjectDecision, projectB.id);
    const projectAMemoryIds = new Set(memoryRows.filter(row => row.project_id === projectA.id).map(row => String(row.id)));
    const projectBMemoryIds = new Set(memoryRows.filter(row => row.project_id === projectB.id).map(row => String(row.id)));

    const repeatedDecisionEvidence = await adapter.query<{ source_event_id: string }>(
      `SELECT source_event_id FROM dream_memory_evidence WHERE tenant_id = :tenantId AND project_id = :projectId AND memory_id = :memoryId ORDER BY source_event_id`,
      { tenantId: tenant.uid, projectId: projectA.id, memoryId: decisionId },
    );
    assert.deepEqual(repeatedDecisionEvidence.map(row => row.source_event_id), ['telemetry-a-decision', 'telemetry-b-decision-repeat']);

    const retrievalQueries = [
      { query: 'Nebula catalog release metadata', expectedId: decisionId },
      { query: 'packages/nebula/catalog.ts', expectedId: decisionId },
      { query: 'concise release notes', expectedId: preferenceId },
      { query: 'contract test Nebula alias collisions', expectedId: nextActionId },
    ];
    const reciprocalRanks: number[] = [];
    let projectLeakCount = 0;
    for (const search of retrievalQueries) {
      const result = await authStorage.run(tenant, () => DreamingService.queryDreamMemoriesWithStatus(
        projectA.display, search.query, 20, 0, undefined, undefined, undefined, undefined, undefined, undefined, projectA.id,
      ));
      const ids = result.memories.map(memory => String((memory as Record<string, unknown>).id ?? (memory as Record<string, unknown>).ID));
      const rank = ids.indexOf(search.expectedId);
      reciprocalRanks.push(rank < 0 ? 0 : 1 / (rank + 1));
      projectLeakCount += ids.filter(id => projectBMemoryIds.has(id) || !projectAMemoryIds.has(id)).length;
    }
    assert.equal(projectLeakCount, 0, 'every retrieved ID must belong to the requested synthetic project');
    assert.ok(reciprocalRanks.every(rank => rank > 0), 'each synthetic exact/path query must retrieve its expected memory');

    const bootstrapContexts = await Promise.all([
      authStorage.run(tenant, () => loadContextAtSessionStart('synthetic-new-session-a', projectA.display, '')),
      authStorage.run(tenant, () => loadContextAtSessionStart('synthetic-new-session-b', projectB.display, '')),
    ]);
    const bootstrapChecks = [
      bootstrapContexts[0].includes(repeatedDecision) && bootstrapContexts[0].includes(nextAction),
      bootstrapContexts[1].includes(otherProjectDecision),
    ];
    assert.ok(bootstrapChecks.every(Boolean), 'each synthetic project must restore its expected context in a fresh session');

    const captureRowsBeforeReplay = await countRows('dream_capture_events', tenant.uid);
    const memoryRowsBeforeReplay = await countRows('ai_dreaming_memory', tenant.uid);
    const duplicateRowsBeforeReplay = await adapter.query<{ count: number }>(
      `SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS count FROM (
         SELECT COUNT(*) AS row_count FROM ai_dreaming_memory
         WHERE tenant_id = :tenantId
         GROUP BY project_id, memory_type, content_hash
         HAVING COUNT(*) > 1
       ) grouped`,
      { tenantId: tenant.uid },
    );
    const idsByEventBeforeReplay = new Map<string, string[]>();
    for (const event of persistedCaptures) {
      const rows = await adapter.query<{ memory_ids_json: string }>(
        `SELECT memory_ids_json FROM dream_capture_events WHERE tenant_id = :tenantId AND project_id = :projectId AND event_id = :eventId`,
        { tenantId: tenant.uid, projectId: event.project.id, eventId: event.eventId },
      );
      assert.equal(rows.length, 1);
      idsByEventBeforeReplay.set(event.eventId, JSON.parse(rows[0].memory_ids_json || '[]') as string[]);
    }
    const replayAcks = await authStorage.run(tenant, async () => Promise.all(persistedCaptures.map(event => DreamCaptureStore.accept({
      eventId: event.eventId,
      sessionId: event.sessionId,
      project: event.project.display,
      projectId: event.project.id,
      actorRole: event.actorRole,
      content: event.content,
      ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
    }))));
    assert.ok(replayAcks.every(ack => (ack.status === 'duplicate' || ack.status === 'filtered') && ack.source_persisted === true));
    for (const ack of replayAcks) assert.deepEqual(ack.memory_ids, idsByEventBeforeReplay.get(ack.event_id));
    const replayResult = await authStorage.run(tenant, () => MemoryIngestionService.processPending());
    assert.equal(replayResult.events_processed, 0);
    assert.equal(replayResult.failed, 0);
    assert.equal(await countRows('dream_capture_events', tenant.uid), captureRowsBeforeReplay);
    assert.equal(await countRows('ai_dreaming_memory', tenant.uid), memoryRowsBeforeReplay);
    const duplicateRowsAfterReplay = await adapter.query<{ count: number }>(
      `SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS count FROM (
         SELECT COUNT(*) AS row_count FROM ai_dreaming_memory
         WHERE tenant_id = :tenantId
         GROUP BY project_id, memory_type, content_hash
         HAVING COUNT(*) > 1
       ) grouped`,
      { tenantId: tenant.uid },
    );

    const sourceEvidenceRows = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM dream_memory_evidence WHERE tenant_id = :tenantId`,
      { tenantId: tenant.uid },
    );
    const groundingRows = await adapter.query<{ total: number; grounded: number }>(
      `SELECT COUNT(*) AS total,
          SUM(CASE WHEN evidence.span = source.content_redacted AND evidence.actor_role = source.actor_role THEN 1 ELSE 0 END) AS grounded
       FROM dream_memory_evidence evidence
       JOIN dream_capture_events source ON source.tenant_id = evidence.tenant_id AND source.project_id = evidence.project_id AND source.event_id = evidence.source_event_id
       WHERE evidence.tenant_id = :tenantId`,
      { tenantId: tenant.uid },
    );
    const persistedCaptureRows = captureRowsBeforeReplay;
    const captureDenominator = captures.length;
    const durableCaptureRate = persistedCaptureRows / captureDenominator;
    const memoryAckCount = sessionAResult.stored + sessionAResult.duplicate + sessionBResult.stored + sessionBResult.duplicate + projectBResult.stored + projectBResult.duplicate;
    const duplicateMemoryAcks = sessionAResult.duplicate + sessionBResult.duplicate + projectBResult.duplicate;
    const dedupHitRate = memoryAckCount ? duplicateMemoryAcks / memoryAckCount : 0;
    const persistedDuplicateMemoryRows = Number(duplicateRowsBeforeReplay[0]?.count ?? 0);
    const expectedCheckpointComponents = 7;
    const observedCheckpointComponents = [
      Boolean(sessionACheckpoint.decisions.length), Boolean(sessionACheckpoint.completed.length),
      Boolean(sessionBCheckpoint.decisions.length), Boolean(sessionBCheckpoint.completed.length), Boolean(sessionBCheckpoint.next_actions.length),
      Boolean(projectBCheckpoint.decisions.length), Boolean(projectBCheckpoint.completed.length),
    ].filter(Boolean).length;
    const checkpointCompleteness = observedCheckpointComponents / expectedCheckpointComponents;
    const reciprocalRankMean = reciprocalRanks.reduce((sum, value) => sum + value, 0) / reciprocalRanks.length;
    const retrievalHitAtK = reciprocalRanks.filter(rank => rank > 0).length / reciprocalRanks.length;
    const sourceGroundingRate = Number(groundingRows[0]?.grounded ?? 0) / Number(groundingRows[0]?.total ?? 0);
    const bootstrapHitRate = bootstrapChecks.filter(Boolean).length / bootstrapChecks.length;
    const contextBytes = bootstrapContexts.reduce((sum, context) => sum + Buffer.byteLength(context, 'utf8'), 0);

    assert.equal(captureDenominator, 11);
    assert.equal(persistedCaptureRows, captureDenominator);
    assert.equal(durableCaptureRate, 1);
    assert.ok(memoryAckCount > 0, 'the synthetic corpus must produce at least one persisted memory acknowledgement');
    assert.ok(duplicateMemoryAcks > 0, 'repeated source-supported content should reuse one memory record');
    assert.equal(checkpointCompleteness, 1);
    assert.ok(reciprocalRankMean > 0);
    assert.equal(bootstrapHitRate, 1);
    assert.equal(sourceGroundingRate, 1);
    assert.equal(persistedDuplicateMemoryRows, 0, 'same-project/type/content duplicates must not persist as multiple memory rows');
    assert.equal(Number(duplicateRowsAfterReplay[0]?.count ?? 0), persistedDuplicateMemoryRows);
    assert.ok(Number(sourceEvidenceRows[0]?.count) >= memoryAckCount - duplicateMemoryAcks);

    // Only aggregate counts and synthetic measurements are emitted. UTF-8
    // bytes are a context-size proxy, never an actual token count or limit.
    console.log(JSON.stringify({
      profile: 'synthetic-local-sqlite-lexical-fallback',
      durableCapture: { persisted: persistedCaptureRows, attempted: captureDenominator, rate: durableCaptureRate },
      memoryDeduplication: { successfulDedupAcks: duplicateMemoryAcks, acknowledgements: memoryAckCount, dedupHitRate, persistedDuplicateRows: persistedDuplicateMemoryRows, rowsAfterReplay: memoryRowsBeforeReplay },
      retrieval: { queries: reciprocalRanks.length, meanReciprocalRank: reciprocalRankMean, hitAtK: retrievalHitAtK, k: 20, crossProjectLeaks: projectLeakCount },
      grounding: { groundedEvidence: Number(groundingRows[0]?.grounded ?? 0), totalEvidence: Number(groundingRows[0]?.total ?? 0), rate: sourceGroundingRate },
      checkpoints: { completeComponents: observedCheckpointComponents, expectedComponents: expectedCheckpointComponents, completeness: checkpointCompleteness, restored: 3, attempts: 3 },
      bootstrap: { hits: bootstrapChecks.filter(Boolean).length, attempts: bootstrapChecks.length, hitRate: bootstrapHitRate },
      contextSize: { contextSizeProxyBytes: contextBytes, actualTokenCountMeasured: false },
      replay: { duplicateCaptureAcks: replayAcks.length, newCaptureRows: 0, newMemoryRows: 0 },
    }));
  } finally {
    if (priorProcessing === undefined) delete process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED;
    else process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED = priorProcessing;
    await adapter.disconnect();
  }
});

after(() => mock.restoreAll());
