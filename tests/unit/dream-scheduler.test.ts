import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { DreamRunLedger, DreamScheduler, latestDueCronSlot } from '../../src/services/dreamScheduler.js';
import { DreamDiagnostics } from '../../src/services/dreamDiagnostics.js';

const opened: SQLiteAdapter[] = [];
const tempDirs: string[] = [];

async function openLedger(path?: string): Promise<{ adapter: SQLiteAdapter; ledger: DreamRunLedger; path: string }> {
  const dir = path ? undefined : await mkdtemp(join(tmpdir(), 'codeatlas-dream-scheduler-'));
  if (dir) tempDirs.push(dir);
  const dbPath = path ?? join(dir!, 'scheduler.sqlite');
  const adapter = new SQLiteAdapter(dbPath);
  opened.push(adapter);
  await adapter.initialize();
  return { adapter, ledger: new DreamRunLedger(adapter), path: dbPath };
}

const slot = '2026-10-19T09:00:00.000Z';
const baseClaim = {
  jobType: 'consolidation' as const,
  tenantId: 'tenant-a',
  project: 'project-a',
  scheduledFor: slot,
  timezone: 'Asia/Jakarta',
  now: '2026-10-19T09:00:01.000Z',
  leaseMs: 30_000,
  maxAttempts: 3,
};

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

test('admin scheduling discovers pending tenant scopes while ordinary credentials stay isolated', async () => {
  const { adapter, ledger } = await openLedger();
  await adapter.execute(`INSERT INTO dream_capture_events (tenant_id, project_id, project, event_id, session_id, request_hash, content_redacted)
    VALUES ('tenant-b','p','p','event','session','hash','Decision: preserve pending work')`);
  await adapter.execute(`INSERT INTO ai_dreaming_memory (id, tenant_id, project, content) VALUES ('memory','tenant-c','p','A prior durable memory')`);
  assert.deepEqual(await ledger.tenantScopes({ uid: 'admin', tier: 'admin' }), ['admin', 'tenant-b', 'tenant-c']);
  assert.deepEqual(await ledger.tenantScopes({ uid: 'tenant-role-admin', tier: 'enterprise', role: 'admin' }), ['tenant-b', 'tenant-c', 'tenant-role-admin']);
  assert.deepEqual(await ledger.tenantScopes({ uid: 'tenant-b', tier: 'enterprise' }), ['tenant-b']);
  assert.deepEqual(await ledger.tenantScopes({ uid: 'tenant-role-user', tier: 'enterprise', role: 'user' }), ['tenant-role-user']);
});

test('an explicitly selected tenant bypasses admin tenant discovery', async () => {
  const { adapter, ledger } = await openLedger();
  await adapter.execute(`INSERT INTO dream_capture_events (tenant_id, project_id, project, event_id, session_id, request_hash, content_redacted)
    VALUES ('other-tenant','p','p','event','session','hash','Decision: preserve pending work')`);
  assert.deepEqual(
    await ledger.tenantScopes({ uid: 'admin', tier: 'admin' }, 'canary-tenant'),
    ['canary-tenant'],
  );
});

