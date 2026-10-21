import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { authStorage } from '../../src/utils/context.js';

let adapter: SQLiteAdapter;
mock.module('../../src/database/factory.js', { namedExports: { createDatabaseAdapter: () => adapter } });
const { DreamProjectIdentityService } = await import('../../src/services/dreamProjectIdentityService.js');

const tenant = { uid: 'tenant-project-identity', tier: 'enterprise', keyId: 'test-key' };

beforeEach(async () => {
  adapter = new SQLiteAdapter(':memory:');
  await adapter.initialize();
});

afterEach(async () => {
  await adapter.disconnect();
  mock.restoreAll();
});

test('registers tenant-scoped aliases exactly without merging same-basename repositories', async () => {
  const first = await authStorage.run(tenant, () => DreamProjectIdentityService.register({
    projectId: 'git-common-hash-a',
    displayName: 'service',
    workspacePath: '/work/alpha/service',
  }));
  const second = await authStorage.run(tenant, () => DreamProjectIdentityService.register({
    projectId: 'git-common-hash-b',
    displayName: 'service',
    workspacePath: '/work/beta/service',
    aliases: ['service'],
  }));
  await authStorage.run(tenant, () => DreamProjectIdentityService.register({
    projectId: 'git-common-hash-b',
    displayName: 'service',
    workspacePath: '/work/beta/service',
    aliases: ['service'],
  }));

  assert.deepEqual(first.collisions, []);
  assert.deepEqual(second.collisions, [{ alias: 'service', existingProjectId: 'git-common-hash-a' }]);
  assert.deepEqual(await authStorage.run(tenant, () => DreamProjectIdentityService.getAliases('git-common-hash-a')), ['/work/alpha/service', 'service']);
  assert.deepEqual(await authStorage.run(tenant, () => DreamProjectIdentityService.getAliases('git-common-hash-b')), ['/work/beta/service']);
  assert.deepEqual(await adapter.query<{ alias: string; requested_project_id: string; existing_project_id: string }>(
    'SELECT alias, requested_project_id, existing_project_id FROM dream_project_alias_audit',
  ), [{ alias: 'service', requested_project_id: 'git-common-hash-b', existing_project_id: 'git-common-hash-a' }]);
});

test('the same alias is isolated by tenant and slash normalization is stable', async () => {
  const otherTenant = { ...tenant, uid: 'tenant-project-identity-other' };
  const first = await authStorage.run(tenant, () => DreamProjectIdentityService.register({
    projectId: 'project-a', workspacePath: 'C:\\work\\repo\\',
  }));
  const other = await authStorage.run(otherTenant, () => DreamProjectIdentityService.register({
    projectId: 'project-b', workspacePath: 'C:/work/repo',
  }));

  assert.deepEqual(first.collisions, []);
  assert.deepEqual(other.collisions, []);
  assert.deepEqual(await authStorage.run(tenant, () => DreamProjectIdentityService.getAliases('project-a')), ['C:/work/repo']);
  assert.deepEqual(await authStorage.run(otherTenant, () => DreamProjectIdentityService.getAliases('project-b')), ['C:/work/repo']);
});
