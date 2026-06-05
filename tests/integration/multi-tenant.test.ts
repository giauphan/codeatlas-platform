import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { authStorage } from '../src/context.js';
import { discoverProjects, loadAnalysis } from '../index.js';
import { OracleMemoryService } from '../src/oracleDatabase.js';

describe('SaaS Multi-Tenancy Security & VPD Integration', () => {
  const mockTenantRoot = path.join(process.cwd(), 'tests', 'mock_tenants');
  const tenant1Id = 'tenant_user_1';
  const tenant2Id = 'tenant_user_2';

  // Backups of environment variables
  const originalMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
  const originalProjectsRoot = process.env.CODEATLAS_PROJECTS_ROOT;

  before(() => {
    // Enable Multi-Tenant mode for testing
    process.env.CODEATLAS_MULTI_TENANT = 'true';
    process.env.CODEATLAS_PROJECTS_ROOT = mockTenantRoot;

    // Create directories for Tenant 1
    const tenant1Dir = path.join(mockTenantRoot, tenant1Id, 'project_a');
    fs.mkdirSync(path.join(tenant1Dir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(
      path.join(tenant1Dir, '.codeatlas', 'analysis.json'),
      JSON.stringify({ projectName: 'project_a', totalFilesAnalyzed: 5, graph: { nodes: [], links: [] } })
    );

    // Create directories for Tenant 2
    const tenant2Dir = path.join(mockTenantRoot, tenant2Id, 'project_b');
    fs.mkdirSync(path.join(tenant2Dir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(
      path.join(tenant2Dir, '.codeatlas', 'analysis.json'),
      JSON.stringify({ projectName: 'project_b', totalFilesAnalyzed: 12, graph: { nodes: [], links: [] } })
    );
  });

  after(() => {
    // Restore environment variables
    process.env.CODEATLAS_MULTI_TENANT = originalMultiTenant;
    process.env.CODEATLAS_PROJECTS_ROOT = originalProjectsRoot;

    // Clean up mock directories
    if (fs.existsSync(mockTenantRoot)) {
      fs.rmSync(mockTenantRoot, { recursive: true, force: true });
    }
  });

  test('should guarantee complete context isolation under concurrent async loops', async () => {
    const runScope = (uid: string, tier: string) => {
      return new Promise<void>((resolve) => {
        authStorage.run({ uid, tier, keyId: `key_${uid}` }, async () => {
          // Delay to simulate database or system async hops
          await new Promise((r) => setTimeout(r, Math.random() * 50));
          const currentStore = authStorage.getStore();
          
          assert.ok(currentStore, 'Async context store must be populated');
          assert.strictEqual(currentStore.uid, uid, `UID should match ${uid}`);
          assert.strictEqual(currentStore.tier, tier, `Tier should match ${tier}`);
          resolve();
        });
      });
    };

    // Run multiple scopes concurrently
    await Promise.all([
      runScope(tenant1Id, 'pro'),
      runScope(tenant2Id, 'free'),
      runScope('admin', 'enterprise'),
      runScope('tenant_user_3', 'plus')
    ]);
  });

  test('should filter project discovery strictly by tenant ID in Multi-Tenant mode', () => {
    // Discover projects for Tenant 1
    const projectsT1 = discoverProjects(tenant1Id);
    assert.strictEqual(projectsT1.length, 1);
    assert.strictEqual(projectsT1[0].name, 'project_a');

    // Discover projects for Tenant 2
    const projectsT2 = discoverProjects(tenant2Id);
    assert.strictEqual(projectsT2.length, 1);
    assert.strictEqual(projectsT2[0].name, 'project_b');

    // Discover projects for an non-existent tenant
    const projectsT3 = discoverProjects('tenant_non_existent');
    assert.strictEqual(projectsT3.length, 0);

    // Discover projects with missing or empty tenantId in multi-tenant mode -> should return [] to prevent leaks
    const projectsLeakCheck = discoverProjects(undefined);
    assert.strictEqual(projectsLeakCheck.length, 0, 'Must return empty array to prevent leaks when tenantId is missing');
  });

  test('should load analysis securely based on the request context', () => {
    // Simulate Tenant 1 request
    authStorage.run({ uid: tenant1Id, tier: 'pro', keyId: 'key_1' }, () => {
      const loaded = loadAnalysis('project_a');
      assert.ok(loaded, 'Tenant 1 should successfully load project_a');
      assert.strictEqual(loaded.projectName, 'project_a');

      // Tenant 1 should not be able to load Tenant 2's project_b
      const loadedB = loadAnalysis('project_b');
      assert.strictEqual(loadedB, null, 'Tenant 1 must not be allowed to load Tenant 2 analysis data');
    });

    // Simulate Tenant 2 request
    authStorage.run({ uid: tenant2Id, tier: 'free', keyId: 'key_2' }, () => {
      const loaded = loadAnalysis('project_b');
      assert.ok(loaded, 'Tenant 2 should successfully load project_b');
      assert.strictEqual(loaded.projectName, 'project_b');

      // Tenant 2 should not be able to load Tenant 1's project_a
      const loadedA = loadAnalysis('project_a');
      assert.strictEqual(loadedA, null, 'Tenant 2 must not be allowed to load Tenant 1 analysis data');
    });
  });

  test('should execute Oracle VPD context bindings correctly based on active tenant store', async () => {
    // Define a spy connection object to capture executions
    let executedSql: string | null = null;
    let executedParams: any = null;

    const mockConnection = {
      execute: async (sql: string, params?: any) => {
        executedSql = sql;
        executedParams = params;
        return { rows: [] };
      }
    };

    // Helper method to retrieve private VPD binding execution
    const testVpdBinding = async (uid: string | undefined, expectedTenant: string) => {
      executedSql = null;
      executedParams = null;

      const runTest = async () => {
        // Access private setSessionContext using type-casting
        const service = OracleMemoryService as any;
        if (typeof service.setSessionContext === 'function') {
          await service.setSessionContext(mockConnection);
        }
      };

      if (uid) {
        await authStorage.run({ uid, tier: 'pro', keyId: 'test_key' }, runTest);
      } else {
        await runTest();
      }

      assert.ok(executedSql, 'VPD Context script should be executed');
      const sqlStr = executedSql as string;
      assert.ok(sqlStr.includes('ADMIN.codeatlas_ctx_pkg.set_tenant'), 'VPD query must call context package');
      assert.deepStrictEqual(executedParams, { tenantId: expectedTenant });
    };

    // Test 1: Tenant user active
    await testVpdBinding(tenant1Id, tenant1Id);

    // Test 2: Admin user active
    await testVpdBinding('admin', 'admin');

    // Test 3: No active store context (falls back to admin)
    await testVpdBinding(undefined, 'admin');
  });
});
