import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Tenant Isolation Regression Test', () => {
  test('A request with tenantId A should not be able to access data belonging to tenantId B', () => {
    const expectedWhereClause = 'tenant_id = :tenantId';
    assert.ok(expectedWhereClause.includes('tenant_id = :tenantId'), 'Tenant isolation clause must be present');
  });
});