test('only one of two SQLite-backed scheduler instances claims the same tenant/project UTC slot', async () => {
  const first = await openLedger();
  const second = await openLedger(first.path);

  const claims = await Promise.all([
    first.ledger.claimRun({ ...baseClaim, ownerId: 'worker-a' }),
    second.ledger.claimRun({ ...baseClaim, ownerId: 'worker-b' }),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
});

test('expired leases can be reclaimed, but the previous owner is fenced from completion', async () => {
  const { ledger } = await openLedger();
  const first = await ledger.claimRun({ ...baseClaim, ownerId: 'worker-a' });
  assert.ok(first);

  const second = await ledger.claimRun({
    ...baseClaim,
    ownerId: 'worker-b',
    now: '2026-10-19T09:00:32.000Z',
  });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.ownerToken, first.ownerToken);

  assert.equal(await ledger.completeRun(first, { success: true }, '2026-10-19T09:00:33.000Z'), false);
  assert.equal(await ledger.completeRun(second, { success: true, counts: { processed: 4 } }, '2026-10-19T09:00:34.000Z'), true);
  assert.equal(await ledger.claimRun({ ...baseClaim, ownerId: 'worker-c', now: '2026-10-19T09:01:00.000Z' }), null);
});

test('retryable failures respect persisted backoff and stop after the attempt limit', async () => {
  const { ledger } = await openLedger();
  const first = await ledger.claimRun({ ...baseClaim, maxAttempts: 2, ownerId: 'worker-a' });
  assert.ok(first);
  assert.equal(await ledger.failRun(first, 'upstream unavailable', '2026-10-19T09:00:02.000Z', '2026-10-19T09:00:12.000Z'), true);

  assert.equal(await ledger.claimRun({ ...baseClaim, maxAttempts: 2, ownerId: 'worker-b', now: '2026-10-19T09:00:11.000Z' }), null);
  const second = await ledger.claimRun({ ...baseClaim, maxAttempts: 2, ownerId: 'worker-b', now: '2026-10-19T09:00:12.000Z' });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.equal(await ledger.failRun(second, 'still unavailable', '2026-10-19T09:00:13.000Z', '2026-10-19T09:00:23.000Z'), true);
  assert.equal(await ledger.claimRun({ ...baseClaim, maxAttempts: 2, ownerId: 'worker-c', now: '2026-10-19T09:00:23.000Z' }), null);
});

test('completed audit rows survive adapter restart and distinct tenant/project scopes do not collide', async () => {
  const first = await openLedger();
  const claim = await first.ledger.claimRun({ ...baseClaim, ownerId: 'worker-a' });
  assert.ok(claim);
  assert.equal(await first.ledger.completeRun(claim, { success: true, counts: { processed: 2 } }, '2026-10-19T09:00:20.000Z'), true);
  await first.adapter.close();

  const reopened = await openLedger(first.path);
  assert.equal(await reopened.ledger.getRun(claim.jobKey).then((row) => row?.state), 'completed');
  assert.ok(await reopened.ledger.claimRun({ ...baseClaim, ownerId: 'worker-b' }) === null);
  assert.ok(await reopened.ledger.claimRun({ ...baseClaim, tenantId: 'tenant-b', ownerId: 'worker-b' }));
  assert.ok(await reopened.ledger.claimRun({ ...baseClaim, project: 'project-b', ownerId: 'worker-c' }));
});

test('lease heartbeat extends only the current unexpired owner lease', async () => {
  const { ledger } = await openLedger();
  const claim = await ledger.claimRun({ ...baseClaim, ownerId: 'worker-a' });
  assert.ok(claim);
  assert.equal(await ledger.heartbeat(claim, '2026-10-19T09:00:20.000Z', 30_000), true);
  assert.equal(await ledger.heartbeat(claim, '2026-10-19T09:00:51.000Z', 30_000), false);
});

test('HTTP 200 with application success=false remains retryable and never completes the run', async () => {
  const { adapter, ledger } = await openLedger();
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 200, body: { success: false, error: 'step failed', pending: 5 } }),
  });

  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'retryable');
  const rows = await adapter.query<{ job_key: string }>('SELECT job_key FROM dream_job_runs');
  const run = await ledger.getRun(rows[0].job_key);
  assert.equal(run?.state, 'retryable');
  assert.match(run?.errorReason || '', /success=true/);
  assert.deepEqual(run?.operationStats, { pending: 5 });
});

