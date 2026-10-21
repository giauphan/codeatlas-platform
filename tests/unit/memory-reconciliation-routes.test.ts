import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';
const db = new SQLiteAdapter(':memory:');
const tenant = { uid: 'route-ingest-tenant', tier: 'enterprise', keyId: 'fixture' };
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => db } });
mock.module('../../src/services/embeddingService.js', { namedExports: { generateEmbedding: async () => null, generateEmbeddingsBatch: async () => [] } });
mock.module('../../src/middleware/auth.js', { namedExports: { authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.header('x-api-key') !== 'fixture-key') return res.status(401).json({ error: 'Authentication required' });
  return authStorage.run(tenant, next);
} } });
mock.module('../../src/services/authService.js', { namedExports: { checkAuth: async () => tenant, logActivity: async () => {} } });
const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { DreamDiagnostics } = await import('../../src/services/dreamDiagnostics.js');
const { DreamRunLedger, DreamScheduler } = await import('../../src/services/dreamScheduler.js');
const { registerDreamingRoutes } = await import('../../src/presentation/dreamingRoutes.js');
let server: Server | undefined;
let url: string;
before(async () => {
  await db.initialize(); await DreamingService.initialize();
  const app = express(); app.use(express.json()); registerDreamingRoutes(app);
  server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1');
    instance.once('listening', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); url = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await db.disconnect();
});
const headers = { 'Content-Type': 'application/json', 'x-api-key': 'fixture-key' };

test('normal event endpoint saves a grounded memory and distinguishes extraction from source ACK', async () => {
  const before = DreamDiagnostics.snapshot();
  const response = await fetch(`${url}/api/dreams/ingest-session`, { method: 'POST', headers, body: JSON.stringify({
    event_id: 'direct-tool', session_id: 'route-session', project: 'display', project_id: 'canonical', actor_role: 'TOOL',
    content: '[Bash]\ninput: command=npm test\noutcome: exit_code=0\nresult: resolver.ts passed 42 tests.',
  }) });
  assert.equal(response.status, 200);
  const ack = await response.json() as { source_persisted: boolean; extraction_status: string; memory_ids: string[] };
  assert.equal(ack.source_persisted, true);
  assert.equal(ack.extraction_status, 'processed');
  assert.equal(ack.memory_ids.length, 1);
  assert.equal((await db.query('SELECT source_event_id FROM dream_memory_evidence')).length, 1);
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.capture_received - before.capture_received, 1);
  assert.equal(after.capture_stored - before.capture_stored, 1);
});

test('diagnostics route is restricted to administrators', async () => {
  const response = await fetch(`${url}/api/admin/dreams/diagnostics`, { headers });
  assert.equal(response.status, 403);
  const body = await response.json() as Record<string, unknown>;
  assert.equal('counters' in body, false);
});

test('query route records empty retrievals without claiming host context injection', async () => {
  const before = DreamDiagnostics.snapshot();
  const response = await fetch(`${url}/api/dreams/query?project=display&project_id=canonical&query=not-found`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { retrieval_status: string };
  assert.equal(body.retrieval_status, 'no_match');
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.retrieval_no_match - before.retrieval_no_match, 1);
  const blankQuery = await fetch(`${url}/api/dreams/query?project=display&project_id=empty-metrics-project&query=`, { headers });
  assert.equal(blankQuery.status, 200);
  assert.equal((await blankQuery.json() as { retrieval_status: string }).retrieval_status, 'empty');
  assert.equal(DreamDiagnostics.snapshot().retrieval_empty - before.retrieval_empty, 1);
  assert.equal(after.injected, before.injected);
});

test('reconciliation endpoint processes durable pending events only in authenticated scope', async () => {
  const event = { eventId: 'queued', sessionId: 'route-session', project: 'display', projectId: 'canonical', actorRole: 'USER' as const,
    content: 'Decision: use SQLite for local development because offline operation is required.' };
  await authStorage.run(tenant, () => DreamCaptureStore.accept(event));
  await authStorage.run({ ...tenant, uid: 'other-tenant' }, () => DreamCaptureStore.accept(event));
  assert.equal((await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers, body: JSON.stringify({ tenant_id: 'other-tenant' }) })).status, 403);
  const response = await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers, body: JSON.stringify({ project_id: 'canonical' }) });
  const result = await response.json() as { success: boolean; stored: number; events_processed: number };
  assert.equal(response.status, 200); assert.equal(result.success, true); assert.equal(result.events_processed, 1); assert.equal(result.stored, 1);
  assert.equal((await authStorage.run({ ...tenant, uid: 'other-tenant' }, () => DreamCaptureStore.reconcilePending())).length, 1);
});

