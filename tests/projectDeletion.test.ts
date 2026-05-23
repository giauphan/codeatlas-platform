import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app, firebaseClient } from '../src/presentation/httpServer.js';
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

  test('should abort deletion and preserve local files if remote DB cleanup fails', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];

    // Temporarily make deleteProjectMemory throw an error
    mock.restoreAll();
    mock.method(OracleMemoryService, 'deleteProjectMemory', async (project: string, tenantId?: string) => {
      throw new Error('Oracle DB connection lost');
    });

    const handler = getDeleteHandler();
    const projBDir = path.join(mockTenantRoot, 'tenant1', 'projectB');
    process.env.CODEATLAS_PROJECT_DIR = projBDir;

    const reqB: any = {
      query: {
        projectDir: projBDir
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

    const auth = { uid: 'admin', role: 'admin', tier: 'enterprise', keyId: 'mock-key', email: 'admin@genrostore.com' };
    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqB, resB, () => {});
        resolve();
      });
    });

    assert.strictEqual(resB.statusCode, 500);
    assert.strictEqual(resB.jsonData.success, false);
    assert.match(resB.jsonData.error, /Remote cleanup failure/);

    // Verify .codeatlas and projectB still exist locally because deletion was deferred
    assert.strictEqual(fs.existsSync(path.join(projBDir, '.codeatlas')), true);
    assert.strictEqual(fs.existsSync(projBDir), true);

    // Restore original mock
    mock.restoreAll();
    mock.method(OracleMemoryService, 'deleteProjectMemory', async (project: string, tenantId?: string) => {
      deleteProjectMemoryCalls.push({ project, tenantId });
    });

    delete process.env.CODEATLAS_PROJECT_DIR;
    cleanupDirectories();
  });

  test('should handle symlink project directories and symlink .codeatlas securely without traversing outside sandbox', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];

    // Create a project directory that is a symlink to another directory inside sandbox
    const sourceDir = path.join(mockTenantRoot, 'tenant1', 'sourceProject');
    if (fs.existsSync(sourceDir)) {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(sourceDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '.codeatlas', 'analysis.json'), '{}');
    fs.writeFileSync(path.join(sourceDir, 'config.json'), '{}');

    // Create a symlink named projectSymlink pointing to sourceProject
    const symlinkDir = path.join(mockTenantRoot, 'tenant1', 'projectSymlink');
    if (fs.existsSync(symlinkDir)) {
      fs.unlinkSync(symlinkDir);
    }
    fs.symlinkSync(sourceDir, symlinkDir);

    const handler = getDeleteHandler();
    process.env.CODEATLAS_PROJECT_DIR = symlinkDir;

    const reqSym: any = {
      query: {
        projectDir: symlinkDir
      }
    };
    const resSym: any = {
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
        await handler(reqSym, resSym, () => {});
        resolve();
      });
    });

    assert.strictEqual(resSym.statusCode, 200);
    assert.strictEqual(resSym.jsonData.success, true);

    // The symlink file itself should be unlinked/removed
    assert.strictEqual(fs.existsSync(symlinkDir), false);

    // The target sourceProject directory's .codeatlas directory should be deleted,
    // but the sourceProject itself should NOT be deleted because it is not empty (it has config.json)
    assert.strictEqual(fs.existsSync(path.join(sourceDir, '.codeatlas')), false);
    assert.strictEqual(fs.existsSync(sourceDir), true);
    assert.strictEqual(fs.existsSync(path.join(sourceDir, 'config.json')), true);

    delete process.env.CODEATLAS_PROJECT_DIR;
    cleanupDirectories();
  });

  test('should reject deletion if symlink points outside the tenant sandbox root', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];

    // Create a directory outside mockTenantRoot (e.g. in siblingTenantRoot)
    const outsideDir = path.join(siblingTenantRoot, 'outsideProject');
    if (fs.existsSync(outsideDir)) {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(outsideDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, '.codeatlas', 'analysis.json'), '{}');

    // Create a symlink in mockTenantRoot pointing to outsideDir
    const symlinkDir = path.join(mockTenantRoot, 'tenant1', 'badSymlink');
    if (fs.existsSync(symlinkDir)) {
      fs.unlinkSync(symlinkDir);
    }
    fs.symlinkSync(outsideDir, symlinkDir);

    const handler = getDeleteHandler();
    process.env.CODEATLAS_PROJECT_DIR = symlinkDir;

    const reqSym: any = {
      query: {
        projectDir: symlinkDir
      }
    };
    const resSym: any = {
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

    // Even admin/tenant users should be rejected if the target is outside the tenant root sandbox
    const auth = { uid: 'tenant1', role: 'user', tier: 'enterprise', keyId: 'mock-key', email: 'user@tenant1.com' };
    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqSym, resSym, () => {});
        resolve();
      });
    });

    assert.strictEqual(resSym.statusCode, 403);
    assert.match(resSym.jsonData.error, /outside the tenant root sandbox/);

    // Verify target outside directory is intact
    assert.strictEqual(fs.existsSync(path.join(outsideDir, '.codeatlas')), true);

    delete process.env.CODEATLAS_PROJECT_DIR;
    cleanupDirectories();
  });

  test('should handle double-dot-prefixed directory names inside the sandbox safely', async () => {
    const dotDotDir = path.join(mockTenantRoot, 'tenant1', '..projectA');
    if (fs.existsSync(dotDotDir)) {
      fs.rmSync(dotDotDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(dotDotDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(dotDotDir, '.codeatlas', 'analysis.json'), '{}');

    const handler = getDeleteHandler();
    process.env.CODEATLAS_PROJECT_DIR = dotDotDir;

    const reqDot: any = {
      query: {
        projectDir: dotDotDir
      }
    };
    const resDot: any = {
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

    const auth = { uid: 'tenant1', role: 'user', tier: 'enterprise', keyId: 'mock-key', email: 'user@tenant1.com' };
    await new Promise<void>((resolve) => {
      authStorage.run(auth, async () => {
        await handler(reqDot, resDot, () => {});
        resolve();
      });
    });

    assert.strictEqual(resDot.statusCode, 200);
    assert.strictEqual(resDot.jsonData.success, true);
    assert.strictEqual(fs.existsSync(dotDotDir), false);

    delete process.env.CODEATLAS_PROJECT_DIR;
    cleanupDirectories();
  });

  test('should skip project unregistration if local cleanup fails', async () => {
    setupDirectories();
    deleteProjectMemoryCalls = [];

    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    const regPath = path.join(configDir, "registered_projects.json");
    
    let originalContent: string | null = null;
    if (fs.existsSync(regPath)) {
      originalContent = fs.readFileSync(regPath, "utf-8");
    }

    const handler = getDeleteHandler();
    const projBDir = path.join(mockTenantRoot, 'tenant1', 'projectB');
    process.env.CODEATLAS_PROJECT_DIR = projBDir;

    const dummyProjects = [path.resolve(projBDir), "/mock/path/projC"];
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(regPath, JSON.stringify(dummyProjects, null, 2));

    const originalRm = fs.promises.rm;
    fs.promises.rm = async () => {
      throw new Error("Simulated filesystem cleanup failure");
    };

    try {
      const reqB: any = {
        query: {
          projectDir: projBDir
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

      const auth = { uid: 'admin', role: 'admin', tier: 'enterprise', keyId: 'mock-key', email: 'admin@genrostore.com' };
      await new Promise<void>((resolve) => {
        authStorage.run(auth, async () => {
          await handler(reqB, resB, () => {});
          resolve();
        });
      });

      assert.strictEqual(resB.statusCode, 500);
      assert.match(resB.jsonData.error, /Local cleanup or unregistration failure/);

      const updatedData = fs.readFileSync(regPath, "utf-8");
      const updatedList = JSON.parse(updatedData);
      assert.ok(updatedList.includes(path.resolve(projBDir)), 'Project should remain registered on failure');
    } finally {
      fs.promises.rm = originalRm;
      if (originalContent !== null) {
        fs.writeFileSync(regPath, originalContent);
      } else if (fs.existsSync(regPath)) {
        fs.unlinkSync(regPath);
      }
      delete process.env.CODEATLAS_PROJECT_DIR;
      cleanupDirectories();
    }
  });

  test('should securely clean up legacy unscoped Firestore document if matching tenant or unclaimed', async () => {
    const mockApp = {} as any;
    mock.method(firebaseClient, 'getApps', () => [mockApp]);

    const deletedDocs: string[] = [];
    const mockLegacyDoc = {
      exists: true,
      data: () => ({ tenantId: 'tenant1' })
    };

    const mockDb = {
      collection: (colName: string) => {
        assert.strictEqual(colName, 'projects');
        return {
          doc: (docId: string) => {
            return {
              get: async () => {
                if (docId === 'projectB') {
                  return mockLegacyDoc;
                }
                return { exists: false };
              },
              delete: async () => {
                deletedDocs.push(docId);
              }
            };
          }
        };
      }
    } as any;

    mock.method(firebaseClient, 'getFirestore', () => mockDb);

    try {
      setupDirectories();
      const handler = getDeleteHandler();
      const projBDir = path.join(mockTenantRoot, 'tenant1', 'projectB');
      process.env.CODEATLAS_PROJECT_DIR = projBDir;

      const reqB: any = {
        query: {
          projectDir: projBDir
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

      const auth = { uid: 'tenant1', role: 'user', tier: 'enterprise', keyId: 'mock-key', email: 'user@tenant1.com' };
      await new Promise<void>((resolve) => {
        authStorage.run(auth, async () => {
          await handler(reqB, resB, () => {});
          resolve();
        });
      });

      assert.strictEqual(resB.statusCode, 200);
      assert.strictEqual(resB.jsonData.success, true);

      assert.ok(deletedDocs.includes('tenant1_projectB'));
      assert.ok(deletedDocs.includes('projectB'));
    } finally {
      mock.restoreAll();
      mock.method(OracleMemoryService, 'deleteProjectMemory', async (project: string, tenantId?: string) => {
        deleteProjectMemoryCalls.push({ project, tenantId });
      });
      delete process.env.CODEATLAS_PROJECT_DIR;
      cleanupDirectories();
    }
  });
});

