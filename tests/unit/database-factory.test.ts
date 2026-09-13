import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { createDatabaseAdapter, setDatabaseAdapter, resetDatabaseAdapter } from '../../src/database/factory.js';
import { PostgresAdapter } from '../../src/database/adapters/postgresAdapter.js';

describe('Database Factory and Schema Migrations', () => {
  const origType = process.env.CODEATLAS_DB_TYPE;

  beforeEach(() => {
    // Ensure singleton state doesn't leak across tests
    resetDatabaseAdapter();
  });

  afterEach(() => {
    process.env.CODEATLAS_DB_TYPE = origType;
    resetDatabaseAdapter();
  });

  test('createDatabaseAdapter memoizes adapter and setDatabaseAdapter overrides', async () => {
    process.env.CODEATLAS_DB_TYPE = 'sqlite';
    const adapter1 = createDatabaseAdapter();
    const adapter2 = createDatabaseAdapter();
    assert.strictEqual(adapter1, adapter2, 'Factory should return memoized singleton instance');

    const customAdapter = new SQLiteAdapter();
    setDatabaseAdapter(customAdapter);
    assert.strictEqual(createDatabaseAdapter(), customAdapter, 'setDatabaseAdapter should override active instance');

    resetDatabaseAdapter();
    assert.notStrictEqual(createDatabaseAdapter(), customAdapter, 'resetDatabaseAdapter should create a fresh instance');
  });

  test('initializeSchema drops legacy plaintext "key" column from keys table', async () => {
    process.env.CODEATLAS_SQLITE_PATH = ':memory:';
    const adapter = new SQLiteAdapter();
    await adapter.connect();

    // Explicitly create legacy table with 'key' column
    await adapter.execute(`
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT,
        name TEXT,
        key TEXT,
        key_hash TEXT NOT NULL UNIQUE,
        tier TEXT DEFAULT 'free',
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Verify key column exists before schema initialization
    assert.strictEqual(await adapter.checkColumnExists('keys', 'key'), true);

    // Run initializeSchema
    await adapter.initializeSchema();

    // Verify key column has been dropped
    assert.strictEqual(await adapter.checkColumnExists('keys', 'key'), false);
    assert.strictEqual(await adapter.checkColumnExists('keys', 'key_hash'), true);

    await adapter.disconnect();
  });
});
