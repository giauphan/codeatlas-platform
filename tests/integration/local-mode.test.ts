import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

// Setup shared sqlite path
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
const tempDbPath = path.join(tempDir, 'test.db');
process.env.CODEATLAS_SQLITE_PATH = tempDbPath;
process.env.CODEATLAS_USE_FIRESTORE = 'false';
process.env.API_KEY_PEPPER = 'test-pepper';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));
const { app } = await import(path.join(srcDir, 'presentation/httpServer.js'));

describe('HTTP Server Local-First (Firestore-Free Mode)', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let memoryAdapter: InstanceType<typeof SQLiteAdapter>;

  const PEPPER = process.env.API_KEY_PEPPER || 'codeatlas-api-key-pepper-v1';
  const apiKey = 'test-local-api-key';
  const keyHash = crypto.pbkdf2Sync(apiKey, Buffer.from(PEPPER, 'utf8'), 100000, 64, 'sha256').toString('hex');

  before(async () => {
    memoryAdapter = new SQLiteAdapter();
    await memoryAdapter.connect();
    await memoryAdapter.initializeSchema();

    // Seed test tenant, user and api key
    await memoryAdapter.execute(`INSERT OR REPLACE INTO tenants (id, name) VALUES ('tenant-local', 'Local Tenant')`);
    await memoryAdapter.execute(`INSERT OR REPLACE INTO users (id, tenant_id, email, role, tier) VALUES ('user-local', 'tenant-local', 'user@local.test', 'admin', 'pro')`);
    await memoryAdapter.execute(
      `INSERT OR REPLACE INTO keys (id, tenant_id, user_id, name, key_hash, tier)
       VALUES ('key-local', 'tenant-local', 'user-local', 'Local Test Key', :keyHash, 'pro')`,
      { keyHash }
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          port = addr.port;
          baseUrl = `http://localhost:${port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (memoryAdapter) {
      await memoryAdapter.disconnect();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('POST /api/projects/sync saves to SQLite without calling Firestore', async () => {
    const res = await fetch(`${baseUrl}/api/projects/sync`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projectName: 'demo-local-project',
        analysis: {
          nodes: [{ id: '1', name: 'App' }],
          links: [],
          stats: { modules: 1 },
        },
      }),
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    const rows = await memoryAdapter.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE name = 'demo-local-project'`
    );
    assert.strictEqual(rows.length, 1);
  });

  test('POST and GET /api/projects/settings uses local settings without calling Firestore', async () => {
    const postRes = await fetch(`${baseUrl}/api/projects/settings`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projectName: 'demo-local-project',
        indexingEnabled: false,
      }),
    });

    const postBody = await postRes.json();
    assert.strictEqual(postRes.status, 200, "POST Expected 200 but got " + postRes.status + ". Body: " + JSON.stringify(postBody));
    assert.strictEqual(postBody.success, true);
    assert.strictEqual(postBody.indexingEnabled, false);

    const getRes = await fetch(`${baseUrl}/api/projects/settings?projectName=demo-local-project`, {
      headers: {
        'x-api-key': apiKey,
      },
    });

    const getBody = await getRes.json();
    assert.strictEqual(getRes.status, 200, "GET Expected 200 but got " + getRes.status + ". Body: " + JSON.stringify(getBody));
    assert.strictEqual(getBody.indexingEnabled, false);
  });

  test('DELETE /api/projects cleans up local project without Firestore errors', async () => {
    const res = await fetch(`${baseUrl}/api/projects?projectDir=projects/demo-local-project`, {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
      },
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200, "Expected 200 but got " + res.status + ". Body: " + JSON.stringify(body));
    assert.strictEqual(body.success, true);
  });
});
