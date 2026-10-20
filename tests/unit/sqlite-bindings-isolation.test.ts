import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('SQLite binding tests leave the default database activity_log untouched', async () => {
  const scratchRoot = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'codeatlas-bindings-isolation-'));
  const home = path.join(scratchRoot, 'home');
  const privateTmp = path.join(scratchRoot, 'tmp');
  const defaultDatabasePath = path.join(home, '.codeatlas', 'codeatlas.db');
  await Promise.all([
    mkdir(path.dirname(defaultDatabasePath), { recursive: true }),
    mkdir(privateTmp, { recursive: true }),
  ]);

  try {
    const seed = new SQLiteAdapter(defaultDatabasePath);
    await seed.connect();
    await seed.initializeSchema();
    await seed.execute(
      'INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (?, ?, ?, ?)',
      ['isolation-sentinel', 'private-test-tenant', 'sentinel', true],
    );
    await seed.disconnect();

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => new Set([
        'PATH', 'NODE_PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
      ]).has(name)),
    );
    Object.assign(childEnv, {
      HOME: home,
      TMPDIR: privateTmp,
      TMP: privateTmp,
      TEMP: privateTmp,
      NODE_ENV: 'test',
      CODEATLAS_DB_TYPE: 'sqlite',
    });
    assert.equal(Object.hasOwn(childEnv, 'CODEATLAS_SQLITE_PATH'), false);

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', 'tsx',
        '--test', 'tests/unit/sqliteAdapter-bindings.test.ts',
      ], {
        cwd: repositoryRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });

    assert.equal(result.signal, null, result.output);
    assert.equal(result.code, 0, result.output);

    const require = createRequire(path.join(repositoryRoot, 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(defaultDatabasePath, { readonly: true, fileMustExist: true });
    try {
      const sentinel = db.prepare('SELECT id, tenant_id, tool, success FROM activity_log WHERE id = ?').get('isolation-sentinel');
      assert.deepEqual(sentinel, {
        id: 'isolation-sentinel',
        tenant_id: 'private-test-tenant',
        tool: 'sentinel',
        success: 1,
      });
    } finally {
      db.close();
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});
