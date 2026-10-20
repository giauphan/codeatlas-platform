import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
let embeddingAvailable = true;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => adapter } });
mock.module('../../src/services/embeddingService.js', {
  namedExports: { generateEmbedding: async () => embeddingAvailable ? [1, 0, 0] : null },
});
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { DreamProjectIdentityService } = await import('../../src/services/dreamProjectIdentityService.js');

const tenantA = { uid: 'retrieval-tenant-a', tier: 'enterprise', keyId: 'test-key' };
const tenantB = { uid: 'retrieval-tenant-b', tier: 'enterprise', keyId: 'test-key' };
const richContent = (name: string) => `${name} describes a useful authentication implementation detail that should survive retrieval filters.`;

beforeEach(async () => {
  embeddingAvailable = true;
  adapter = new SQLiteAdapter(':memory:');
  await adapter.initialize();
  DreamingService._hasContentHashColumn = null;
  DreamingService._hasLifecycleColumns = null;
  await DreamingService.initialize();
});

afterEach(async () => {
  await adapter.disconnect();
  mock.restoreAll();
});

test('tenant/project/type/provider/scope/tag filters happen before vector candidate limit', async () => {
  await authStorage.run(tenantA, async () => {
    await DreamProjectIdentityService.register({ projectId: 'canonical-target', displayName: 'target-app', workspacePath: '/work/target-app' });
    for (let index = 0; index < 20; index += 1) {
      await DreamingService.saveDreamMemoryWithAck({
        project: 'target-app', projectId: 'canonical-target', sessionId: `distractor-${index}`,
        memoryType: index % 2 === 0 ? 'PATTERN' : 'KNOWLEDGE', content: richContent(`distractor-${index}`), importance: 5,
        aiModel: 'wrong-provider', scope: 'other', tags: ['other'],
      });
    }
    await DreamingService.saveDreamMemoryWithAck({
      project: 'target-app', projectId: 'canonical-target', sessionId: 'wanted',
      memoryType: 'KNOWLEDGE', content: richContent('wanted-target'), importance: 5,
      aiModel: 'right-provider', scope: 'auth/login', tags: ['secure'],
    });
    await DreamingService.saveDreamMemoryWithAck({
      project: 'other-app', projectId: 'canonical-other', sessionId: 'other-tenant-project',
      memoryType: 'KNOWLEDGE', content: richContent('different-project'), importance: 5,
      aiModel: 'right-provider', scope: 'auth/login', tags: ['secure'],
    });
  });

  const result = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus(
    'target-app', 'authentication', 1, 0, 'KNOWLEDGE', 'right-provider', undefined, undefined, 'auth', ['secure'], 'canonical-target',
  ));

  assert.equal(result.retrieval_status, 'ok');
  assert.equal(result.candidate_count, 1);
  assert.equal(result.returned_count, 1);
  assert.match(String(result.memories[0].content), /wanted-target/);

  const otherTenantRows = await authStorage.run(tenantB, () => DreamingService.queryDreamMemoriesWithStatus(
    'target-app', 'authentication', 10, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'canonical-target',
  ));
  assert.deepEqual(otherTenantRows.memories, []);
  assert.equal(otherTenantRows.retrieval_status, 'empty');
});

test('an unavailable vector index falls back to lexical evidence without turning an empty project into backend_error', async () => {
  await authStorage.run(tenantA, () => DreamingService.saveDreamMemoryWithAck({ project: 'fallback', projectId: 'fallback-id', sessionId: 'fixture',
    memoryType: 'KNOWLEDGE', content: 'resolver.ts maps canonical worktree aliases while preserving tenant boundaries.', importance: 6 }));
  adapter.searchVectorScoped = async () => { throw new Error('simulated vector index outage'); };
  const found = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus('fallback', 'resolver.ts', 10, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'fallback-id'));
  assert.equal(found.retrieval_status, 'ok'); assert.equal(found.memories.length, 1);
  const empty = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus('empty-project', 'resolver.ts'));
  assert.equal(empty.retrieval_status, 'empty');
});

