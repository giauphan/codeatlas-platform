import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe('isProjectDirectory', async () => {
  const { isProjectDirectory, loadAnalysisAsync, discoverProjects, discoverProjectsAsync } = await import('../../src/services/projectService.js');
  const { authStorage } = await import('../../src/utils/context.js');
  let tempDirBase: string;

  before(() => {
    tempDirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
  });

  after(() => {
    if (tempDirBase && fs.existsSync(tempDirBase)) {
      fs.rmSync(tempDirBase, { recursive: true, force: true });
    }
  });

  test('should return false if .codeatlas does not exist', () => {
    const projDir = path.join(tempDirBase, 'no-codeatlas');
    fs.mkdirSync(projDir);
    assert.strictEqual(isProjectDirectory(projDir), false);
  });

  test('should return true if .codeatlas is a directory', () => {
    const projDir = path.join(tempDirBase, 'has-codeatlas');
    fs.mkdirSync(projDir);
    const codeatlasDir = path.join(projDir, '.codeatlas');
    fs.mkdirSync(codeatlasDir);
    fs.writeFileSync(path.join(codeatlasDir, 'analysis.json'), '{}');

    assert.strictEqual(isProjectDirectory(projDir), true);
  });

  test('should return false if .codeatlas is not a directory', () => {
    const projDir = path.join(tempDirBase, 'file-codeatlas');
    fs.mkdirSync(projDir);
    const codeatlasPath = path.join(projDir, '.codeatlas');
    fs.writeFileSync(codeatlasPath, '{}');

    assert.strictEqual(isProjectDirectory(projDir), false);
  });

  test('should return false on file system error', () => {
    const fakePath = path.join(tempDirBase, 'does-not-exist');
    assert.strictEqual(isProjectDirectory(fakePath), false);
  });

  test('loadAnalysisAsync resolves a case-insensitive Windows-style relative project path', async () => {
    const projectRoot = fs.mkdtempSync(path.join(process.cwd(), 'project-service-alias-'));
    const projectDir = path.join(projectRoot, 'ExampleProject');
    const projectConfigDir = path.join(projectDir, '.codeatlas');
    const homeDir = path.join(tempDirBase, 'home');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(projectConfigDir, 'analysis.json'), JSON.stringify({ graph: { nodes: [], links: [] } }));

    const originalProjectDir = process.env.CODEATLAS_PROJECT_DIR;
    const originalMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
    const originalHome = process.env.HOME;
    process.env.CODEATLAS_PROJECT_DIR = projectDir;
    process.env.CODEATLAS_MULTI_TENANT = 'false';
    process.env.HOME = homeDir;

    try {
      const relativePath = path.relative(process.cwd(), projectDir);
      const windowsStyleAlias = relativePath.replaceAll('/', '\\').toUpperCase();
      const result = await loadAnalysisAsync(windowsStyleAlias);
      assert.equal(result?.projectDir, projectDir);
    } finally {
      if (originalProjectDir === undefined) delete process.env.CODEATLAS_PROJECT_DIR;
      else process.env.CODEATLAS_PROJECT_DIR = originalProjectDir;
      if (originalMultiTenant === undefined) delete process.env.CODEATLAS_MULTI_TENANT;
      else process.env.CODEATLAS_MULTI_TENANT = originalMultiTenant;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('both discovery paths retain tenant isolation and admin visibility', async () => {
    const tenantRoot = path.join(tempDirBase, 'tenant-discovery');
    const projectDirs = ['tenant-a', 'tenant-b'].map(tenant => path.join(tenantRoot, tenant, 'same-name'));
    for (const dir of projectDirs) {
      fs.mkdirSync(path.join(dir, '.codeatlas'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.codeatlas', 'analysis.json'), '{}');
    }
    const priorRoot = process.env.CODEATLAS_PROJECTS_ROOT;
    const priorMode = process.env.CODEATLAS_MULTI_TENANT;
    const priorProject = process.env.CODEATLAS_PROJECT_DIR;
    process.env.CODEATLAS_PROJECTS_ROOT = tenantRoot;
    process.env.CODEATLAS_MULTI_TENANT = 'true';
    delete process.env.CODEATLAS_PROJECT_DIR;
    try {
      for (const discover of [discoverProjects, discoverProjectsAsync]) {
        const user = { uid: 'tenant-a', role: 'user', tier: 'free', keyId: 'test' };
        const own = await authStorage.run(user, () => discover('tenant-a'));
        assert.deepStrictEqual(own.map(project => project.dir), [projectDirs[0]]);
        assert.deepStrictEqual(await authStorage.run(user, () => discover()), []);
        const admin = { ...user, uid: 'admin', role: 'admin' };
        const all = await authStorage.run(admin, () => discover('tenant-a'));
        assert.deepStrictEqual(new Set(all.map(project => project.dir)), new Set(projectDirs));
      }
    } finally {
      if (priorRoot === undefined) delete process.env.CODEATLAS_PROJECTS_ROOT;
      else process.env.CODEATLAS_PROJECTS_ROOT = priorRoot;
      if (priorMode === undefined) delete process.env.CODEATLAS_MULTI_TENANT;
      else process.env.CODEATLAS_MULTI_TENANT = priorMode;
      if (priorProject === undefined) delete process.env.CODEATLAS_PROJECT_DIR;
      else process.env.CODEATLAS_PROJECT_DIR = priorProject;
    }
  });
});
