import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';
let db: SQLiteAdapter;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => db } });
const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { SessionCheckpointService } = await import('../../src/services/sessionCheckpointService.js');
const tenant = { uid: 'checkpoint-tenant', tier: 'enterprise', keyId: 'test-key' };
const otherTenant = { uid: 'other-checkpoint-tenant', tier: 'enterprise', keyId: 'other-key' };
beforeEach(async () => { db = new SQLiteAdapter(':memory:'); await db.initialize(); });
afterEach(async () => { await db.disconnect(); });

async function capture(eventId: string, content: string, actorRole?: 'USER' | 'ASSISTANT' | 'TOOL', checkpoint?: unknown, projectId = 'canonical-project') {
  return DreamCaptureStore.accept({ eventId, sessionId: 'checkpoint-source-session', project: 'display-project', projectId, actorRole, content, checkpoint });
}

test('latest checkpoint is deterministic project-scoped and available without a semantic query', async () => {
  await authStorage.run(tenant, async () => {
    await capture('user-decision', 'Decision: preserve nebula-worker.ts tenant isolation because project memory must remain scoped.', 'USER');
    await capture('tool-verification', '[Bash]\ninput: command=npm test\noutcome: exit_code=0\nresult: 42 tests passed for nebula-worker.ts', 'TOOL');
    await capture('checkpoint-event', 'Session checkpoint (PreCompact)', undefined, { trigger: 'PreCompact', transcript_cursor: 1024 });
    const checkpoint = await SessionCheckpointService.latest('canonical-project');
    assert.ok(checkpoint);
    assert.ok(checkpoint.active_task.includes('nebula-worker.ts'));
    assert.ok(checkpoint.decisions.some(item => item.includes('tenant isolation')));
    assert.ok(checkpoint.completed.some(item => item.includes('42 tests passed')));
    assert.ok(checkpoint.source_event_ids.includes('tool-verification'));
    assert.deepEqual(checkpoint.source_session_ids, ['checkpoint-source-session']);
    assert.deepEqual(await SessionCheckpointService.latest('canonical-project'), checkpoint);
  });
  assert.equal(await authStorage.run(otherTenant, () => SessionCheckpointService.latest('canonical-project')), null);
  assert.equal(await authStorage.run(tenant, () => SessionCheckpointService.latest('other-project')), null);
});

test('assistant completion claims cannot override a failing tool observation in a checkpoint', async () => {
  await authStorage.run(tenant, async () => {
    await capture('task-source', 'Please fix resolver.ts while keeping project boundaries intact.', 'USER');
    await capture('assistant-claim', 'I completed every migration and all tests passed.', 'ASSISTANT');
    await capture('tool-failure', '[Bash]\noutcome: failed\nerror: resolver.ts regression failed with exit code 1.', 'TOOL');
    await capture('checkpoint-event', 'Session checkpoint (Stop)', undefined, { trigger: 'Stop' });
    const checkpoint = await SessionCheckpointService.latest('canonical-project');
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.completed, []);
    assert.ok(checkpoint.blockers.some(item => item.includes('regression failed')));
    assert.ok(!checkpoint.decisions.some(item => item.includes('every migration')));
  });
});

test('checkpoint content and evidence never retain credentials from a source event', async () => {
  await authStorage.run(tenant, async () => {
    await capture('secret-source', 'Decision: use the offline API adapter; api_key=synthetic-private-value must be redacted before persistence.', 'USER');
    await capture('checkpoint-event', 'Session checkpoint (PreCompact)', undefined, { trigger: 'PreCompact' });
    const checkpoint = await SessionCheckpointService.latest('canonical-project');
    assert.ok(checkpoint);
    assert.ok(!JSON.stringify(checkpoint).includes('synthetic-private-value'));
    const rows = await db.query<{ payload_json: string }>('SELECT payload_json FROM dream_session_checkpoints');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => !row.payload_json.includes('synthetic-private-value')));
  });
});

test('derived checkpoints redact AWS secret access-key and session-token fields', async () => {
  await authStorage.run(tenant, async () => {
    const secretAccessKey = 'aws-secret-access-sentinel-4815162342';
    const sessionToken = 'aws-session-token-sentinel-3141592653';
    const privateUrlPassword = 'private-url-password-sentinel-2718281828';
    // Legacy persisted rows can predate the current capture redactor.
    await db.execute(`INSERT INTO dream_capture_events
      (tenant_id, project_id, project, event_id, session_id, actor_role, request_hash, content_redacted, status)
      VALUES (:tenant, 'canonical-project', 'display-project', 'aws-fields', 'checkpoint-source-session', 'USER', 'legacy-hash', :content, 'processed')`,
    { tenant: tenant.uid, content: `The deployment environment includes AWS_SECRET_ACCESS_KEY=${secretAccessKey}, AWS_SESSION_TOKEN=${sessionToken}, and https://checkpoint-user:${privateUrlPassword}@internal.example/path.` });
    await capture('aws-fields-marker', 'Session checkpoint (Stop)', undefined, { trigger: 'Stop' });
    const checkpoint = await SessionCheckpointService.latest('canonical-project');
    assert.ok(checkpoint);
    assert.ok(!JSON.stringify(checkpoint).includes(secretAccessKey));
    assert.ok(!JSON.stringify(checkpoint).includes(sessionToken));
    assert.ok(!JSON.stringify(checkpoint).includes(privateUrlPassword));
    assert.match(checkpoint.active_task, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
    assert.match(checkpoint.active_task, /AWS_SESSION_TOKEN=\[REDACTED\]/);
    assert.match(checkpoint.active_task, /https:\/\/checkpoint-user:\[REDACTED\]@internal\.example\/path/);
  });
});

test('explicit checkpoint writes reject claims unsupported by their cited same-project events', async () => {
  await authStorage.run(tenant, async () => {
    await capture('decision-source', 'Decision: preserve SQLite as the local storage default.', 'USER');
    await assert.rejects(() => SessionCheckpointService.save({ projectId: 'canonical-project', sessionId: 'checkpoint-source-session', sourceEventIds: ['decision-source'], completed: ['Deployed to production'] }), /unsupported|evidence/i);
    await assert.rejects(() => SessionCheckpointService.save({ projectId: 'other-project', sessionId: 'checkpoint-source-session', sourceEventIds: ['decision-source'] }), /source|evidence/i);
  });
});

test('a marker without meaningful user or verified tool evidence remains empty memory', async () => {
  await authStorage.run(tenant, async () => {
    await capture('empty-marker', 'Session checkpoint (Stop)', undefined, { trigger: 'Stop' });
    assert.equal(await SessionCheckpointService.latest('canonical-project'), null);
  });
});