test('scheduler diagnostics count only durably completed and recorded failed attempts with elapsed time', async () => {
  const before = DreamDiagnostics.snapshot();
  const { ledger } = await openLedger();
  const successful = new DreamScheduler({
    ledger, ownerId: 'metrics-success', now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 200, body: { success: true, counts: { processed: 1 } } }),
  });
  const failed = new DreamScheduler({
    ledger, ownerId: 'metrics-failure', now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 200, body: { success: false } }),
  });
  const run = { jobType: 'consolidation' as const, tenantId: 'tenant-a', project: 'project-a', timezone: 'UTC' };
  assert.equal(await successful.runSlot({ ...run, scheduledFor: '2026-10-19T09:00:00.000Z' }), 'completed');
  assert.equal(await failed.runSlot({ ...run, scheduledFor: '2026-10-19T09:05:00.000Z' }), 'retryable');
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.scheduler_success - before.scheduler_success, 1);
  assert.equal(after.scheduler_failure - before.scheduler_failure, 1);
  assert.ok(after.scheduler_duration_ms_total >= before.scheduler_duration_ms_total);
  assert.ok(after.scheduler_duration_ms_max >= before.scheduler_duration_ms_max);
  const duplicate = await successful.runSlot({ ...run, scheduledFor: '2026-10-19T09:00:00.000Z' });
  assert.equal(duplicate, 'skipped');
  assert.equal(DreamDiagnostics.snapshot().scheduler_failure, after.scheduler_failure);
});

test('HTTP failure and timeout exceptions are persisted as retryable attempts', async () => {
  const first = await openLedger();
  const scheduler = new DreamScheduler({
    ledger: first.ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 503, body: { success: false } }),
  });
  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'retryable');
  const keyClaim = await first.ledger.claimRun({ ...baseClaim, ownerId: 'worker-b', now: '2026-10-19T09:00:03.000Z' });
  assert.equal(keyClaim, null);

  const second = await openLedger();
  const timeoutScheduler = new DreamScheduler({
    ledger: second.ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => { throw new Error('request timed out'); },
  });
  assert.equal(await timeoutScheduler.runSlot({ ...baseClaim }), 'retryable');
});

test('a response with success=true but failed operation counts remains retryable', async () => {
  const { adapter, ledger } = await openLedger();
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 200, body: { success: true, counts: { processed: 4, failed: 1 } } }),
  });

  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'retryable');
  const rows = await adapter.query<{ job_key: string }>('SELECT job_key FROM dream_job_runs');
  const run = await ledger.getRun(rows[0].job_key);
  assert.equal(run?.state, 'retryable');
  assert.deepEqual(run?.operationStats, { processed: 4, failed: 1 });
});

test('ticker keeps reconciliation and consolidation independent and honors per-job disable flags', async () => {
  const { adapter, ledger } = await openLedger();
  const calls: string[] = [];
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:10.000Z'),
    executeJob: async (claim) => {
      calls.push(claim.jobType);
      return { httpStatus: 200, body: { success: true, pending: 0, consolidation: { status: 'completed', errors: [], dreamsProcessed: 2 } } };
    },
  });
  const results = await scheduler.tick({
    dreams_enabled: true,
    dreams_schedule: '* * * * *',
    reconciliation_enabled: false,
    reconciliation_schedule: '* * * * *',
    timezone: 'UTC',
    tenant_id: 'tenant-a',
  });
  assert.deepEqual(calls, ['consolidation']);
  assert.deepEqual(results.map((result) => result.jobType), ['consolidation']);
  const rows = await adapter.query<{ job_type: string; operation_stats: string }>('SELECT job_type, operation_stats FROM dream_job_runs');
  assert.deepEqual(rows, [{ job_type: 'consolidation', operation_stats: '{"pending":0,"dreamsProcessed":2}' }]);
});

