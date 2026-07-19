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

  describe('getPool', () => {
    test('returns null before initialization', () => {
      assert.strictEqual(connectionModule.getPool(), null);
    });

    test('returns the pool after initialization', async () => {
      const pool = await connectionModule.initPool();
      assert.deepStrictEqual(connectionModule.getPool(), pool);
      assert.strictEqual(pool._mockPool, true);
    });
  });
});
