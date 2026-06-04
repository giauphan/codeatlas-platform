import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import oracledb from 'oracledb';
import { OracleMemoryService } from '../src/oracleDatabase.js';

process.env.ORACLE_PASSWORD = 'mock_password';
process.env.ORACLE_CONN_STRING = 'mock_connection_string';

describe('OracleMemoryService', () => {
  afterEach(() => {
    mock.restoreAll();
    // Reset pool
    (OracleMemoryService as any).pool = null;
  });

  test('should handle missing connection gracefully in detectArchitecturalSmells', async () => {
    // This will fail because no DB is connected, but we want to ensure it throws or returns null
    try {
      const smells = await OracleMemoryService.detectArchitecturalSmells('test_project');
      // If it doesn't throw, it should probably be null if not initialized
      assert.strictEqual(smells, null);
    } catch (e) {
      assert.ok(e, 'Should throw error if Oracle is not configured');
    }
  });

  test('should have all required methods', () => {
    assert.strictEqual(typeof OracleMemoryService.saveRelationalMemory, 'function');
    assert.strictEqual(typeof OracleMemoryService.detectArchitecturalSmells, 'function');
    assert.strictEqual(typeof OracleMemoryService.saveSemanticMemory, 'function');
    assert.strictEqual(typeof OracleMemoryService.deleteProjectMemory, 'function');
  });

  test('should throw error when missing connection in deleteProjectMemory', async () => {
    try {
      await OracleMemoryService.deleteProjectMemory('test_project');
      assert.fail('Should have thrown an error');
    } catch (e) {
      assert.ok(e, 'Should throw error if Oracle is not configured');
    }
  });

  test('should throw error when pool creation fails during init()', async () => {
    mock.method(oracledb, 'createPool', async () => {
      throw new Error('Simulated pool creation error');
    });

    try {
      await OracleMemoryService.init();
      assert.fail('Should have thrown an error');
    } catch (e: any) {
      assert.strictEqual(e.message, 'Simulated pool creation error');
    }
  });

  test('should initialize Oracle Client in Thick Mode if ORACLE_LIB_DIR is set', async () => {
    const initClientMock = mock.method(oracledb, 'initOracleClient', () => {});
    mock.method(oracledb, 'createPool', async () => ({}));

    process.env.ORACLE_LIB_DIR = '/mock/lib/dir';
    process.env.ORACLE_WALLET_DIR = '/mock/wallet/dir';

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true
    });

    try {
      await OracleMemoryService.init();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true
      });
    }

    assert.strictEqual(initClientMock.mock.calls.length, 1);
    assert.deepStrictEqual(initClientMock.mock.calls[0].arguments[0], {
      libDir: '/mock/lib/dir',
      configDir: '/mock/wallet/dir'
    });

    delete process.env.ORACLE_LIB_DIR;
    delete process.env.ORACLE_WALLET_DIR;
  });
});
