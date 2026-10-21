import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', {
  namedExports: { createDatabaseAdapter: () => adapter },
});
const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');

const tenantA = { uid: 'capture-tenant-a', tier: 'enterprise', keyId: 'test-key' };
const tenantB = { uid: 'capture-tenant-b', tier: 'enterprise', keyId: 'test-key' };
const event = {
  eventId: 'evt-1',
  sessionId: 'session-1',
  actorRole: 'USER' as const,
  memoryTypeHint: 'KNOWLEDGE' as const,
  toolName: 'Read',
  project: 'project-one',
  projectId: 'project-id-one',
  displayName: 'Friendly Project',
  workspacePath: '/work/repos/project-one',
  content: 'Validated auth flow. api_key=secret-value should never persist. AWS examples AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE are synthetic.',
  checkpoint: { kind: 'progress', ordinal: 3, summary: 'Do not retain AKIAIOSFODNN7EXAMPLE or ASIAIOSFODNN7EXAMPLE.' },
};

beforeEach(async () => {
  adapter = new SQLiteAdapter(':memory:');
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.disconnect();
  mock.restoreAll();
});

test('stores redacted bounded source evidence before returning a durable ACK', async () => {
  const ack = await authStorage.run(tenantA, () => DreamCaptureStore.accept(event));
  const rows = await adapter.query<Record<string, unknown>>('SELECT * FROM dream_capture_events');

  assert.deepEqual(ack, {
    success: true,
    status: 'stored',
    persisted: true,
    acknowledged: true,
    event_id: 'evt-1',
    memory_ids: [],
    source_persisted: true,
    extraction_status: 'pending',
  });
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].content_redacted), /api_key=\[REDACTED\]/);
  assert.doesNotMatch(String(rows[0].content_redacted), /secret-value/);
  assert.doesNotMatch(String(rows[0].content_redacted), /AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(String(rows[0].checkpoint_json), /AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE/);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].actor_role, 'USER');
  assert.equal(rows[0].memory_type_hint, 'KNOWLEDGE');
  assert.equal(rows[0].tool_name, 'Read');
  assert.equal(rows[0].display_name, 'Friendly Project');
  assert.equal(rows[0].workspace_path, '/work/repos/project-one');
});

test('accepts TOOL failure evidence and persists its validated MISTAKE hint', async () => {
  const ack = await authStorage.run(tenantA, () => DreamCaptureStore.accept({
    ...event,
    eventId: 'evt-tool-failure',
    actorRole: 'TOOL',
    memoryTypeHint: 'MISTAKE',
  }));
  const rows = await adapter.query<Record<string, unknown>>('SELECT actor_role, memory_type_hint FROM dream_capture_events');

  assert.equal(ack.status, 'stored');
  assert.equal(rows[0].actor_role, 'TOOL');
  assert.equal(rows[0].memory_type_hint, 'MISTAKE');
});

test('replay returns duplicate and changed payload with same event id is rejected', async () => {
  const first = await authStorage.run(tenantA, () => DreamCaptureStore.accept(event));
  const replay = await authStorage.run(tenantA, () => DreamCaptureStore.accept(event));
  const changed = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, checkpoint: { kind: 'different' } }));

  assert.equal(first.status, 'stored');
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.acknowledged, true);
  assert.equal(changed.status, 'rejected');
  assert.equal(changed.acknowledged, false);
  assert.equal(changed.reason_code, 'event_id_reused');
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM dream_capture_events'))[0].count, 1);
});

test('concurrent event delivery and crash after durable write replay without duplicate rows', async () => {
  const concurrent = await Promise.all([
    authStorage.run(tenantA, () => DreamCaptureStore.accept(event)),
    authStorage.run(tenantA, () => DreamCaptureStore.accept(event)),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ['duplicate', 'stored']);
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM dream_capture_events'))[0].count, 1);

  const originalExecute = adapter.execute.bind(adapter);
  let failAfterInsert = true;
  adapter.execute = async (...args: Parameters<typeof adapter.execute>) => {
    const result = await originalExecute(...args);
    if (failAfterInsert && String(args[0]).includes('INSERT INTO dream_capture_events')) {
      failAfterInsert = false;
      throw new Error('simulated lost response after commit');
    }
    return result;
  };
  const afterCommitFailure = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, eventId: 'evt-crash' }));
  const retry = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, eventId: 'evt-crash' }));

  assert.equal(afterCommitFailure.acknowledged, false);
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.acknowledged, true);
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM dream_capture_events'))[0].count, 2);
});

