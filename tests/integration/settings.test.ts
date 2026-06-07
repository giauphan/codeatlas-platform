import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { app, firebaseClient } from '../../src/presentation/httpServer.js';
import { authStorage } from '../../src/utils/context.js';

describe('Project Settings REST API', () => {
  const mockTenantRoot = path.join(process.cwd(), 'tests', 'mock_settings_projects');
  const tenantId = 'tenant_settings_user';

  const originalMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
  const originalProjectsRoot = process.env.CODEATLAS_PROJECTS_ROOT;

  before(() => {
    process.env.CODEATLAS_MULTI_TENANT = 'true';
    process.env.CODEATLAS_PROJECTS_ROOT = mockTenantRoot;

    // Create a mock project for this tenant
    const projDir = path.join(mockTenantRoot, tenantId, 'my-project');
    fs.mkdirSync(path.join(projDir, '.codeatlas'), { recursive: true });
    // Write a minimal settings.json so isProjectDirectory recognizes the project
    fs.writeFileSync(path.join(projDir, '.codeatlas', 'settings.json'), JSON.stringify({}), 'utf-8');
  });

  after(() => {
    process.env.CODEATLAS_MULTI_TENANT = originalMultiTenant;
    process.env.CODEATLAS_PROJECTS_ROOT = originalProjectsRoot;

    if (fs.existsSync(mockTenantRoot)) {
      fs.rmSync(mockTenantRoot, { recursive: true, force: true });
    }
  });

  test('GET and POST settings endpoint routing & Happy Path', async () => {
    const getLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.get);
    const postLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.post);

    assert.ok(getLayer, 'GET /api/projects/settings route should be registered');
    assert.ok(postLayer, 'POST /api/projects/settings route should be registered');

    const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;
    const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

    const projDir = path.join(mockTenantRoot, tenantId, 'my-project');

    // Test GET default settings (no file exists)
    let getStatus: number | null = null;
    let getJson: any = null;
    const mockResGet = {
      status(code: number) { getStatus = code; return this; },
      json(data: any) { getJson = data; return this; }
    } as any;

    const mockReqGet = {
      query: { projectDir: projDir }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await getHandler(mockReqGet, mockResGet);
    });

    assert.strictEqual(getJson.indexingEnabled, true, 'Default indexingEnabled should be true');

    // Test POST settings to false
    let postStatus: number | null = null;
    let postJson: any = null;
    const mockResPost = {
      status(code: number) { postStatus = code; return this; },
      json(data: any) { postJson = data; return this; }
    } as any;

    const mockReqPost = {
      body: { projectDir: projDir, indexingEnabled: false }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await postHandler(mockReqPost, mockResPost);
    });

    assert.strictEqual(postJson.success, true);
    assert.strictEqual(postJson.indexingEnabled, false);

    // Verify file was written
    const settingsPath = path.join(projDir, '.codeatlas', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), 'settings.json file should exist');
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(written.indexingEnabled, false);

    // Test GET settings again (should return false now)
    getJson = null;
    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await getHandler(mockReqGet, mockResGet);
    });

    assert.strictEqual(getJson.indexingEnabled, false, 'indexingEnabled should now be false');
  });

  test('GET settings with Corrupted settings.json', async () => {
    const getLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.get);
    const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;
    const projDir = path.join(mockTenantRoot, tenantId, 'my-project');
    const settingsPath = path.join(projDir, '.codeatlas', 'settings.json');

    // Write corrupted JSON to settings.json
    fs.writeFileSync(settingsPath, 'invalid { json: file }', 'utf8');

    let getStatus: number | null = null;
    let getJson: any = null;
    const mockResGet = {
      status(code: number) { getStatus = code; return this; },
      json(data: any) { getJson = data; return this; }
    } as any;

    const mockReqGet = {
      query: { projectDir: projDir }
    } as any;

    // Should not crash, and should fall back safely (default to true since Firestore is empty/unused in this test)
    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await getHandler(mockReqGet, mockResGet);
    });

    assert.strictEqual(getJson.indexingEnabled, true, 'Should fall back to default true when local file is corrupted');
  });

  test('POST settings creates missing .codeatlas directory', async () => {
    const postLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.post);
    const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

    const newProjDir = path.join(mockTenantRoot, tenantId, 'another-project');
    // Ensure project dir exists but not .codeatlas
    fs.mkdirSync(newProjDir, { recursive: true });
    fs.mkdirSync(path.join(newProjDir, '.git'), { recursive: true });
    // Write a dummy README.md
    fs.writeFileSync(path.join(newProjDir, 'README.md'), '# Another Project', 'utf8');

    let postStatus: number | null = null;
    let postJson: any = null;
    const mockResPost = {
      status(code: number) { postStatus = code; return this; },
      json(data: any) { postJson = data; return this; }
    } as any;

    const mockReqPost = {
      body: { projectDir: newProjDir, indexingEnabled: false }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await postHandler(mockReqPost, mockResPost);
    });

    assert.strictEqual(postJson.success, true);
    const settingsPath = path.join(newProjDir, '.codeatlas', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), '.codeatlas directory and settings.json should be created');
  });

  test('GET and POST parameter validation', async () => {
    const getLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.get);
    const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;
    const postLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.post);
    const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

    // Test GET with invalid type (array)
    let getStatus: number | null = null;
    let getJson: any = null;
    const mockResGet = {
      status(code: number) { getStatus = code; return this; },
      json(data: any) { getJson = data; return this; }
    } as any;

    const mockReqGetInvalid = {
      query: { projectDir: ['dir1', 'dir2'] }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await getHandler(mockReqGetInvalid, mockResGet);
    });
    assert.strictEqual(getStatus, 400, 'GET should return 400 for invalid query parameter type');

    // Test POST with invalid projectDir type (array)
    let postStatus: number | null = null;
    let postJson: any = null;
    const mockResPost = {
      status(code: number) { postStatus = code; return this; },
      json(data: any) { postJson = data; return this; }
    } as any;

    const mockReqPostInvalidDir = {
      body: { projectDir: ['dir1', 'dir2'], indexingEnabled: true }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await postHandler(mockReqPostInvalidDir, mockResPost);
    });
    assert.strictEqual(postStatus, 400, 'POST should return 400 for invalid projectDir type');

    // Test POST with invalid indexingEnabled type (string)
    const mockReqPostInvalidBool = {
      body: { projectDir: 'some-dir', indexingEnabled: 'true' }
    } as any;

    postStatus = null;
    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await postHandler(mockReqPostInvalidBool, mockResPost);
    });
    assert.strictEqual(postStatus, 400, 'POST should return 400 for invalid indexingEnabled type');
  });

  test('POST settings Firestore failure returns 500', async () => {
    const postLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.post);
    const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;
    const projDir = path.join(mockTenantRoot, tenantId, 'my-project');

    // Mock Firestore failure
    const originalGetApps = firebaseClient.getApps;
    const originalGetFirestore = firebaseClient.getFirestore;

    firebaseClient.getApps = () => [{ name: '[DEFAULT]' }] as any;
    firebaseClient.getFirestore = () => ({
      collection() {
        return {
          doc() {
            return {
              async set() {
                throw new Error("Firestore save timeout");
              }
            };
          }
        };
      }
    }) as any;

    let postStatus: number | null = null;
    let postJson: any = null;
    const mockResPost = {
      status(code: number) { postStatus = code; return this; },
      json(data: any) { postJson = data; return this; }
    } as any;

    const mockReqPost = {
      body: { projectDir: projDir, indexingEnabled: false }
    } as any;

    try {
      await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
        await postHandler(mockReqPost, mockResPost);
      });
      assert.strictEqual(postStatus, 500, 'POST should return 500 when Firestore fails');
      assert.ok(postJson.error.includes('Firestore update failed'), 'Should return clear Firestore failure message');
    } finally {
      // Restore mocks
      firebaseClient.getApps = originalGetApps;
      firebaseClient.getFirestore = originalGetFirestore;
    }
  });

  test('GET settings project not found returns 404', async () => {
    const getLayer = app._router.stack.find((l: any) => l.route && l.route.path === '/api/projects/settings' && l.route.methods.get);
    const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;

    let getStatus: number | null = null;
    let getJson: any = null;
    const mockResGet = {
      status(code: number) { getStatus = code; return this; },
      json(data: any) { getJson = data; return this; }
    } as any;

    const mockReqGet = {
      query: { projectDir: path.join(mockTenantRoot, tenantId, 'non-existent-project') }
    } as any;

    await authStorage.run({ uid: tenantId, tier: 'enterprise', keyId: 'test' }, async () => {
      await getHandler(mockReqGet, mockResGet);
    });

    assert.strictEqual(getStatus, 404, 'GET settings for non-existent project should return 404');
  });
});