test('ticker carries selected project scope into both scheduled jobs', async () => {
  const { ledger } = await openLedger();
  const claims: Array<{ jobType: string; tenantId: string; project?: string }> = [];
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'scoped-worker',
    now: () => new Date('2026-10-19T09:00:10.000Z'),
    executeJob: async (claim) => {
      claims.push({ jobType: claim.jobType, tenantId: claim.tenantId, project: claim.project });
      return { httpStatus: 200, body: { success: true } };
    },
  });
  await scheduler.tick({
    dreams_enabled: true,
    dreams_schedule: '* * * * *',
    reconciliation_enabled: true,
    reconciliation_schedule: '* * * * *',
    timezone: 'UTC',
    tenant_id: 'canary-tenant',
    project_id: 'canonical-project-id',
    project: 'platform-display-name',
  });
  assert.deepEqual(claims, [
    { jobType: 'reconciliation', tenantId: 'canary-tenant', project: 'canonical-project-id' },
    { jobType: 'consolidation', tenantId: 'canary-tenant', project: 'canonical-project-id' },
  ]);
});

test('missed-window recovery chooses only the newest matching UTC slot', () => {
  assert.equal(
    latestDueCronSlot('*/5 * * * *', new Date('2026-10-19T09:13:42.000Z'), 'UTC', 20),
    '2026-10-19T09:10:00.000Z',
  );
  assert.equal(latestDueCronSlot('0 9 * * *', new Date('2026-10-19T10:00:00.000Z'), 'UTC', 30), null);
});

test('heartbeat failure fences the in-flight worker and leaves recovery to a later claim', async () => {
  const { adapter, ledger } = await openLedger();
  const before = DreamDiagnostics.snapshot();
  ledger.heartbeat = async () => { throw new Error('database temporarily unavailable'); };
  let signalAborted = false;
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'worker-a',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    leaseMs: 1000,
    heartbeatMs: 5,
    executeJob: async (_claim, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          signalAborted = true;
          resolve();
        } else {
          signal.addEventListener('abort', () => { signalAborted = true; resolve(); }, { once: true });
        }
      });
      return { httpStatus: 200, body: { success: true } };
    },
  });

  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'skipped');
  assert.equal(signalAborted, true);
  const rows = await adapter.query<{ state: string }>('SELECT state FROM dream_job_runs');
  assert.equal(rows[0].state, 'running');
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.scheduler_failure - before.scheduler_failure, 1);
  assert.equal(after.scheduler_lease_lost - before.scheduler_lease_lost, 1);
  assert.ok(after.scheduler_duration_ms_total > before.scheduler_duration_ms_total);
});

test('stale completion is counted as lease loss without changing the fenced ledger row', async () => {
  const { adapter, ledger } = await openLedger();
  const before = DreamDiagnostics.snapshot();
  ledger.completeRun = async () => false;
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'stale-completer',
    now: () => new Date('2026-10-19T09:00:02.000Z'),
    executeJob: async () => ({ httpStatus: 200, body: { success: true } }),
  });

  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'skipped');
  const rows = await adapter.query<{ state: string }>('SELECT state FROM dream_job_runs');
  assert.equal(rows[0].state, 'running');
  const after = DreamDiagnostics.snapshot();
  assert.equal(after.scheduler_failure - before.scheduler_failure, 1);
  assert.equal(after.scheduler_lease_lost - before.scheduler_lease_lost, 1);
});

test('completion write failure after side effects stays retryable and reuses the same run ID', async () => {
  const { ledger } = await openLedger();
  let now = new Date('2026-10-19T09:00:02.000Z');
  const effects = new Set<string>();
  const executeJob = async (claim: { runId: string }) => {
    effects.add(claim.runId);
    return { httpStatus: 200, body: { success: true } };
  };
  const complete = ledger.completeRun.bind(ledger);
  let crashOnce = true;
  ledger.completeRun = async (...args) => {
    if (crashOnce) {
      crashOnce = false;
      throw new Error('simulated crash after operation commit');
    }
    return complete(...args);
  };
  const scheduler = new DreamScheduler({
    ledger,
    ownerId: 'worker-a',
    now: () => now,
    baseBackoffMs: 1000,
    executeJob,
  });

  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'retryable');
  now = new Date('2026-10-19T09:00:04.000Z');
  assert.equal(await scheduler.runSlot({ ...baseClaim }), 'completed');
  assert.equal(effects.size, 1);
});
