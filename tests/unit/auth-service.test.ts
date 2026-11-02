import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const originalApiKey = process.env.CODEATLAS_API_KEY;
const originalUseFirestore = process.env.CODEATLAS_USE_FIRESTORE;
process.env.CODEATLAS_USE_FIRESTORE = 'false';
process.env.CODEATLAS_API_KEY = 'trusted-old-admin-key';

const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));
const adapter = new SQLiteAdapter(':memory:');
mock.module(path.join(srcDir, 'database/factory.js'), {
  namedExports: { createDatabaseAdapter: () => adapter },
});
mock.module('firebase-admin/auth', {
  namedExports: { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'firebase-user' }) }) },
});
const { hashApiKey } = await import(path.join(srcDir, 'utils/apiKey.js'));
const { authStorage } = await import(path.join(srcDir, 'utils/context.js'));
const { checkAuth } = await import(path.join(srcDir, 'services/authService.js'));

before(async () => {
  await adapter.connect();
  await adapter.initializeSchema();
});

beforeEach(async () => {
  await adapter.execute('DELETE FROM keys');
  await adapter.execute('DELETE FROM users');
  await adapter.execute('DELETE FROM tenants');
  await adapter.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', ['auth-test-tenant', 'Auth Test Tenant']);
  await adapter.execute('INSERT INTO users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)', [
    'registered-admin-user', 'auth-test-tenant', 'admin-user@example.test', 'user',
  ]);
  await adapter.execute('INSERT INTO users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)', [
    'registered-standard-user', 'auth-test-tenant', 'standard-user@example.test', 'user',
  ]);
  for (const [id, userId, apiKey] of [
    ['trusted-old-id', 'registered-admin-user', 'trusted-old-admin-key'],
    ['trusted-new-id', 'registered-admin-user', 'trusted-new-admin-key'],
    ['standard-id', 'registered-standard-user', 'standard-registered-key'],
  ]) {
    await adapter.execute(
      `INSERT INTO keys (id, tenant_id, user_id, name, key_hash, tier, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, 'auth-test-tenant', userId, id, await hashApiKey(apiKey), 'enterprise'],
    );
  }
});

after(async () => {
  await adapter.disconnect();
  if (originalApiKey === undefined) delete process.env.CODEATLAS_API_KEY;
  else process.env.CODEATLAS_API_KEY = originalApiKey;
  if (originalUseFirestore === undefined) delete process.env.CODEATLAS_USE_FIRESTORE;
  else process.env.CODEATLAS_USE_FIRESTORE = originalUseFirestore;
});

test('the configured process API key gets admin role without changing its registered identity', async () => {
  process.env.CODEATLAS_API_KEY = 'trusted-old-admin-key';
  const admin = await checkAuth('trusted-old-admin-key');
  assert.deepEqual(admin, {
    tier: 'enterprise', uid: 'registered-admin-user', keyId: 'trusted-old-id', role: 'admin',
  });

  const regular = await checkAuth('standard-registered-key');
  assert.deepEqual(regular, {
    tier: 'enterprise', uid: 'registered-standard-user', keyId: 'standard-id',
  });
  assert.equal('role' in regular, false);
});

test('admin elevation follows current key rotation and does not cross async auth context', async () => {
  process.env.CODEATLAS_API_KEY = 'trusted-old-admin-key';
  const beforeRotation = await checkAuth('trusted-old-admin-key');
  assert.equal(beforeRotation.role, 'admin');

  process.env.CODEATLAS_API_KEY = 'trusted-new-admin-key';
  const oldKeyAfterRotation = await checkAuth('trusted-old-admin-key');
  assert.deepEqual(oldKeyAfterRotation, {
    tier: 'enterprise', uid: 'registered-admin-user', keyId: 'trusted-old-id',
  });
  assert.equal('role' in oldKeyAfterRotation, false);

  const rotatedKey = await checkAuth('trusted-new-admin-key');
  assert.equal(rotatedKey.uid, 'registered-admin-user');
  assert.equal(rotatedKey.keyId, 'trusted-new-id');
  assert.equal(rotatedKey.role, 'admin');

  const ordinaryContext = { tier: 'enterprise', uid: 'registered-standard-user', keyId: 'standard-id' };
  const nestedResult = await authStorage.run(ordinaryContext, () => checkAuth('trusted-new-admin-key'));
  assert.deepEqual(nestedResult, ordinaryContext);
});

test('bearer authentication, missing keys, and whitespace-only configuration keep existing behavior', async () => {
  process.env.CODEATLAS_API_KEY = 'trusted-old-admin-key';
  const bearer = await checkAuth('trusted-old-admin-key', 'valid-firebase-token');
  assert.deepEqual(bearer, {
    tier: 'premium', uid: 'firebase-user', keyId: 'firebase:firebase-user',
  });

  await assert.rejects(checkAuth(), /API Key is required/);
  process.env.CODEATLAS_API_KEY = '   ';
  await assert.rejects(checkAuth('some-registered-key'), /cannot be empty or whitespace-only/);
});
