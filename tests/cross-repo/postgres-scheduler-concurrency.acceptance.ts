/**
 * Opt-in real PostgreSQL concurrency acceptance test.
 *
 * Run with CODEATLAS_POSTGRES_ACCEPTANCE=1, POSTGRES_* connection variables,
 * and CODEATLAS_POSTGRES_PG_CTL / DATA_DIR / START_OPTIONS / SERVER_LOG pointed
 * at a disposable local PostgreSQL cluster. The test itself never installs or
 * starts a system service; it only stops and restarts the supplied cluster.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PostgresAdapter } from '../../src/database/adapters/postgresAdapter.js';
import { DreamRunLedger } from '../../src/services/dreamScheduler.js';

const adapters: PostgresAdapter[] = [];

async function openAdapter(): Promise<{ adapter: PostgresAdapter; ledger: DreamRunLedger }> {
  const adapter = new PostgresAdapter();
  adapters.push(adapter);
  await adapter.initializeSchema();
  return { adapter, ledger: new DreamRunLedger(adapter) };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Set ${name} for the disposable PostgreSQL acceptance test`);
  return value;
}

function assertSafeRuntimeTarget(): void {
  const tempRoot = realpathSync(tmpdir());
  const safeTemporaryDirectory = (name: string): string => {
    const raw = requireEnvironment(name);
    assert.ok(path.isAbsolute(raw), `${name} must be an absolute path, not a TCP host`);
    const requested = path.resolve(raw);
    let resolved: string;
    try { resolved = realpathSync(requested); }
    catch { assert.fail(`${name} must already exist under the temporary directory`); }
    assert.equal(resolved, requested, `${name} must not contain symlinks`);
    const relative = path.relative(tempRoot, resolved);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${name} must be strictly inside the real os.tmpdir()`);
    return resolved;
  };

  safeTemporaryDirectory('CODEATLAS_POSTGRES_DATA_DIR');
  safeTemporaryDirectory('POSTGRES_HOST');
  const database = requireEnvironment('POSTGRES_DB');
  assert.match(database, /^codeatlas_acceptance_[a-z0-9_]{1,80}$/, 'POSTGRES_DB must use a dedicated synthetic acceptance database name');
}

function runPgCtl(args: string[], operation: string): void {
  const pgCtl = requireEnvironment('CODEATLAS_POSTGRES_PG_CTL');
  const result = spawnSync(pgCtl, args, { encoding: 'utf8', env: process.env, timeout: 30_000 });
  assert.equal(result.error, undefined, `pg_ctl ${operation} could not run`);
  assert.equal(result.status, 0, `pg_ctl ${operation} failed`);
}

function restartPostgres(): void {
  const dataDir = requireEnvironment('CODEATLAS_POSTGRES_DATA_DIR');
  const startOptions = requireEnvironment('CODEATLAS_POSTGRES_START_OPTIONS');
  const serverLog = requireEnvironment('CODEATLAS_POSTGRES_SERVER_LOG');
  runPgCtl(['-D', dataDir, '-m', 'fast', '-w', 'stop'], 'stop');
  runPgCtl(['-D', dataDir, '-l', serverLog, '-o', startOptions, '-w', 'start'], 'start');
}

after(async () => {
  await Promise.allSettled(adapters.map(adapter => adapter.disconnect()));
});

test('Postgres scheduler claims one concurrent owner, fences stale lease, and persists through restart', {
  skip: process.env.CODEATLAS_POSTGRES_ACCEPTANCE !== '1',
}, async () => {
  assertSafeRuntimeTarget();
  const first = await openAdapter();
  const second = await openAdapter();
  const identity = randomUUID();
  const now = '2026-10-20T00:00:00.000Z';
  const slot = {
    jobType: 'reconciliation' as const,
    tenantId: `pg-acceptance-${identity}`,
    project: 'same-project-slot',
    scheduledFor: now,
    timezone: 'UTC',
    now,
    leaseMs: 2_000,
    maxAttempts: 3,
  };

  const [claimA, claimB] = await Promise.all([
    first.ledger.claimRun({ ...slot, ownerId: 'worker-a' }),
    second.ledger.claimRun({ ...slot, ownerId: 'worker-b' }),
  ]);
  assert.equal([claimA, claimB].filter(Boolean).length, 1, 'one concurrent worker must own this slot');

  const originalClaim = claimA ?? claimB;
  assert.ok(originalClaim);
  const winningLedger = claimA ? first.ledger : second.ledger;
  const otherLedger = claimA ? second.ledger : first.ledger;
  assert.equal(await otherLedger.claimRun({ ...slot, ownerId: 'losing-worker' }), null, 'the active lease blocks the other adapter');

  const reclaimAt = new Date(Date.parse(originalClaim.leaseUntil) + 1).toISOString();
  const reclaimed = await otherLedger.claimRun({ ...slot, ownerId: 'reclaimed-worker', now: reclaimAt });
  assert.ok(reclaimed, 'another adapter reclaims after lease expiry');
  assert.equal(reclaimed.attempt, 2);
  assert.equal(reclaimed.fencingToken, originalClaim.fencingToken + 1);
  assert.equal(await winningLedger.isClaimCurrent(originalClaim, reclaimAt), false);
  assert.equal(await winningLedger.completeRun(originalClaim, { success: true }, reclaimAt), false, 'stale owner cannot complete');

  const completeAt = new Date(Date.parse(reclaimAt) + 1_000).toISOString();
  assert.equal(await otherLedger.isClaimCurrent(reclaimed, completeAt), true);
  assert.equal(await otherLedger.completeRun(reclaimed, { success: true, counts: { processed: 1 } }, completeAt), true);
  const jobKey = reclaimed.jobKey;

  for (const adapter of adapters) await adapter.disconnect();
  restartPostgres();

  const reopened = await openAdapter();
  const persisted = await reopened.ledger.getRun(jobKey);
  assert.ok(persisted);
  assert.equal(persisted.state, 'completed');
  assert.equal(persisted.fencingToken, reclaimed.fencingToken);
  assert.equal(persisted.attempt, 2);
  assert.deepEqual(persisted.operationStats, { processed: 1 });
});
