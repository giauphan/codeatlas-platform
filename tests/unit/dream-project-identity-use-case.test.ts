import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DreamProjectIdentityUseCase } from '../../src/services/dreamProjectIdentityUseCase.js';

test('identity policy uses its tenant-scoped repository port and treats an empty owner ID as present', async () => {
  const tenantId = 'tenant-policy-test';
  const operations: Array<{ kind: string; tenantId: string; alias?: string; projectId?: string }> = [];
  const repository = {
    async addAlias(input: { tenantId: string; alias: string; projectId: string; displayName: string | null; workspacePath: string | null }) {
      operations.push({ kind: 'add', tenantId: input.tenantId, alias: input.alias, projectId: input.projectId });
    },
    async findAliasProjectId(requestTenantId: string, alias: string) {
      operations.push({ kind: 'find', tenantId: requestTenantId, alias });
      return '';
    },
    async recordCollision(input: { tenantId: string; alias: string; requestedProjectId: string; existingProjectId: string }) {
      operations.push({ kind: 'collision', tenantId: input.tenantId, alias: input.alias, projectId: input.requestedProjectId });
    },
    async listAliases(requestTenantId: string, projectId: string) {
      operations.push({ kind: 'list', tenantId: requestTenantId, projectId });
      return ['known-alias'];
    },
  };
  const useCase = new DreamProjectIdentityUseCase(() => repository);
  const result = await useCase.register(tenantId, { projectId: ' requested-id ', aliases: ['legacy'] });

  assert.deepEqual(result, {
    projectId: 'requested-id',
    aliases: [],
    collisions: [{ alias: 'legacy', existingProjectId: '' }],
  });
  assert.deepEqual(await useCase.getAliases(tenantId, ''), ['known-alias']);
  assert.deepEqual(operations.map(({ kind, tenantId: scopedTenantId, alias, projectId }) => ({ kind, tenantId: scopedTenantId, alias, projectId })), [
    { kind: 'add', tenantId, alias: 'legacy', projectId: 'requested-id' },
    { kind: 'find', tenantId, alias: 'legacy', projectId: undefined },
    { kind: 'collision', tenantId, alias: 'legacy', projectId: 'requested-id' },
    { kind: 'list', tenantId, alias: undefined, projectId: '' },
  ]);
});