test('legacy rows containing credentials are redacted before retrieval without rewriting their audit source', async () => {
  embeddingAvailable = false;
  const secret = 'synthetic-legacy-secret';
  await adapter.execute(`INSERT INTO ai_dreaming_memory (id, tenant_id, project, memory_type, content, status)
    VALUES ('legacy-secret', :tenant, 'legacy', 'KNOWLEDGE', :content, 'active')`,
    { tenant: tenantA.uid, content: `resolver.ts documents offline authentication; api_key=${secret} must never enter a session context.` });
  const result = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus('legacy', 'resolver.ts'));
  assert.equal(result.retrieval_status, 'ok');
  assert.ok(!JSON.stringify(result.memories).includes(secret));
  assert.match(String(result.memories[0].content), /REDACTED/);
  const original = await adapter.query<{ content: string }>("SELECT content FROM ai_dreaming_memory WHERE id = 'legacy-secret'");
  assert.ok(original[0].content.includes(secret));
});

test('canonical project query dual-reads only unambiguous legacy aliases', async () => {
  await authStorage.run(tenantA, async () => {
    const identity = await DreamProjectIdentityService.register({ projectId: 'legacy-target-id', displayName: 'legacy-name', workspacePath: '/work/legacy-target' });
    const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, session_id, project, project_id, provider, memory_type, content, embedding, importance, tenant_id, scope, tags)
       VALUES (:id, :sessionId, :project, NULL, :provider, :memoryType, :content, :embedding, :importance, :tenantId, :scope, :tags)`,
      {
        id: 'legacy-memory', sessionId: 'legacy-session', project: '/work/legacy-target', provider: 'test',
        memoryType: 'KNOWLEDGE', content: richContent('legacy-alias'), embedding: vector, importance: 5,
        tenantId: tenantA.uid, scope: 'auth', tags: '["secure"]',
      },
    );
    assert.deepEqual(identity.collisions, []);
  });

  const result = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus(
    'legacy-name', 'authentication', 5, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'legacy-target-id',
  ));

  assert.equal(result.retrieval_status, 'ok');
  assert.equal(result.memories[0].id, 'legacy-memory');
});

test('canonical project retrieval ignores a legacy alias already owned by another project', async () => {
  await authStorage.run(tenantA, async () => {
    await DreamProjectIdentityService.register({ projectId: 'project-owner', displayName: 'shared-legacy-name' });
    const vector = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
    await adapter.execute(
      `INSERT INTO ai_dreaming_memory (id, session_id, project, project_id, provider, memory_type, content, embedding, importance, tenant_id, scope, tags)
       VALUES (:id, :sessionId, :project, NULL, :provider, :memoryType, :content, :embedding, :importance, :tenantId, :scope, :tags)`,
      {
        id: 'owned-legacy-memory', sessionId: 'legacy-session', project: 'shared-legacy-name', provider: 'test',
        memoryType: 'KNOWLEDGE', content: richContent('owned-by-other-project'), embedding: vector, importance: 5,
        tenantId: tenantA.uid, scope: 'auth', tags: '[]',
      },
    );
  });

  const result = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus(
    'shared-legacy-name', 'authentication', 5, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'project-requesting-alias',
  ));

  assert.equal(result.retrieval_status, 'empty');
  assert.equal(result.returned_count, 0);
});

test('embedding outage falls back to exact lexical path retrieval and reports no_match distinctly', async () => {
  await authStorage.run(tenantA, async () => {
    await DreamingService.saveDreamMemoryWithAck({
      project: 'repo', projectId: 'repo-id', sessionId: 'path-session', memoryType: 'KNOWLEDGE', importance: 6,
      content: 'The validated module path /src/security/auth-token.ts handles session renewal safely.',
    });
    await DreamingService.saveDreamMemoryWithAck({
      project: 'repo', projectId: 'repo-id', sessionId: 'other-session', memoryType: 'KNOWLEDGE', importance: 6,
      content: 'The unrelated database migration changes a stable index used by another feature area.',
    });
  });

  embeddingAvailable = false;
  const pathResult = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus(
    'repo', '/src/security/auth-token.ts', 5, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'repo-id',
  ));
  const noMatch = await authStorage.run(tenantA, () => DreamingService.queryDreamMemoriesWithStatus(
    'repo', 'missing-symbol-xyz', 5, 0, undefined, undefined, undefined, undefined, undefined, undefined, 'repo-id',
  ));

  assert.equal(pathResult.retrieval_status, 'ok');
  assert.equal(pathResult.memories.length, 1);
  assert.equal(noMatch.retrieval_status, 'no_match');
  assert.equal(noMatch.memories.length, 0);
});