test('event-scoped HTTP reconciliation processes only the requested pending event', async () => {
  await authStorage.run(tenant, async () => {
    await DreamCaptureStore.accept({ eventId: 'scoped-unrelated-event', sessionId: 'other-session', project: 'display', projectId: 'canonical', actorRole: 'USER',
      content: 'Decision: keep unrelated-reconcile.ts evidence because separate work must remain pending.' });
    await DreamCaptureStore.accept({ eventId: 'scoped-target-event', sessionId: 'scoped-reconcile-session', project: 'display', projectId: 'canonical', actorRole: 'USER',
      content: 'Decision: keep scoped-reconcile.ts evidence because replay must not consume unrelated pending events.' });
  });

  const response = await fetch(`${url}/api/dreams/reconcile-pending`, {
    method: 'POST', headers, body: JSON.stringify({ project_id: 'canonical', event_id: 'scoped-target-event', limit: 1 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { success: boolean; events_processed: number; events_filtered: number; failed: number };
  assert.equal(result.success, true);
  assert.equal(result.failed, 0);
  assert.equal(result.events_processed + result.events_filtered, 1);
  const rows = await db.query<{ event_id: string; status: string }>(`SELECT event_id, status FROM dream_capture_events
    WHERE tenant_id = :tenant AND project_id = 'canonical' AND event_id IN ('scoped-target-event', 'scoped-unrelated-event') ORDER BY event_id`, { tenant: tenant.uid });
  assert.deepEqual(rows, [
    { event_id: 'scoped-target-event', status: 'processed' },
    { event_id: 'scoped-unrelated-event', status: 'pending' },
  ]);
});

test('event-scoped reconciliation rejects malformed event_id filters', async () => {
  for (const eventId of ['', ' '.repeat(2), 17, 'x'.repeat(256)]) {
    const response = await fetch(`${url}/api/dreams/reconcile-pending`, {
      method: 'POST', headers, body: JSON.stringify({ project_id: 'canonical', event_id: eventId }),
    });
    assert.equal(response.status, 400);
  }
});

test('scheduled reconciliation discovers and processes pending capture events as session backfill', async () => {
  const scheduledAt = new Date();
  await authStorage.run(tenant, () => DreamCaptureStore.accept({
    eventId: 'scheduled-backfill', sessionId: 'backfill-session', project: 'display', projectId: 'canonical', actorRole: 'USER',
    content: 'Decision: retain worker-resolver.ts events because scheduled reconciliation must recover pending sessions.',
  }));
  const scheduler = new DreamScheduler({
    ledger: new DreamRunLedger(db), ownerId: 'backfill-worker', now: () => new Date(), leaseMs: 30 * 60_000,
    executeJob: async claim => {
      const response = await fetch(`${url}/api/dreams/reconcile-pending`, {
        method: 'POST', headers,
        body: JSON.stringify({ tenant_id: tenant.uid, project_id: 'canonical', job_key: claim.jobKey, owner_token: claim.ownerToken, fencing_token: claim.fencingToken }),
      });
      return { httpStatus: response.status, body: await response.json() };
    },
  });
  const state = await scheduler.runSlot({
    jobType: 'reconciliation', tenantId: tenant.uid, project: 'canonical',
    scheduledFor: scheduledAt.toISOString(), timezone: 'UTC',
  });
  assert.equal(state, 'completed');
  assert.equal((await authStorage.run(tenant, () => DreamCaptureStore.reconcilePending())).length, 0);
  assert.equal((await db.query("SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = 'scheduled-backfill'")).length, 1);
});

test('reconciliation reports partial failures and remains retryable instead of false success', async () => {
  await authStorage.run(tenant, () => DreamCaptureStore.accept({ eventId: 'fault', sessionId: 'route-session', project: 'display', projectId: 'canonical', actorRole: 'USER',
    content: 'Decision: retain retry receipts for the event queue because transport acknowledgements can be lost.' }));
  const execute = db.execute.bind(db);
  let fail = true;
  db.execute = async (...args) => { if (fail && args[0].includes('INSERT INTO dream_memory_evidence')) { fail = false; throw new Error('simulated disk fault'); } return execute(...args); };
  const first = await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers, body: '{}' });
  const failed = await first.json() as { success: boolean; failed: number };
  assert.equal(failed.success, false); assert.equal(failed.failed, 1);
  const second = await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers, body: '{}' });
  assert.equal((await second.json() as { success: boolean }).success, true);
  assert.equal((await authStorage.run(tenant, () => DreamCaptureStore.reconcilePending())).length, 0);
});

