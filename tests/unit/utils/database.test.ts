import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchExecuteMany, validateRows, FatalErrorTypes } from '../../../src/database/utils.js';
import { BatchExecutionError } from '../../../src/utils/errors.js';

describe('Database Utils', () => {
  describe('validateRows', () => {
    it('validates rows based on expected types', () => {
      const rows = [{ id: '1', count: 5 }, { id: '2', count: 10 }];
      assert.doesNotThrow(() => validateRows(rows, { id: 'string', count: 'number' }));
    });

    it('throws error for invalid type', () => {
      const rows = [{ id: 1, count: 5 }];
      assert.throws(() => validateRows(rows, { id: 'string' as const }), /expected string, got number/);
    });

    it('throws error for empty string', () => {
      const rows = [{ id: '' }];
      assert.throws(() => validateRows(rows, { id: 'string' as const }), /must not be an empty string/);
    });

    it('limits validation to sampleSize', () => {
      const rows = [{ id: '1' }, { id: 2 }];
      // Should not throw because sampleSize is 1, so it only checks the first row
      assert.doesNotThrow(() => validateRows(rows, { id: 'string' as const }, 1));
    });
  });

  describe('batchExecuteMany', () => {
    it('executes empty rows without error', async () => {
      let executeCalled = false;
      const db = {
        executeMany: async () => { executeCalled = true; return { rowsAffected: 0 }; }
      };
      await assert.doesNotReject(() => batchExecuteMany(db, 'INSERT...', []));
      assert.strictEqual(executeCalled, false);
    });

    it('executes in chunks', async () => {
      let executionCount = 0;
      const db = {
        executeMany: async (sql: string, params: any[]) => {
          executionCount++;
          assert.strictEqual(params.length <= 2, true);
          return { rowsAffected: params.length };
        }
      };
      const rows = [{id: 1}, {id: 2}, {id: 3}, {id: 4}, {id: 5}];
      await batchExecuteMany(db, 'INSERT', rows, { chunkSize: 2 });
      assert.strictEqual(executionCount, 3);
    });

    it('retries on transient failure', async () => {
      let executionCount = 0;
      const db = {
        executeMany: async () => {
          executionCount++;
          if (executionCount < 2) throw new Error('Transient error');
          return { rowsAffected: 1 };
        }
      };
      const rows = [{id: 1}];
      await batchExecuteMany(db, 'INSERT', rows, { maxRetries: 3, retryBaseDelayMs: 10, retryJitterMs: 0 });
      assert.strictEqual(executionCount, 2);
    });

    it('honors continueOnError by swallowing terminal batch errors', async () => {
      let executionCount = 0;
      const db = {
        executeMany: async (sql: string, params: any[]) => {
          executionCount++;
          // Fail deterministically for chunk index 1
          if (params[0].id === 3) {
            throw new Error('Persistent error chunk 2');
          }
          return { rowsAffected: params.length };
        }
      };
      const rows = [{id: 1}, {id: 2}, {id: 3}, {id: 4}, {id: 5}];

      // We expect the function to resolve successfully, despite chunk 2 failing 2 times.
      await assert.doesNotReject(() =>
        batchExecuteMany(db, 'INSERT', rows, {
          chunkSize: 2,
          maxRetries: 2,
          retryBaseDelayMs: 1,
          retryJitterMs: 0,
          continueOnError: true
        })
      );

      // execution count = 1 (chunk 0) + 2 (chunk 1 failed 2x) + 1 (chunk 2) = 4
      assert.strictEqual(executionCount, 4);
    });

    it('throws BatchExecutionError on fatal failure', async () => {
      const db = {
        executeMany: async () => {
          const err = new Error('Syntax error') as any;
          err.name = FatalErrorTypes.SYNTAX_ERROR;
          throw err;
        }
      };
      const rows = [{id: 1}];
      await assert.rejects(
        () => batchExecuteMany(db, 'INSERT', rows),
        (err) => err instanceof BatchExecutionError && err.failedChunkIndex === 0
      );
    });

    it('throws BatchExecutionError after max retries', async () => {
      let executionCount = 0;
      const db = {
        executeMany: async () => {
          executionCount++;
          throw new Error('Persistent error');
        }
      };
      const rows = [{id: 1}];
      await assert.rejects(
        () => batchExecuteMany(db, 'INSERT', rows, { maxRetries: 2, retryBaseDelayMs: 1, retryJitterMs: 0 }),
        (err) => err instanceof BatchExecutionError
      );
      assert.strictEqual(executionCount, 2); // attempt 0, attempt 1 (2 attempts total for maxRetries=2)
    });
  });
});
