import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { app } from '../src/presentation/httpServer.js';
import { authStorage } from '../src/context.js';

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
  });

  after(() => {
    process.env.CODEATLAS_MULTI_TENANT = originalMultiTenant;
    process.env.CODEATLAS_PROJECTS_ROOT = originalProjectsRoot;

    if (fs.existsSync(mockTenantRoot)) {
      fs.rmSync(mockTenantRoot, { recursive: true, force: true });
    }
  });

  test('GET and POST settings endpoint routing', async () => {
    // Find the get and post handlers in express app
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
});
