import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isProjectDirectory } from '../../src/services/projectService.js';

describe('isProjectDirectory', () => {
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
});
