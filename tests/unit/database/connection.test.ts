import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import oracledb from 'oracledb';

describe('Database Connection', async () => {
  let connectionModule: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = process.env;
    process.env = { ...originalEnv };

    process.env.ORACLE_USER = 'TEST_USER';
    process.env.ORACLE_PASSWORD = 'TEST_PASSWORD';
    process.env.ORACLE_CONN_STRING = 'TEST_CONN_STRING';

    mock.method(oracledb, 'createPool', async () => {
      return { _mockPool: true };
    });

    // We need to bust the cache to ensure we get a fresh instance of the connection module
    // which allows us to test the initial `null` state of the pool
    const cacheBuster = `?update=${Date.now()}`;
    connectionModule = await import(`../../../src/database/connection.ts${cacheBuster}`);
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restoreAll();
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