test('Stop source ACK stays pending for model-capable reconciliation after earlier user and tool sources were processed', async () => {
  const post = (body: Record<string, unknown>) => fetch(`${url}/api/dreams/ingest-session`, { method: 'POST', headers, body: JSON.stringify(body) });
  const common = { session_id: 'checkpoint-route-session', project: 'display', project_id: 'canonical' };
  await post({ ...common, event_id: 'checkpoint-decision', actor_role: 'USER', content: 'Decision: keep checkpoint-router.ts source evidence because startup must restore the current task.' });
  await post({ ...common, event_id: 'checkpoint-tool-result', actor_role: 'TOOL', tool_name: 'Bash', content: '[Bash]\ninput: command=npm test\noutcome: exit_code=0\nresult: checkpoint-route.test.ts passed 42 tests.' });
  const priorSources = await db.query<{ event_id: string; status: string }>("SELECT event_id, status FROM dream_capture_events WHERE event_id IN ('checkpoint-decision', 'checkpoint-tool-result') ORDER BY event_id");
  assert.deepEqual(priorSources, [
    { event_id: 'checkpoint-decision', status: 'processed' },
    { event_id: 'checkpoint-tool-result', status: 'processed' },
  ]);
  const response = await post({ ...common, event_id: 'checkpoint-marker', content: 'Session checkpoint (Stop)', checkpoint: { trigger: 'Stop' } });
  const ack = await response.json() as { source_persisted: boolean; extraction_status: string; memory_ids: string[] };
  assert.equal(ack.source_persisted, true); assert.equal(ack.extraction_status, 'pending'); assert.deepEqual(ack.memory_ids, []);
  const latest = await fetch(`${url}/api/dreams/checkpoints/latest?project_id=canonical`, { headers });
  const latestBody = await latest.json() as { checkpoint?: { source_event_ids?: string[] } };
  assert.deepEqual(new Set(latestBody.checkpoint?.source_event_ids), new Set(['checkpoint-decision', 'checkpoint-tool-result', 'checkpoint-marker']));
  const pendingBefore = await db.query<{ event_id: string }>("SELECT event_id FROM dream_capture_events WHERE tenant_id = :tenant AND project_id = 'canonical' AND session_id = 'checkpoint-route-session' AND status = 'pending' ORDER BY event_id", { tenant: tenant.uid });
  assert.deepEqual(pendingBefore, [{ event_id: 'checkpoint-marker' }]);
  assert.ok((await authStorage.run(tenant, () => DreamCaptureStore.reconcilePending({ projectId: 'canonical' }))).some(event => event.eventId === 'checkpoint-marker'));
  const reconciliation = await fetch(`${url}/api/dreams/reconcile-pending`, {
    method: 'POST', headers,
    body: JSON.stringify({ project_id: 'canonical', event_id: 'checkpoint-marker', limit: 1 }),
  });
  const outcome = await reconciliation.json() as { success: boolean; events_processed: number; events_filtered: number; failed: number };
  assert.equal(outcome.success, true);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.events_processed + outcome.events_filtered, 1);
  const markerStatus = await db.query<{ status: string }>("SELECT status FROM dream_capture_events WHERE tenant_id = :tenant AND project_id = 'canonical' AND event_id = 'checkpoint-marker'", { tenant: tenant.uid });
  assert.equal(markerStatus[0]?.status === 'pending', false);
});

test('reconciliation endpoint rate-limits repeated authenticated requests', async () => {
  const statuses: number[] = [];
  for (let request = 0; request < 40; request++) {
    const response = await fetch(`${url}/api/dreams/reconcile-pending`, { method: 'POST', headers, body: '{}' });
    statuses.push(response.status);
    await response.text();
  }
  assert.ok(statuses.includes(429), `expected a rate-limited response, received: ${statuses.join(',')}`);
});
