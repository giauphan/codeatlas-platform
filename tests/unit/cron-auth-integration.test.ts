import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const previousEnv = new Map<string, string | undefined>();
for (const name of ['CODEATLAS_USE_FIRESTORE', 'CODEATLAS_DB_TYPE', 'CODEATLAS_API_KEY', 'CODEATLAS_MULTI_TENANT', 'API_KEY_PEPPER', 'CRON_SETTINGS_PATH']) {
  previousEnv.set(name, process.env[name]);
}

const scratch = await mkdtemp(join(tmpdir(), 'codeatlas-cron-auth-integration-'));
const settingsPath = join(scratch, 'cron-settings.json');
const initialAdminKey = 'synthetic-configured-key-before-rotation';
const rotatedAdminKey = 'synthetic-configured-key-after-rotation';
const ordinaryKey = 'synthetic-ordinary-tenant-key';
Object.assign(process.env, {
  CODEATLAS_USE_FIRESTORE: 'false',
  CODEATLAS_DB_TYPE: 'sqlite',
  CODEATLAS_API_KEY: initialAdminKey,
  CODEATLAS_MULTI_TENANT: 'true',
  API_KEY_PEPPER: 'synthetic-cron-auth-test-pepper',
  CRON_SETTINGS_PATH: settingsPath,
});

const srcDir = resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(join(srcDir, 'database/adapters/sqliteAdapter.js'));
const adapter = new SQLiteAdapter(':memory:');
mock.module(join(srcDir, 'database/factory.js'), {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module('firebase-admin/auth', {
  namedExports: { getAuth: () => ({ verifyIdToken: async () => { throw new Error('Firebase auth is not used in this test'); } }) },
});

const { hashApiKey } = await import(join(srcDir, 'utils/apiKey.js'));
const { authMiddleware } = await import(join(srcDir, 'middleware/auth.js'));
const { mountCronSettingsRoutes } = await import(join(srcDir, 'presentation/cronSettingsRoute.js'));

const app = express();
app.use(express.json());
mountCronSettingsRoutes(app);
app.get('/__test/whoami', authMiddleware, (req, res) => {
  res.json({ uid: req.auth?.uid, role: req.auth?.role ?? null });
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolveListen, reject) => {
  server.once('listening', resolveListen);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function registerKey(id: string, uid: string, key: string): Promise<void> {
  await adapter.execute(
    `INSERT INTO keys (id, tenant_id, user_id, name, key_hash, tier, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [id, 'cron-auth-tenant', uid, id, await hashApiKey(key), 'enterprise'],
  );
}

before(async () => {
  await adapter.initialize();
  await adapter.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', ['cron-auth-tenant', 'Cron auth test tenant']);
  await adapter.execute('INSERT INTO users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)', [
    'registered-config-user', 'cron-auth-tenant', 'configured@example.test', 'user',
  ]);
  await adapter.execute('INSERT INTO users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)', [
    'registered-ordinary-user', 'cron-auth-tenant', 'ordinary@example.test', 'user',
  ]);
  await registerKey('configured-old-key-id', 'registered-config-user', initialAdminKey);
  await registerKey('configured-new-key-id', 'registered-config-user', rotatedAdminKey);
  await registerKey('ordinary-key-id', 'registered-ordinary-user', ordinaryKey);
});

after(async () => {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  await adapter.close();
  await rm(scratch, { recursive: true, force: true });
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function whoAmI(apiKey?: string): Promise<Response> {
  return fetch(`${baseUrl}/__test/whoami`, { headers: apiKey ? { 'x-api-key': apiKey } : {} });
}

async function updateCron(apiKey: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/settings/cron`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify(body),
  });
}

test('real API-key auth scopes global cron writes to the currently configured key without changing registered identity', async () => {
  const initialIdentity = await whoAmI(initialAdminKey);
  assert.equal(initialIdentity.status, 200);
  assert.deepEqual(await initialIdentity.json(), { uid: 'registered-config-user', role: 'admin' });

  const initialWrite = await updateCron(initialAdminKey, { reconciliation_enabled: false });
  assert.equal(initialWrite.status, 200);
  const originalSettings = await readFile(settingsPath, 'utf8');
  assert.equal(JSON.parse(originalSettings).reconciliation_enabled, false);

  const ordinaryIdentity = await whoAmI(ordinaryKey);
  assert.equal(ordinaryIdentity.status, 200);
  assert.deepEqual(await ordinaryIdentity.json(), { uid: 'registered-ordinary-user', role: null });
  const ordinaryWrite = await updateCron(ordinaryKey, { reconciliation_enabled: true });
  assert.equal(ordinaryWrite.status, 403);
  assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);

  const missingIdentity = await whoAmI();
  assert.equal(missingIdentity.status, 401);
  const missingWrite = await updateCron(undefined, { reconciliation_enabled: true });
  assert.equal(missingWrite.status, 401);
  const invalidWrite = await updateCron('synthetic-unregistered-key', { reconciliation_enabled: true });
  assert.equal(invalidWrite.status, 401);
  assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);

  process.env.CODEATLAS_API_KEY = rotatedAdminKey;
  const oldKeyIdentity = await whoAmI(initialAdminKey);
  assert.equal(oldKeyIdentity.status, 200);
  assert.deepEqual(await oldKeyIdentity.json(), { uid: 'registered-config-user', role: null });
  const oldKeyWrite = await updateCron(initialAdminKey, { reconciliation_enabled: true });
  assert.equal(oldKeyWrite.status, 403);
  assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);

  const rotatedIdentity = await whoAmI(rotatedAdminKey);
  assert.equal(rotatedIdentity.status, 200);
  assert.deepEqual(await rotatedIdentity.json(), { uid: 'registered-config-user', role: 'admin' });
  const rotatedWrite = await updateCron(rotatedAdminKey, { reconciliation_enabled: true });
  assert.equal(rotatedWrite.status, 200);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).reconciliation_enabled, true);
});
