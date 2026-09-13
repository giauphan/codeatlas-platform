import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const named = { ...mockObj };
  delete named.default;
  const def = 'default' in mockObj ? mockObj.default : mockObj;
  const opts = { defaultExport: def, namedExports: named };

  const specs = new Set<string>([specifier]);
  const absPath = path.isAbsolute(specifier) ? specifier : path.resolve(import.meta.dirname, specifier);
  const rawBasePath = absPath.replace(/\.(ts|js)$/, '');
  for (const b of [rawBasePath, rawBasePath.replace('/src/', '/dist/src/')]) {
    for (const ext of ['', '.js', '.ts']) {
      const p = b + ext;
      specs.add(p);
      specs.add(pathToFileURL(p).href);
      try {
        if (fs.existsSync(p)) specs.add(pathToFileURL(fs.realpathSync(p)).href);
      } catch {}
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

// A single in-memory SQLite adapter shared by the process-lifetime factory mock.
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));
process.env.CODEATLAS_SQLITE_PATH = ':memory:';
const memoryAdapter = new SQLiteAdapter();

safeMockModule(path.join(srcDir, 'database/factory.js'), {
  createDatabaseAdapter: () => memoryAdapter,
});

const { SqliteAuthRepository, SqliteActivityLogger } = await import(
  path.join(srcDir, 'repositories.js')
);

const PEPPER = process.env.API_KEY_PEPPER || 'codeatlas-api-key-pepper-v1';

function hashKey(apiKey: string): string {
  return crypto.pbkdf2Sync(apiKey, Buffer.from(PEPPER, 'utf8'), 100000, 64, 'sha256').toString('hex');
}

async function seedTenantUserKey(options: {
  tenantId: string;
  userId: string;
  keyId: string;
  apiKey: string;
  tier?: string;
  expiresAt?: string | null;
}): Promise<void> {
  await memoryAdapter.execute(`INSERT OR REPLACE INTO tenants (id, name) VALUES (?, ?)`, [
    options.tenantId,
    options.tenantId,
  ]);
  await memoryAdapter.execute(
    `INSERT OR REPLACE INTO users (id, tenant_id, email, role) VALUES (?, ?, ?, ?)`,
    [options.userId, options.tenantId, `${options.userId}@example.test`, 'user']
  );
  await memoryAdapter.execute(
    `INSERT OR REPLACE INTO keys (id, tenant_id, user_id, name, key, key_hash, tier, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.keyId,
      options.tenantId,
      options.userId,
      'Test key',
      options.apiKey,
      hashKey(options.apiKey),
      options.tier ?? 'free',
      options.expiresAt ?? null,
    ]
  );
}

describe('SqliteAuthRepository / SqliteActivityLogger (local, Firestore-free)', () => {
  const repo = new SqliteAuthRepository();
  const logger = new SqliteActivityLogger();

  beforeEach(async () => {
    await memoryAdapter.connect();
    await memoryAdapter.initializeSchema();
  });

  afterEach(async () => {
    await memoryAdapter.execute(`DELETE FROM activity_log`);
    await memoryAdapter.execute(`DELETE FROM keys`);
    await memoryAdapter.execute(`DELETE FROM users`);
    await memoryAdapter.execute(`DELETE FROM tenants`);
  });

  test('verifyKey resolves a hashed key without any Firestore call', async () => {
    await seedTenantUserKey({
      tenantId: 'tenant-a',
      userId: 'user-a',
      keyId: 'key-a',
      apiKey: 'test-token-alpha',
      tier: 'premium',
    });

    const auth = await repo.verifyKey('test-token-alpha');

    assert.ok(auth);
    assert.strictEqual(auth.uid, 'user-a');
    assert.strictEqual(auth.keyId, 'key-a');
    assert.strictEqual(auth.tier, 'premium');
  });

  test('verifyKey falls back to the plaintext key column for legacy rows', async () => {
    await seedTenantUserKey({
      tenantId: 'tenant-legacy',
      userId: 'user-legacy',
      keyId: 'key-legacy',
      apiKey: 'test-token-legacy',
    });
    // Simulate a legacy row that only ever stored the plaintext key
    await memoryAdapter.execute(`UPDATE keys SET key_hash = NULL WHERE id = ?`, ['key-legacy']);

    const auth = await repo.verifyKey('test-token-legacy');

    assert.ok(auth);
    assert.strictEqual(auth.uid, 'user-legacy');
    assert.strictEqual(auth.tier, 'free');
  });

  test('verifyKey returns null for an unknown key', async () => {
    const auth = await repo.verifyKey('test-token-unknown');
    assert.strictEqual(auth, null);
  });

  test('verifyKey rejects an expired key', async () => {
    await seedTenantUserKey({
      tenantId: 'tenant-expired',
      userId: 'user-expired',
      keyId: 'key-expired',
      apiKey: 'test-token-expired',
      expiresAt: '2000-01-01 00:00:00',
    });

    const auth = await repo.verifyKey('test-token-expired');
    assert.strictEqual(auth, null);
  });

  test('updateLastUsed stamps updated_at on the matching key row', async () => {
    await seedTenantUserKey({
      tenantId: 'tenant-b',
      userId: 'user-b',
      keyId: 'key-b',
      apiKey: 'test-token-beta',
    });
    await memoryAdapter.execute(`UPDATE keys SET updated_at = NULL WHERE id = ?`, ['key-b']);

    await repo.updateLastUsed('user-b', 'key-b');

    const rows = await memoryAdapter.query<{ updated_at: string | null }>(
      `SELECT updated_at FROM keys WHERE id = ?`,
      ['key-b']
    );
    assert.ok(rows[0].updated_at, 'updated_at should be stamped');
  });

  test('logActivity persists a row scoped to the owning tenant', async () => {
    await seedTenantUserKey({
      tenantId: 'tenant-c',
      userId: 'user-c',
      keyId: 'key-c',
      apiKey: 'test-token-gamma',
    });

    await logger.logActivity('user-c', 'key-c', 'code_search', { project: 'demo' }, true);

    const rows = await memoryAdapter.query<{
      tenant_id: string;
      key_id: string;
      tool: string;
      params: string;
      success: number;
    }>(`SELECT tenant_id, key_id, tool, params, success FROM activity_log`);

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].tenant_id, 'tenant-c');
    assert.strictEqual(rows[0].key_id, 'key-c');
    assert.strictEqual(rows[0].tool, 'code_search');
    assert.deepStrictEqual(JSON.parse(rows[0].params), { project: 'demo' });
    assert.strictEqual(rows[0].success, 1);
  });

  test('logActivity bypasses superadmin requests', async () => {
    await logger.logActivity('admin', 'admin', 'code_search', {}, true);

    const rows = await memoryAdapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM activity_log`
    );
    assert.strictEqual(rows[0].count, 0);
  });
});
