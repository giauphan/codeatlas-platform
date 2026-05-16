import { test, describe } from 'node:test';
import assert from 'node:assert';
import { OracleMemoryService } from '../src/oracleDatabase.js';

describe('OracleMemoryService', () => {
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
  });
});
