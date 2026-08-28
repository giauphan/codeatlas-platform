import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('Embedding Service', async () => {
  const { generateEmbedding, generateEmbeddingsBatch } = await import('../../src/services/embeddingService.js');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    // Deterministic single-provider chain for most tests.
    process.env.EMBEDDING_MODELS = 'nvidia/test-model';
    delete process.env.EMBEDDING_DIM;
    delete process.env.NVIDIA_EMBEDDING_DIM;
    delete process.env.NVIDIA_EMBEDDING_MODELS;
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restoreAll();
  });

  describe('generateEmbedding', () => {
    test('returns null when no provider API key is set', async () => {
      delete process.env.NVIDIA_API_KEY;
      delete process.env.MISTRAL_API_KEY;
      const result = await generateEmbedding('test text', 'passage');
      assert.strictEqual(result, null);
    });

    test('returns embedding on successful API call', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      process.env.EMBEDDING_DIM = '3';
      const mockResponse = {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
        model: 'nvidia/test-model',
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

    test('rotates to the next model when one returns an error', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      process.env.EMBEDDING_MODELS = 'nvidia/model-a,nvidia/model-b';
      process.env.EMBEDDING_DIM = '1';

      const usedModels: string[] = [];
      mock.method(global, 'fetch', async (_url: string, init: any) => {
        usedModels.push(JSON.parse(init.body).model);
        if (usedModels.length === 1) {
          return { ok: false, status: 410, url: 'x', statusText: 'Gone' };
        }
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.5], index: 0, object: 'embedding' }] })
        };
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.deepStrictEqual(result, [0.5]);
      assert.strictEqual(usedModels.length, 2);
      assert.notStrictEqual(usedModels[0], usedModels[1]);
    });

    test('falls over from NVIDIA to Mistral using the right host and body', async () => {
      process.env.EMBEDDING_MODELS = 'nvidia/nv-model,mistral/mistral-embed';
      process.env.EMBEDDING_DIM = '2';
      process.env.NVIDIA_API_KEY = 'nv_key';
      process.env.MISTRAL_API_KEY = 'mistral_key';

      const calls: { url: string; body: any }[] = [];
      mock.method(global, 'fetch', async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        if (body.model === 'nvidia/nv-model') {
          return { ok: false, status: 410, url, statusText: 'Gone' };
        }
        // Mistral success
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.7, 0.8], index: 0, object: 'embedding' }] })
        };
      });

      const result = await generateEmbedding('trace feature flow', 'query');
      assert.deepStrictEqual(result, [0.7, 0.8]);
      assert.strictEqual(calls.length, 2);

      // NVIDIA call: NVIDIA host + NVIDIA-shaped body.
      assert.match(calls[0].url, /integrate\.api\.nvidia\.com/);
      assert.strictEqual(calls[0].body.input_type, 'query');
      assert.strictEqual(calls[0].body.dimensions, 2);

      // Mistral call: Mistral host + Mistral-shaped body. `mistral-embed`
      // rejects output_dimension (400 code 3051), so it must be omitted.
      assert.match(calls[1].url, /api\.mistral\.ai/);
      assert.strictEqual(calls[1].body.output_dimension, undefined);
      assert.strictEqual(calls[1].body.input_type, undefined);
    });

    test('sends output_dimension only for codestral-embed models', async () => {
      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed';
      process.env.EMBEDDING_DIM = '2';
      process.env.MISTRAL_API_KEY = 'mistral_key';

      let sentBody: any;
      mock.method(global, 'fetch', async (_url: string, init: any) => {
        sentBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0, object: 'embedding' }] })
        };
      });

      const result = await generateEmbedding('const x = 1;', 'passage');
      assert.deepStrictEqual(result, [0.1, 0.2]);
      assert.strictEqual(sentBody.output_dimension, 2);
    });

    test('rotates to the next API key on 401 for the same model', async () => {
      process.env.EMBEDDING_MODELS = 'mistral/mistral-embed';
      process.env.EMBEDDING_DIM = '1';
      process.env.MISTRAL_API_KEY = 'bad_key,good_key';

      const usedKeys: string[] = [];
      mock.method(global, 'fetch', async (url: string, init: any) => {
        usedKeys.push(String(init.headers.Authorization).replace('Bearer ', ''));
        if (usedKeys.length === 1) {
          return { ok: false, status: 401, url, statusText: 'Unauthorized' };
        }
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.4], index: 0, object: 'embedding' }] })
        };
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.deepStrictEqual(result, [0.4]);
      assert.deepStrictEqual(usedKeys, ['bad_key', 'good_key']);
    });

    test('skips a provider whose API key is missing', async () => {
      process.env.EMBEDDING_MODELS = 'mistral/mistral-embed,nvidia/nv-model';
      process.env.EMBEDDING_DIM = '1';
      delete process.env.MISTRAL_API_KEY; // mistral skipped
      process.env.NVIDIA_API_KEY = 'nv_key';

      const calls: any[] = [];
      mock.method(global, 'fetch', async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.9], index: 0, object: 'embedding' }] })
        };
      });

      const result = await generateEmbedding('test text', 'passage');
      assert.deepStrictEqual(result, [0.9]);
      // Only the NVIDIA model was actually called.
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].url, /integrate\.api\.nvidia\.com/);
    });

    test('rejects an embedding whose dimension does not match the schema', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      process.env.EMBEDDING_MODELS = 'nvidia/model-a';
      process.env.EMBEDDING_DIM = '1024';

      mock.method(global, 'fetch', async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0, object: 'embedding' }] })
      }));

      const result = await generateEmbedding('test text', 'passage');
      assert.strictEqual(result, null);
    });
  });

  describe('generateEmbeddingsBatch', () => {
    test('returns null when no provider API key is set', async () => {
      delete process.env.NVIDIA_API_KEY;
      delete process.env.MISTRAL_API_KEY;
      const result = await generateEmbeddingsBatch(['test text'], 'passage');
      assert.strictEqual(result, null);
    });

    test('returns embeddings on successful API call', async () => {
      process.env.NVIDIA_API_KEY = 'test_key';
      process.env.EMBEDDING_DIM = '2';
      const mockResponse = {
        data: [
          { embedding: [0.1, 0.2], index: 0, object: 'embedding' },
          { embedding: [0.3, 0.4], index: 1, object: 'embedding' }
        ],
        model: 'nvidia/test-model',
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
      process.env.EMBEDDING_DIM = '1';

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
