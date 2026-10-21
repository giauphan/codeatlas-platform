/**
 * Opt-in acceptance test for additive migration of an existing PostgreSQL
 * capture table that predates durable ACK metadata.
 *
 * Run with CODEATLAS_POSTGRES_ACCEPTANCE=1 and the private disposable-cluster
 * settings documented by postgres-scheduler-concurrency.acceptance.ts. This
 * test rejects TCP hosts and non-temporary data/socket paths before connecting.
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, mock, test } from 'node:test';
import { PostgresAdapter } from '../../src/database/adapters/postgresAdapter.js';

const adapters: PostgresAdapter[] = [];

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Set ${name} for the disposable PostgreSQL acceptance test`);
  return value;
}

function assertSafeRuntimeTarget(): void {
  const tempRoot = realpathSync(tmpdir());
  const safeTemporaryDirectory = (name: string): string => {
    const raw = requiredEnvironment(name);
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
  assert.match(requiredEnvironment('POSTGRES_DB'), /^codeatlas_acceptance_[a-z0-9_]{1,80}$/, 'POSTGRES_DB must use a dedicated synthetic acceptance database name');
}

after(async () => {
  await Promise.allSettled(adapters.map(adapter => adapter.disconnect()));
});

test('Postgres adds capture ACK columns to a populated legacy table idempotently and capture replay remains durable', {
  skip: process.env.CODEATLAS_POSTGRES_ACCEPTANCE !== '1',
}, async () => {
  assertSafeRuntimeTarget();

  const identity = `capture_migration_${process.pid}_${Date.now()}`;
  const client = new PostgresAdapter();
  adapters.push(client);
  await client.connect();
  const preexistingTable = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'dream_capture_events'
    ) AS present
  `);
  assert.equal(preexistingTable[0].present, false, 'use a fresh synthetic acceptance database, never drop existing tables');

  await client.query(`
    CREATE TABLE dream_capture_events (
      tenant_id VARCHAR(255) NOT NULL,
      project_id VARCHAR(512) NOT NULL,
      project VARCHAR(255) NOT NULL,
      display_name VARCHAR(512),
      workspace_path TEXT,
      event_id VARCHAR(255) NOT NULL,
      session_id VARCHAR(255) NOT NULL,
      actor_role VARCHAR(16),
      memory_type_hint VARCHAR(32),
      tool_name VARCHAR(128),
      request_hash VARCHAR(64) NOT NULL,
      content_redacted TEXT NOT NULL,
      checkpoint_json TEXT,
      occurred_at TEXT,
      source_spans_json TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      capture_sequence BIGINT,
      legacy_annotation TEXT NOT NULL DEFAULT 'legacy-default',
      PRIMARY KEY (tenant_id, project_id, event_id)
    )
  `);
  await client.query('CREATE TABLE legacy_capture_migration_audit (event_id TEXT NOT NULL, annotation TEXT NOT NULL)');
  await client.query(`
    CREATE FUNCTION legacy_capture_migration_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO legacy_capture_migration_audit(event_id, annotation) VALUES (NEW.event_id, NEW.legacy_annotation);
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    CREATE TRIGGER legacy_capture_migration_audit_trigger
    AFTER UPDATE OF legacy_annotation ON dream_capture_events
    FOR EACH ROW EXECUTE FUNCTION legacy_capture_migration_audit_fn()
  `);
  await client.query('CREATE INDEX legacy_capture_annotation_idx ON dream_capture_events(legacy_annotation)');
  const legacyEventId = `${identity}_legacy`;
  await client.query(`
    INSERT INTO dream_capture_events
      (tenant_id, project_id, project, display_name, workspace_path, event_id, session_id,
       actor_role, memory_type_hint, tool_name, request_hash, content_redacted, checkpoint_json,
       occurred_at, source_spans_json, status, created_at, capture_sequence, legacy_annotation)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'USER', 'KNOWLEDGE', 'test-tool', $8, $9, NULL,
       '2026-10-20T00:00:00.000Z', '[]', 'processed', '2026-10-20T00:00:00.000Z', NULL, 'preserve-this-custom-value')
  `, [identity, `${identity}_project`, `${identity}_display`, `${identity}_display`, '/synthetic/private/project', legacyEventId, `${identity}_session`, `${identity}_hash`, 'Existing source must remain intact']);

  const initialColumns = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'dream_capture_events'
  `);
  assert.equal(initialColumns.some(row => row.column_name === 'memory_ids_json'), false);
  assert.equal(initialColumns.some(row => row.column_name === 'acknowledged_at'), false);

  await client.initializeSchema();
  await client.initializeSchema();

  const migratedColumns = await client.query<{ column_name: string; column_default: string | null; is_nullable: string }>(`
    SELECT column_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'dream_capture_events'
  `);
  const memoryIdsColumn = migratedColumns.find(row => row.column_name === 'memory_ids_json');
  const acknowledgedColumn = migratedColumns.find(row => row.column_name === 'acknowledged_at');
  assert.ok(memoryIdsColumn, 'migration adds memory_ids_json');
  assert.match(memoryIdsColumn.column_default || '', /\[\]/);
  assert.equal(memoryIdsColumn.is_nullable, 'NO');
  assert.ok(acknowledgedColumn, 'migration adds acknowledged_at');
  assert.equal(acknowledgedColumn.is_nullable, 'YES');
  const legacyRows = await client.query<{ content_redacted: string; status: string; capture_sequence: string; legacy_annotation: string; memory_ids_json: string; acknowledged_at: Date | null }>(`
    SELECT content_redacted, status, capture_sequence, legacy_annotation, memory_ids_json, acknowledged_at
    FROM dream_capture_events WHERE tenant_id = $1 AND project_id = $2 AND event_id = $3
  `, [identity, `${identity}_project`, legacyEventId]);
  assert.equal(legacyRows.length, 1, 'existing row remains present after both initialization passes');
  assert.equal(legacyRows[0].content_redacted, 'Existing source must remain intact');
  assert.equal(legacyRows[0].status, 'processed');
  assert.ok(Number(legacyRows[0].capture_sequence) > 0, 'existing row receives a capture sequence');
  assert.equal(legacyRows[0].legacy_annotation, 'preserve-this-custom-value');
  assert.equal(legacyRows[0].memory_ids_json, '[]');
  assert.equal(legacyRows[0].acknowledged_at, null);

  const customObjects = await client.query<{ index_name: string; trigger_name: string }>(`
    SELECT
      (SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'legacy_capture_annotation_idx') AS index_name,
      (SELECT trigger_row.tgname
       FROM pg_trigger AS trigger_row
       JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
       WHERE table_row.relname = 'dream_capture_events'
         AND trigger_row.tgname = 'legacy_capture_migration_audit_trigger'
         AND NOT trigger_row.tgisinternal) AS trigger_name
  `);
  assert.equal(customObjects[0].index_name, 'legacy_capture_annotation_idx');
  assert.equal(customObjects[0].trigger_name, 'legacy_capture_migration_audit_trigger');
  await client.query('UPDATE dream_capture_events SET legacy_annotation = $1 WHERE tenant_id = $2 AND project_id = $3 AND event_id = $4', [
    'custom-trigger-still-runs', identity, `${identity}_project`, legacyEventId,
  ]);
  const auditRows = await client.query<{ event_id: string; annotation: string }>(
    'SELECT event_id, annotation FROM legacy_capture_migration_audit WHERE event_id = $1', [legacyEventId],
  );
  assert.deepEqual(auditRows, [{ event_id: legacyEventId, annotation: 'custom-trigger-still-runs' }]);

  // Exercise the real capture/replay path against this migrated legacy table.
  const factoryPath = path.resolve(import.meta.dirname, '../../src/database/factory.js');
  mock.module(factoryPath, { namedExports: { createDatabaseAdapter: () => client } });
  const { authStorage } = await import('../../src/utils/context.js');
  const { DreamCaptureStore } = await import('../../src/services/dreamCaptureStore.js');
  const event = {
    eventId: `${identity}_new`,
    sessionId: `${identity}_new_session`,
    actorRole: 'USER' as const,
    project: `${identity}_project`,
    content: 'A synthetic legacy-schema capture reaches durable storage.',
  };
  const stored = await authStorage.run({ uid: identity, tier: 'enterprise', keyId: 'synthetic' }, () => DreamCaptureStore.accept(event));
  assert.equal(stored.status, 'stored');
  assert.equal(stored.persisted, true);
  assert.equal(stored.acknowledged, true);
  const replay = await authStorage.run({ uid: identity, tier: 'enterprise', keyId: 'synthetic' }, () => DreamCaptureStore.accept(event));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.event_id, event.eventId);
  assert.equal(replay.acknowledged, true);
  const capturedRows = await client.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM dream_capture_events WHERE tenant_id = $1 AND project_id = $2 AND event_id = $3',
    [identity, `${identity}_project`, event.eventId],
  );
  assert.equal(Number(capturedRows[0].count), 1, 'replay does not duplicate the persisted capture');
});
