import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { generateEmbedding } from '../../src/services/embeddingService.js';
import { logger } from '../../src/utils/logger.js';

describe('Embedding Service', () => {
  const originalEnv = process.env;

  before(() => {
    process.env = { ...originalEnv };
    process.env.NVIDIA_API_KEY = 'test-api-key';
  });

  after(() => {
    process.env = originalEnv;
  });

  describe('generateEmbedding()', () => {
    test('returns null when connection error occurs', async () => {
      // Mock logger to avoid cluttering test output
      mock.method(logger, 'error', () => {});

      // Mock global.fetch to throw an error
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => {
        throw new Error('Connection failed');
      });

      try {
        const result = await generateEmbedding('test text', 'passage');

        assert.strictEqual(result, null);
        assert.strictEqual((logger.error as any).mock.calls.length, 1);
        assert.ok((logger.error as any).mock.calls[0].arguments[0].includes('Connection error'));
      } finally {
        global.fetch = originalFetch;
        (logger.error as any).mock.restore();
      }
    });
  });
});