test('same event id is isolated by tenant and canonical project id', async () => {
  const first = await authStorage.run(tenantA, () => DreamCaptureStore.accept(event));
  const otherTenant = await authStorage.run(tenantB, () => DreamCaptureStore.accept(event));
  const otherProject = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, projectId: 'project-id-two' }));

  assert.deepEqual([first.status, otherTenant.status, otherProject.status], ['stored', 'stored', 'stored']);
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM dream_capture_events'))[0].count, 3);
});

test('oversized event content is rejected without persisting or acknowledging it', async () => {
  const result = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, content: 'x'.repeat(17 * 1024) }));

  assert.equal(result.status, 'rejected');
  assert.equal(result.persisted, false);
  assert.equal(result.acknowledged, false);
  assert.equal(result.reason_code, 'event_too_large');
  assert.equal((await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM dream_capture_events'))[0].count, 0);
});

test('checkpoint secrets are redacted and invalid source spans are rejected', async () => {
  const result = await authStorage.run(tenantA, () => DreamCaptureStore.accept({
    ...event,
    eventId: 'evt-checkpoint',
    checkpoint: { summary: 'Use api_key=checkpoint-secret only in local dev' },
  }));
  const rows = await adapter.query<{ checkpoint_json: string }>('SELECT checkpoint_json FROM dream_capture_events');
  assert.equal(result.status, 'stored');
  assert.doesNotMatch(rows[0].checkpoint_json, /checkpoint-secret/);
  assert.match(rows[0].checkpoint_json, /REDACTED/);

  const validByteSpan = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, eventId: 'evt-span-valid', sourceSpans: [{ start: 10, end: 10_000 }] }));
  assert.equal(validByteSpan.status, 'stored');
  const invalidSpan = await authStorage.run(tenantA, () => DreamCaptureStore.accept({ ...event, eventId: 'evt-span', sourceSpans: [{ start: 12, end: 10 }] }));
  assert.equal(invalidSpan.status, 'rejected');
  assert.equal(invalidSpan.reason_code, 'invalid_source_spans');
});

test('nested AWS credential fields are redacted before checkpoint persistence', async () => {
  const accessSecret = 'syntheticAwsAccessSecret123456789';
  const sessionSecret = 'syntheticAwsSessionToken987654321';
  const result = await authStorage.run(tenantA, () => DreamCaptureStore.accept({
    ...event,
    eventId: 'evt-nested-aws-checkpoint',
    checkpoint: { context: { cloud: { AWS_SECRET_ACCESS_KEY: accessSecret, AWS_SESSION_TOKEN: sessionSecret } } },
  }));
  const rows = await adapter.query<{ checkpoint_json: string }>(
    "SELECT checkpoint_json FROM dream_capture_events WHERE event_id = 'evt-nested-aws-checkpoint'",
  );
  assert.equal(result.status, 'stored');
  assert.equal(result.acknowledged, true);
  assert.equal(rows.length, 1);
  const checkpoint = JSON.parse(rows[0].checkpoint_json) as { context: { cloud: Record<string, string> } };
  assert.equal(checkpoint.context.cloud.AWS_SECRET_ACCESS_KEY, '[REDACTED]');
  assert.equal(checkpoint.context.cloud.AWS_SESSION_TOKEN, '[REDACTED]');
  assert.doesNotMatch(rows[0].checkpoint_json, new RegExp(`${accessSecret}|${sessionSecret}`));
});

test('reconciliation returns only pending events for the current tenant and project', async () => {
  await authStorage.run(tenantA, () => DreamCaptureStore.accept(event));
  await authStorage.run(tenantB, () => DreamCaptureStore.accept(event));

  const pending = await authStorage.run(tenantA, () => DreamCaptureStore.reconcilePending({ projectId: 'project-id-one' }));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tenantId, tenantA.uid);
  assert.equal(pending[0].eventId, event.eventId);
  assert.equal(pending[0].payloadRedacted, true);
});
