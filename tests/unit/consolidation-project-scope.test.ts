import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const scratch = await mkdtemp(join(tmpdir(), 'codeatlas-consolidation-project-scope-'));
const adapterModule = await import('../../src/database/adapters/sqliteAdapter.js');
const { authStorage } = await import('../../src/utils/context.js');
const adapter = new adapterModule.SQLiteAdapter(join(scratch, 'scope.sqlite'));
await adapter.initialize();

const srcDir = resolve(import.meta.dirname, '../../src');
mock.module(join(srcDir, 'database/factory.js'), {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module(join(srcDir, 'services/embeddingService.js'), {
  namedExports: { generateEmbeddingsBatch: async () => [[0.1, 0.2, 0.3]] },
});
mock.module(join(srcDir, 'services/dreamingService.js'), {
  namedExports: {
    DreamingService: {
      _hasLifecycleColumns: true,
      calcInitialConfidence: () => 0.7,
    },
  },
});
mock.module(join(srcDir, 'utils/logger.js'), {
  namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
});
const { ConsolidationEngine } = await import('../../src/services/consolidationEngine.js');

function embedding(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

after(async () => {
  await adapter.close();
  await rm(scratch, { recursive: true, force: true });
});

test('canonical scheduled consolidation leaves same-alias and unowned rows untouched', async () => {
  const tenantId = 'synthetic-tenant';
  const projectId = 'synthetic-canonical-project';
  const displayProject = 'synthetic-display-alias';
  const memoryRows = [
    ['selected-duplicate-a', projectId, [1, 0]],
    ['selected-duplicate-b', projectId, [1, 0]],
    ['selected-orthogonal', projectId, [0, 1]],
    ['selected-opposite', projectId, [-1, 0]],
    ['other-duplicate-a', 'other-canonical-project', [1, 0]],
    ['other-duplicate-b', 'other-canonical-project', [1, 0]],
    ['ambiguous-duplicate-a', null, [1, 0]],
    ['ambiguous-duplicate-b', null, [1, 0]],
  ] as const;
  for (const [id, canonicalId, vector] of memoryRows) {
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory
        (id, tenant_id, project, project_id, memory_type, content, embedding, importance, confidence, status, created_at)
       VALUES (:id, :tenantId, :project, :projectId, 'KNOWLEDGE', :content, :embedding, 7, 0.2, 'active', '2026-10-19T09:00:00.000Z')`,
      {
        id,
        tenantId,
        project: displayProject,
        projectId: canonicalId,
        content: `synthetic content ${id}`,
        embedding: embedding([...vector]),
      },
    );
  }

  for (const [id, canonicalId] of [
    ['selected-concept', projectId],
    ['other-concept', 'other-canonical-project'],
    ['ambiguous-concept', null],
  ] as const) {
    await adapter.execute(
      `INSERT INTO codeatlas_concepts
        (id, label, description, category, project, project_id, confidence, evidence_count, status, tenant_id)
       VALUES (:id, 'synthetic', 'synthetic', 'KNOWLEDGE', :project, :projectId, 0.1, 20, 'active', :tenantId)`,
      { id, project: displayProject, projectId: canonicalId, tenantId },
    );
  }

  const engine = new ConsolidationEngine();
  const report = await authStorage.run(
    { uid: tenantId, tier: 'enterprise' },
    () => engine.run({
      project: displayProject,
      projectId,
      operations: ['dedup', 'extract_concepts', 'score', 'score_dreams'],
      runAt: '2026-10-19T09:00:00.000Z',
    }),
  );

  assert.equal(report.status, 'completed');
  assert.equal(report.dreamsMerged, 1);
  assert.equal(report.dreamsProcessed, 4);
  const memories = await adapter.query<{ id: string; project_id: string | null; confidence: number; status: string }>(
    `SELECT id, project_id, confidence, status FROM ai_dreaming_memory WHERE tenant_id = :tenantId`,
    { tenantId },
  );
  assert.equal(memories.filter((row) => row.project_id === 'other-canonical-project').length, 2);
  assert.equal(memories.filter((row) => row.project_id === null).length, 2);
  assert.ok(memories.filter((row) => row.project_id === 'other-canonical-project' || row.project_id === null)
    .every((row) => row.confidence === 0.2 && row.status === 'active'));
  const selectedMemories = memories.filter((row) => row.project_id === projectId);
  assert.equal(selectedMemories.length, 4);
  assert.equal(selectedMemories.filter((row) => row.status === 'active').length, 3);
  assert.equal(selectedMemories.filter((row) => row.status === 'merged').length, 1);
  assert.ok(selectedMemories.filter((row) => row.status === 'active')
    .every((row) => Math.abs(row.confidence - 0.7) < 0.000001));

  const concepts = await adapter.query<{ id: string; project_id: string | null; confidence: number }>(
    `SELECT id, project_id, confidence FROM codeatlas_concepts WHERE tenant_id = :tenantId`,
    { tenantId },
  );
  assert.equal(concepts.find((row) => row.id === 'selected-concept')?.confidence, 0.5 + 0.49 * (1 - Math.exp(-0.2 * 20)));
  assert.equal(concepts.find((row) => row.id === 'other-concept')?.confidence, 0.1);
  assert.equal(concepts.find((row) => row.id === 'ambiguous-concept')?.confidence, 0.1);
  assert.equal(concepts.filter((row) => row.project_id === projectId).length, 2);
  assert.equal(concepts.filter((row) => row.project_id === 'other-canonical-project').length, 1);
  assert.equal(concepts.filter((row) => row.project_id === null).length, 1);
});

test('legacy concept tables gain nullable project identity without losing rows or custom indexes', async () => {
  const legacyPath = join(scratch, 'legacy-concepts.sqlite');
  const legacyDb = new Database(legacyPath);
  legacyDb.exec(`
    CREATE TABLE codeatlas_concepts (
      id TEXT PRIMARY KEY,
      label TEXT,
      description TEXT,
      category TEXT,
      embedding BLOB,
      project TEXT,
      confidence REAL DEFAULT 0.5,
      source_ids TEXT,
      evidence_count INTEGER DEFAULT 1,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      tenant_id TEXT NOT NULL
    );
    CREATE INDEX retained_legacy_concept_project ON codeatlas_concepts(project, tenant_id);
    INSERT INTO codeatlas_concepts (id, label, description, category, project, confidence, source_ids, evidence_count, tenant_id)
    VALUES ('legacy-concept', 'legacy label', 'legacy description', 'KNOWLEDGE', 'legacy-display', 0.42, '[]', 3, 'legacy-tenant');
  `);
  legacyDb.close();

  const legacyAdapter = new adapterModule.SQLiteAdapter(legacyPath);
  await legacyAdapter.initialize();
  try {
    const rows = await legacyAdapter.query<{
      id: string; label: string; description: string; project: string; project_id: string | null; confidence: number; evidence_count: number; tenant_id: string;
    }>(`SELECT id, label, description, project, project_id, confidence, evidence_count, tenant_id FROM codeatlas_concepts WHERE id = :id`, { id: 'legacy-concept' });
    assert.deepEqual(rows, [{
      id: 'legacy-concept', label: 'legacy label', description: 'legacy description', project: 'legacy-display',
      project_id: null, confidence: 0.42, evidence_count: 3, tenant_id: 'legacy-tenant',
    }]);
    const indexes = await legacyAdapter.query<{ name: string }>(`PRAGMA index_list(codeatlas_concepts)`);
    assert.ok(indexes.some((index) => index.name === 'retained_legacy_concept_project'));
  } finally {
    await legacyAdapter.close();
  }
});
