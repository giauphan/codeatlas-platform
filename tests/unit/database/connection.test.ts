import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Database Connection', async () => {
  let connectionModule: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = process.env;
    process.env = { ...originalEnv };

    process.env.CODEATLAS_DB_TYPE = 'sqlite';
    process.env.CODEATLAS_SQLITE_PATH = path.join(os.tmpdir(), `codeatlas-conn-${Date.now()}.db`);

    // We need to bust the cache to ensure we get a fresh instance of the connection module
    // which allows us to test the initial `null` state of the adapter
    const cacheBuster = `?update=${Date.now()}`;
    connectionModule = await import(`../../../src/database/connection.ts${cacheBuster}`);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Adapter Pool', () => {
    test('initPool returns a pool-like object', async () => {
      const pool = await connectionModule.initPool();
      assert.ok(pool.getConnection);
      const conn = await pool.getConnection();
      assert.ok(conn.execute);
      assert.ok(conn.executeMany);
      assert.ok(conn.commit);
      assert.ok(conn.rollback);
      assert.ok(conn.close);
    });
  });
});
