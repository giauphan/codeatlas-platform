import test, { describe, mock } from 'node:test';
import assert from 'node:assert';
import { consolidationEngine } from '../../src/services/consolidationEngine.js';

describe('executeChunkedIn', () => {
  test('chunks array and executes queries correctly', async () => {
    const mockDb = {
      execute: mock.fn(async () => ({ rowsAffected: 5 })),
      query: mock.fn(),
      executeMany: mock.fn()
    };

    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);

    // @ts-ignore - access private method
    const rowsAffected = await consolidationEngine.executeChunkedIn(
      mockDb as any,
      'UPDATE table SET status = "superseded" WHERE id IN ({clause})',
      ids,
      { extra: 'bind' },
      'test_operation'
    );

    // 2500 items with default chunk size of 900 -> 3 chunks
    assert.strictEqual(mockDb.execute.mock.calls.length, 3);
    assert.strictEqual(rowsAffected, 15); // 3 * 5
  });

  test('handles edge case of exactly chunk size items', async () => {
    const mockDb = {
      execute: mock.fn(async () => ({ rowsAffected: 10 })),
      query: mock.fn(),
      executeMany: mock.fn()
    };

    const ids = Array.from({ length: 900 }, (_, i) => `id-${i}`); // exactly one default chunk

    // @ts-ignore - access private method
    const rowsAffected = await consolidationEngine.executeChunkedIn(
      mockDb as any,
      'UPDATE table SET status = "superseded" WHERE id IN ({clause})',
      ids,
      { extra: 'bind' },
      'test_operation'
    );

    // 900 items with default chunk size of 900 -> 1 chunk
    assert.strictEqual(mockDb.execute.mock.calls.length, 1);
    assert.strictEqual(rowsAffected, 10);
  });

  test('handles empty arrays gracefully without DB calls', async () => {
    const mockDb = {
      execute: mock.fn(async () => ({ rowsAffected: 0 })),
      query: mock.fn(),
      executeMany: mock.fn()
    };

    const ids: string[] = [];

    // @ts-ignore - access private method
    const rowsAffected = await consolidationEngine.executeChunkedIn(
      mockDb as any,
      'UPDATE table SET status = "superseded" WHERE id IN ({clause})',
      ids,
      { extra: 'bind' },
      'test_operation'
    );

    assert.strictEqual(mockDb.execute.mock.calls.length, 0);
    assert.strictEqual(rowsAffected, 0);
  });

  test('propagates errors with SQL context', async () => {
    const mockDb = {
      execute: mock.fn(async () => { throw new Error('DB Error'); }),
      query: mock.fn(),
      executeMany: mock.fn()
    };

    const ids = ['id-1', 'id-2'];

    try {
      // @ts-ignore - access private method
      await consolidationEngine.executeChunkedIn(
        mockDb as any,
        'UPDATE very_long_table_name_to_trigger_snippet SET status = "superseded" WHERE id IN ({clause})',
        ids,
        {},
        'test_operation'
      );
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.strictEqual(err.message, 'DB Error');
    }
  });
});
