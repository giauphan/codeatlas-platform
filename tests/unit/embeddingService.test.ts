import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateEmbedding, generateEmbeddingsBatch } from '../../src/services/embeddingService.js';

describe('Embedding Service', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restoreAll();
  });

  describe('generateEmbedding', () => {
    test('returns null if NVIDIA_API_KEY is not set', async () => {
      delete process.env.NVIDIA_API_KEY;
      const result = await generateEmbedding('test text', 'passage');
      assert.strictEqual(result, null);
    });

    test('returns embedding on successful API call', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      const mockResponse = {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
        model: 'nvidia/nv-embed-v1',
        usage: { prompt_tokens: 10, total_tokens: 10 }
      };

      mock.method(global, 'fetch', async () => {
        return {
          ok: true,
          json: async () => mockResponse
        };
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.deepStrictEqual(result, [0.1, 0.2, 0.3]);
    });

    test('returns null on non-OK API response', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';

      mock.method(global, 'fetch', async () => {
        return {
          ok: false,
          status: 400,
          text: async () => 'Bad Request'
        };
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.strictEqual(result, null);
    });

    test('returns null on connection error', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';

      mock.method(global, 'fetch', async () => {
        throw new Error('Connection failed');
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.strictEqual(result, null);
    });
  });

  describe('generateEmbeddingsBatch', () => {
    test('returns null if NVIDIA_API_KEY is not set', async () => {
      delete process.env.NVIDIA_API_KEY;
      const result = await generateEmbeddingsBatch(['test text'], 'passage');
      assert.strictEqual(result, null);
    });

    test('returns embeddings on successful API call', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      const mockResponse = {
        data: [
          { embedding: [0.1, 0.2], index: 0, object: 'embedding' },
          { embedding: [0.3, 0.4], index: 1, object: 'embedding' }
        ],
        model: 'nvidia/nv-embed-v1',
        usage: { prompt_tokens: 20, total_tokens: 20 }
      };

      mock.method(global, 'fetch', async () => {
        return {
          ok: true,
          json: async () => mockResponse
        };
      });

      const result = await generateEmbeddingsBatch(['test1', 'test2'], 'passage');
      assert.deepStrictEqual(result, [[0.1, 0.2], [0.3, 0.4]]);
    });

    test('handles chunking correctly', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';

      const mockResponse1 = {
        data: Array.from({ length: 50 }, (_, i) => ({ embedding: [i], index: i, object: 'embedding' }))
      };
      const mockResponse2 = {
        data: [{ embedding: [50], index: 0, object: 'embedding' }]
      };

      let callCount = 0;
      mock.method(global, 'fetch', async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => mockResponse1 };
        } else {
          return { ok: true, json: async () => mockResponse2 };
        }
      });

      // chunk size is 50, so passing 51 texts should result in 2 fetch calls
      const texts = Array.from({ length: 51 }, (_, i) => `test${i}`);
      const result = await generateEmbeddingsBatch(texts, 'passage');

      assert.strictEqual(callCount, 2);
      assert.ok(result);
      assert.strictEqual(result.length, 51);
      assert.deepStrictEqual(result[0], [0]);
      assert.deepStrictEqual(result[50], [50]);
    });

    test('returns null on non-OK API response in batch', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';

      mock.method(global, 'fetch', async () => {
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error'
        };
      });

      const result = await generateEmbeddingsBatch(['test text'], 'passage');
      assert.strictEqual(result, null);
    });

    test('returns null on connection error in batch', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';

      mock.method(global, 'fetch', async () => {
        throw new Error('Connection failed');
      });

      const result = await generateEmbeddingsBatch(['test text'], 'passage');
      assert.strictEqual(result, null);
    });
  });
});
