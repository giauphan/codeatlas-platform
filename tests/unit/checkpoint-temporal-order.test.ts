import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let db: SQLiteAdapter;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => db } });
mock.module('../../src/services/embeddingService.js', { namedExports: { generateEmbedding: async () => null } });
const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { MemoryIngestionService } = await import('../../src/services/memoryIngestionService.js');
const { SessionCheckpointService } = await import('../../src/services/sessionCheckpointService.js');

const auth = { uid: 'checkpoint-time-tenant', tier: 'enterprise', keyId: 'test-key' };
const sameTime = '2026-10-20T12:00:00.000Z';

beforeEach(async () => {
  db = new SQLiteAdapter(':memory:');
  await db.initialize();
  await DreamingService.initialize();
});

afterEach(async () => {
  await db.disconnect();
  mock.restoreAll();
});

async function capture(eventId: string, content: string, checkpoint?: unknown, actorRole: 'USER' | 'TOOL' = 'USER') {
  return DreamCaptureStore.accept({
    eventId,
    sessionId: 'same-session',
    project: 'display-project',
    projectId: 'canonical-project',
    actorRole,
    content,
    checkpoint,
  });
}

for (const futureId of ['a-future-before-marker', 'z-future-after-marker']) {
  test(`same-timestamp future capture ${futureId} is excluded by checkpoint sequence`, async () => {
    await authStorage.run(auth, async () => {
      await capture('older-user-event', 'Decision: preserve the offline cache for reliable local development.', undefined, 'USER');
      await capture('marker-event', 'Session checkpoint (Stop)', { trigger: 'Stop' }, 'TOOL');
      await capture(futureId, 'I prefer concise JSON output for all API responses.', undefined, 'USER');
      await db.execute('UPDATE dream_capture_events SET created_at = :createdAt', { createdAt: sameTime });

      const checkpoint = await SessionCheckpointService.latest('canonical-project');
      assert.ok(checkpoint);
      assert.ok(!checkpoint.source_event_ids.includes(futureId));

      const result = await MemoryIngestionService.processPending({ projectId: 'canonical-project', eventId: 'marker-event' });
      assert.equal(result.success, true);
      const futureEvidence = await db.query<{ source_event_id: string }>(
        'SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = :eventId',
        { eventId: futureId },
      );
      assert.deepEqual(futureEvidence, []);
      const futureStatus = await db.query<{ status: string }>(
        'SELECT status FROM dream_capture_events WHERE event_id = :eventId',
        { eventId: futureId },
      );
      assert.equal(futureStatus[0].status, 'pending');
    });
  });
}

test('latest checkpoint follows capture sequence when marker timestamps and IDs disagree', async () => {
  await authStorage.run(auth, async () => {
    await capture('first-task', 'Please preserve the offline cache for reliable local development.', undefined, 'USER');
    await capture('z-first-marker', 'Session checkpoint (Stop)', { trigger: 'Stop' }, 'TOOL');
    await capture('second-task', 'Decision: preserve the newest complete event because recent user intent has priority.', undefined, 'USER');
    await capture('a-second-marker', 'Session checkpoint (Stop)', { trigger: 'Stop' }, 'TOOL');
    await db.execute('UPDATE dream_capture_events SET created_at = :createdAt', { createdAt: sameTime });

    const checkpoint = await SessionCheckpointService.latest('canonical-project');
    assert.ok(checkpoint);
    assert.ok(checkpoint.source_event_ids.includes('second-task'));
    assert.ok(checkpoint.source_event_ids.includes('a-second-marker'));
    const materialized = await db.query<{ source_checkpoint_id: string }>(
      'SELECT source_checkpoint_id FROM dream_session_checkpoints WHERE id = :id',
      { id: checkpoint.id },
    );
    assert.equal(materialized[0].source_checkpoint_id, 'a-second-marker');
  });
});

test('reconciling an older checkpoint after later same-session capture does not include the later event', async () => {
  await authStorage.run(auth, async () => {
    await capture('old-marker', 'Session checkpoint (PreCompact)', { trigger: 'PreCompact' }, 'TOOL');
    await capture('later-source', 'I prefer concise JSON output for all API responses.', undefined, 'USER');
    await db.execute('UPDATE dream_capture_events SET created_at = :createdAt', { createdAt: sameTime });

    await MemoryIngestionService.processPending({ projectId: 'canonical-project', eventId: 'old-marker' });

    const evidence = await db.query<{ source_event_id: string }>(
      'SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = :eventId',
      { eventId: 'later-source' },
    );
    assert.deepEqual(evidence, []);
  });
});

test('checkpoint input budget retains the newest complete decision event', async () => {
  await authStorage.run(auth, async () => {
    const routineText = 'A blue pebble rested beside the quiet window on a calm afternoon. '.repeat(14);
    for (let index = 0; index < 60; index += 1) {
      await capture(`routine-${String(index).padStart(2, '0')}`, routineText);
    }
    await capture('newest-decision', 'Decision: preserve the newest complete event because recent user intent has priority.');
    await capture('budget-marker', 'Session checkpoint (Stop)', { trigger: 'Stop' }, 'TOOL');

    const result = await MemoryIngestionService.processPending({ projectId: 'canonical-project', eventId: 'budget-marker' });
    assert.equal(result.success, true);
    const evidence = await db.query<{ source_event_id: string }>(
      'SELECT source_event_id FROM dream_memory_evidence WHERE source_event_id = :eventId',
      { eventId: 'newest-decision' },
    );
    assert.equal(evidence.length, 1);
  });
});

test('SQLite migration backfills legacy capture rows and sequences later inserts', async () => {
  const legacy = new SQLiteAdapter(':memory:');
  await legacy.connect();
  try {
    await legacy.execute(`CREATE TABLE dream_capture_events (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, project TEXT NOT NULL, display_name TEXT, workspace_path TEXT,
      event_id TEXT NOT NULL, session_id TEXT NOT NULL, actor_role TEXT, memory_type_hint TEXT, tool_name TEXT,
      request_hash TEXT NOT NULL, content_redacted TEXT NOT NULL, checkpoint_json TEXT, occurred_at TEXT,
      source_spans_json TEXT, memory_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
      acknowledged_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, project_id, event_id)
    )`);
    for (const eventId of ['legacy-first', 'legacy-second']) {
      await legacy.execute(`INSERT INTO dream_capture_events (tenant_id, project_id, project, event_id, session_id, request_hash, content_redacted, created_at)
        VALUES ('legacy-tenant', 'legacy-project', 'legacy-project', :eventId, 'legacy-session', 'hash', 'body', :createdAt)`,
      { eventId, createdAt: sameTime });
    }

    await legacy.initializeSchema();
    const oldRows = await legacy.query<{ event_id: string; capture_sequence: number }>(
      'SELECT event_id, capture_sequence FROM dream_capture_events ORDER BY rowid',
    );
    assert.deepEqual(oldRows.map(row => row.capture_sequence), [1, 2]);

    await legacy.execute(`INSERT INTO dream_capture_events (tenant_id, project_id, project, event_id, session_id, request_hash, content_redacted)
      VALUES ('legacy-tenant', 'legacy-project', 'legacy-project', 'legacy-third', 'legacy-session', 'hash', 'body')`);
    const newRow = await legacy.query<{ capture_sequence: number }>(
      "SELECT capture_sequence FROM dream_capture_events WHERE event_id = 'legacy-third'",
    );
    assert.equal(newRow[0].capture_sequence, 3);
  } finally {
    await legacy.disconnect();
  }
});
