import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { isProjectDirectory, isProjectDirectoryAsync, getOpenIdeForDir } from '../src/services/projectService.js';

describe('Project Discovery Hardening & Workspace Validation', () => {
  const tmpBaseDir = path.join(process.cwd(), 'tests', 'temp_discovery_test');
  const validGitDir = path.join(tmpBaseDir, 'valid_git_project');
  const validCodeatlasDir = path.join(tmpBaseDir, 'valid_codeatlas_project');
  const invalidDir = path.join(tmpBaseDir, 'invalid_project');
  const systemDir = path.join(tmpBaseDir, '.some_hidden_system_dir');
  const mockIdeDir = path.join(tmpBaseDir, 'mock_ide_project');

  let mockIdeProcess: ChildProcess | null = null;
  const mockScriptPath = path.join(tmpBaseDir, 'mock-cursor-ide');

  before(async () => {
    // Clean and create test directory tree
    if (fs.existsSync(tmpBaseDir)) {
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpBaseDir, { recursive: true });

    // 1. Project with .git
    fs.mkdirSync(validGitDir, { recursive: true });
    fs.mkdirSync(path.join(validGitDir, '.git'), { recursive: true });

    // 2. Project with .codeatlas
    fs.mkdirSync(validCodeatlasDir, { recursive: true });
    fs.mkdirSync(path.join(validCodeatlasDir, '.codeatlas'), { recursive: true });

    // 3. Invalid project (no markers)
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(path.join(invalidDir, 'somefile.txt'), 'hello');

    // 4. System/IDE directory starting with a dot
    fs.mkdirSync(systemDir, { recursive: true });

    // 5. Setup mock script/symlink for process inspection test
    fs.mkdirSync(mockIdeDir, { recursive: true });
    // Symlink the node binary to a name containing "cursor" to simulate IDE executable name
    fs.symlinkSync(process.execPath, mockScriptPath);

    // Start the process simulating an open IDE on mockIdeDir
    mockIdeProcess = spawn(mockScriptPath, ['-e', 'setTimeout(() => {}, 20000)', mockIdeDir], {
      detached: true,
      stdio: 'ignore'
    });
    mockIdeProcess.unref();

    // Give it a tiny bit of time to start
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  after(() => {
    // Terminate mock IDE process
    if (mockIdeProcess) {
      try {
        mockIdeProcess.kill();
      } catch (err) {
        // ignore
      }
    }

    // Clean up directory tree
    if (fs.existsSync(tmpBaseDir)) {
      fs.rmSync(tmpBaseDir, { recursive: true, force: true });
    }
  });

  test('isProjectDirectory - should identify valid Git repositories', () => {
    assert.strictEqual(isProjectDirectory(validGitDir), true, 'Dir with .git should be a valid project');
  });

  test('isProjectDirectory - should identify valid CodeAtlas project directories', () => {
    assert.strictEqual(isProjectDirectory(validCodeatlasDir), true, 'Dir with .codeatlas should be a valid project');
  });

  test('isProjectDirectory - should reject random directories lacking markers', () => {
    assert.strictEqual(isProjectDirectory(invalidDir), false, 'Random dir should not be a valid project');
  });

  test('isProjectDirectory - should reject system/hidden directories', () => {
    assert.strictEqual(isProjectDirectory(systemDir), false, 'System dot-directories should be ignored');
  });

  test('isProjectDirectoryAsync - should identify valid Git repositories asynchronously', async () => {
    const res = await isProjectDirectoryAsync(validGitDir);
    assert.strictEqual(res, true, 'Dir with .git should be a valid project async');
  });

  test('isProjectDirectoryAsync - should identify valid CodeAtlas directories asynchronously', async () => {
    const res = await isProjectDirectoryAsync(validCodeatlasDir);
    assert.strictEqual(res, true, 'Dir with .codeatlas should be a valid project async');
  });

  test('isProjectDirectoryAsync - should reject random directories asynchronously', async () => {
    const res = await isProjectDirectoryAsync(invalidDir);
    assert.strictEqual(res, false, 'Random dir should not be a valid project async');
  });

  test('getOpenIdeForDir & process detection - should detect open IDE processes for directory', () => {
    if (process.platform === 'linux') {
      const ide = getOpenIdeForDir(mockIdeDir);
      assert.ok(ide, 'Should successfully detect mock IDE process');
      assert.ok(ide.includes('mock-cursor-ide'), 'Detected IDE name should match script name');

      // isProjectDirectory should now accept the directory since the IDE is running
      assert.strictEqual(isProjectDirectory(mockIdeDir), true, 'Dir active in IDE should be a valid project');
    } else {
      console.log('Skipping Linux /proc process inspection test on non-Linux platform');
    }
  });

  test('isSystemIdeDirectory - should reject system paths like root, home, /config', () => {
    // Test some known system directories
    const homeDir = os.homedir();
    assert.strictEqual(isProjectDirectory(homeDir), false, 'Home directory should not be catalogued as project');
    assert.strictEqual(isProjectDirectory('/'), false, 'Root directory should be ignored');
    assert.strictEqual(isProjectDirectory('/config'), false, '/config directory should be ignored');
  });
});
