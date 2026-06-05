import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

describe('Auto-Indexing Watcher', () => {
  const testDir = path.join(process.cwd(), 'tests', 'mock_watch_project');
  let testFile: string;

  before(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    testFile = path.join(testDir, 'dummy.ts');
    fs.writeFileSync(testFile, 'console.log("hello");');
  });

  after(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
  });

  test('should successfully watch directory and capture change events', async () => {
    const watcher = chokidar.watch(testDir, {
      persistent: false,
      ignoreInitial: true
    });

    let changeTriggered = false;
    let resolvedPath = '';

    watcher.on('change', (p) => {
      changeTriggered = true;
      resolvedPath = p;
    });

    // Wait a brief moment for watcher to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    // Modify the file to trigger watcher
    fs.writeFileSync(testFile, 'console.log("changed");');

    // Wait for the event to propagate
    for (let i = 0; i < 10; i++) {
      if (changeTriggered) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    assert.ok(changeTriggered, 'Watcher did not capture file change event');
    assert.strictEqual(path.basename(resolvedPath), 'dummy.ts');

    await watcher.close();
  });
});
