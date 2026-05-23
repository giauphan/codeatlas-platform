import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { app } from '../src/presentation/httpServer.js';
import { authStorage } from '../src/context.js';
import { OracleMemoryService } from '../src/oracleDatabase.js';

describe('Project Deletion and Tenant Sandbox Cleanup', () => {
  const mockTenantRoot = path.resolve(path.join(process.cwd(), 'tests', 'mock_tenants'));
  const siblingTenantRoot = path.resolve(path.join(process.cwd(), 'tests', 'mock_tenants_backup'));
  
  let originalMultiTenant: string | undefined;
  let originalProjectsRoot: string | undefined;
  let originalOracleConn: string | undefined;
  let deleteProjectMemoryCalls: any[] = [];

  before(() => {
    originalMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
    originalProjectsRoot = process.env.CODEATLAS_PROJECTS_ROOT;
    originalOracleConn = process.env.ORACLE_CONN_STRING;

    process.env.CODEATLAS_MULTI_TENANT = 'true';
    process.env.CODEATLAS_PROJECTS_ROOT = mockTenantRoot;
    process.env.ORACLE_CONN_STRING = 'mock-connection-string';

    // Mock OracleMemoryService.deleteProjectMemory to record calls
    mock.method(OracleMemoryService, 'deleteProjectMemory', async (project: string, tenantId?: string) => {
      deleteProjectMemoryCalls.push({ project, tenantId });
    });
  });

  after(() => {
    process.env.CODEATLAS_MULTI_TENANT = originalMultiTenant;
    process.env.CODEATLAS_PROJECTS_ROOT = originalProjectsRoot;
    process.env.ORACLE_CONN_STRING = originalOracleConn;
    mock.restoreAll();
  });

  function setupDirectories() {
    // Clean up first
    if (fs.existsSync(mockTenantRoot)) {
      fs.rmSync(mockTenantRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(siblingTenantRoot)) {
      fs.rmSync(siblingTenantRoot, { recursive: true, force: true });
    }

    // Create directories
    // 1. Tenant 1 - Project A (has source files)
    const projADir = path.join(mockTenantRoot, 'tenant1', 'projectA');
    fs.mkdirSync(path.join(projADir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(projADir, '.codeatlas', 'analysis.json'), '{}');
    fs.writeFileSync(path.join(projADir, 'main.ts'), 'console.log("hello");');

    // 2. Tenant 1 - Project B (empty, only .codeatlas)
    const projBDir = path.join(mockTenantRoot, 'tenant1', 'projectB');
    fs.mkdirSync(path.join(projBDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(projBDir, '.codeatlas', 'analysis.json'), '{}');

    // 3. Sibling folder matching prefix (to test path-boundary vulnerability)
    const siblingProjDir = path.join(siblingTenantRoot, 'tenant1', 'projectC');
    fs.mkdirSync(path.join(siblingProjDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(siblingProjDir, '.codeatlas', 'analysis.json'), '{}');
  }

  function cleanupDirectories() {
    if (fs.existsSync(mockTenantRoot)) {
      fs.rmSync(mockTenantRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(siblingTenantRoot)) {
      fs.rmSync(siblingTenantRoot, { recursive: true, force: true });
    }
  }

  function getDeleteHandler() {
    const deleteRoute = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/api/projects' && layer.route.methods.delete
    );
    if (!deleteRoute) throw new Error('DELETE /api/projects route not found');
    return deleteRoute.route.stack[deleteRoute.route.stack.length - 1].handle;
  }

  test('should delete empty project folder and preserve project with source files', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];
    
    const handler = getDeleteHandler();

    // Mock Express Request & Response for Project A
    const reqA: any = {
      query: {
        projectDir: path.join(mockTenantRoot, 'tenant1', 'projectA')
      }
    };
    const resA: any = {
      statusCode: 200,
      jsonData: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.jsonData = data;
        return this;
      }
    };

    // Run delete route handler
    const auth = { uid: 'admin', role: 'admin', tier: 'enterprise', keyId: 'mock-key', email: 'admin@genrostore.com' };
    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqA, resA, () => {});
        resolve();
      });
    });

    assert.strictEqual(resA.statusCode, 200);
    assert.strictEqual(resA.jsonData.success, true);

    // Verify .codeatlas directory inside projectA is deleted
    assert.strictEqual(fs.existsSync(path.join(mockTenantRoot, 'tenant1', 'projectA', '.codeatlas')), false);
    // Verify source files and projectA directory are preserved
    assert.strictEqual(fs.existsSync(path.join(mockTenantRoot, 'tenant1', 'projectA')), true);
    assert.strictEqual(fs.existsSync(path.join(mockTenantRoot, 'tenant1', 'projectA', 'main.ts')), true);

    // Verify derived owner tenant was propagated to Oracle
    assert.strictEqual(deleteProjectMemoryCalls.length, 1);
    assert.strictEqual(deleteProjectMemoryCalls[0].project, 'projectA');
    assert.strictEqual(deleteProjectMemoryCalls[0].tenantId, 'tenant1');

    // Now delete Project B (which is empty except for .codeatlas)
    const reqB: any = {
      query: {
        projectDir: path.join(mockTenantRoot, 'tenant1', 'projectB')
      }
    };
    const resB: any = {
      statusCode: 200,
      jsonData: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.jsonData = data;
        return this;
      }
    };

    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqB, resB, () => {});
        resolve();
      });
    });

    assert.strictEqual(resB.statusCode, 200);
    assert.strictEqual(resB.jsonData.success, true);

    // Verify Project B folder is completely removed since it had no other files
    assert.strictEqual(fs.existsSync(path.join(mockTenantRoot, 'tenant1', 'projectB')), false);
    assert.strictEqual(deleteProjectMemoryCalls.length, 2);
    assert.strictEqual(deleteProjectMemoryCalls[1].project, 'projectB');
    assert.strictEqual(deleteProjectMemoryCalls[1].tenantId, 'tenant1');

    cleanupDirectories();
  });

  test('should protect against path-boundary sibling prefix vulnerabilities', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];

    const handler = getDeleteHandler();

    const siblingProjDir = path.join(siblingTenantRoot, 'tenant1', 'projectC');
    process.env.CODEATLAS_PROJECT_DIR = siblingProjDir;

    const reqC: any = {
      query: {
        projectDir: siblingProjDir
      }
    };
    const resC: any = {
      statusCode: 200,
      jsonData: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.jsonData = data;
        return this;
      }
    };

    const auth = { uid: 'admin', role: 'admin', tier: 'enterprise', keyId: 'mock-key', email: 'admin@genrostore.com' };
    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqC, resC, () => {});
        resolve();
      });
    });

    assert.strictEqual(resC.statusCode, 200);
    assert.strictEqual(resC.jsonData.success, true);

    // Verify .codeatlas inside projectC was deleted
    assert.strictEqual(fs.existsSync(path.join(siblingProjDir, '.codeatlas')), false);
    // Verify the projectC directory itself was NOT deleted, even though it was empty, 
    // because it did not reside inside mockTenantRoot (sibling check / startsWith prevention)
    assert.strictEqual(fs.existsSync(siblingProjDir), true);

    delete process.env.CODEATLAS_PROJECT_DIR;
    cleanupDirectories();
  });
});
