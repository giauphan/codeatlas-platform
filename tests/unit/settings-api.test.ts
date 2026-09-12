import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

describe('Settings API - Firestore Quota / Fallback resilience', () => {
  let server: http.Server;
  let port: number;
  const testProjectDir = path.join(process.cwd(), 'projects', 'mock_settings_project');
  const apiKeyValue = 'super-secret-admin-key';
  const origApiKey = process.env.CODEATLAS_API_KEY;

  before(async () => {
    process.env.CODEATLAS_API_KEY = apiKeyValue;

    // Create a mock client project directory inside projects/ with .codeatlas
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(testProjectDir, '.codeatlas'), { recursive: true });
    // Write an analysis.json so it is recognized as a valid project directory
    fs.writeFileSync(path.join(testProjectDir, '.codeatlas', 'analysis.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(testProjectDir, 'package.json'), JSON.stringify({ name: 'mock_settings_project' }));

    // Mock firebaseClient to simulate RESOURCE_EXHAUSTED / Quota exceeded
    const httpServerModule = await import('../../src/presentation/httpServer.js');

    // Inject mock firestore into firebaseClient
    (httpServerModule.firebaseClient as any).getApps = () => ['[DEFAULT]'];
    (httpServerModule.firebaseClient as any).getFirestore = () => ({
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
          },
          set: async () => {
            throw new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
          }
        })
      })
    });

    await new Promise<void>((resolve) => {
      server = httpServerModule.app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  after(async () => {
    process.env.CODEATLAS_API_KEY = origApiKey;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  test('GET /api/projects/settings should not return 500 when Firestore quota is exhausted (fallback to true)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/settings?projectDir=${encodeURIComponent(testProjectDir)}`, {
      headers: {
        'x-api-key': apiKeyValue
      }
    });

    assert.strictEqual(res.status, 200, 'Should gracefully fall back to 200 with default setting');
    const data = await res.json() as any;
    assert.strictEqual(data.indexingEnabled, true, 'Default indexingEnabled should be true');
  });

  test('POST /api/projects/settings should save locally and succeed even if Firestore backup sync throws Quota error', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyValue
      },
      body: JSON.stringify({
        projectDir: testProjectDir,
        indexingEnabled: false
      })
    });

    assert.strictEqual(res.status, 200, 'Should succeed locally even if Firestore is exhausted');
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.indexingEnabled, false);

    // Verify local disk persistence
    const saved = JSON.parse(fs.readFileSync(path.join(testProjectDir, '.codeatlas', 'settings.json'), 'utf-8'));
    assert.strictEqual(saved.indexingEnabled, false);
  });
});
