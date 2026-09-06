import { test, describe, before, after, mock, beforeEach } from 'node:test';
import assert from 'node:assert';

// Dynamic import to handle ES modules properly
const embeddingModule = await import('../../src/services/embeddingService.js');
const {
  generateEmbedding,
  generateEmbeddingsBatch,
  _validateEmbeddingConfigurationForTesting,
  _resetCooldownsForTesting
} = embeddingModule;

function clearEnvironment() {
  const varsToClear = ['MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'EMBEDDING_MODELS', 'NVIDIA_EMBEDDING_MODELS', 'EMBEDDING_DIM'];
  varsToClear.forEach(varName => delete process.env[varName]);
}

function mockSuccessfulFetch(embeddings: number[][], modelName = 'test-model') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: embeddings.map((emb, idx) => ({
        embedding: emb,
        index: idx,
        object: 'embedding'
      })),
      model: modelName,
      usage: { prompt_tokens: 10, total_tokens: 10 }
    })
  };
}

describe('Embedding Service Fixes & Reliability', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof global.fetch;
  const testEmbedding = Array(1024).fill(0.1);

  before(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
  });

  after(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    clearEnvironment();
    _resetCooldownsForTesting();
  });

  describe('Configuration Validation', () => {
    test('should validate configuration with exported test helper', async () => {
      const loggerModule = await import('../../src/utils/logger.js');
      const loggerWarnSpy = mock.method(loggerModule.logger, 'warn', () => {});
      const loggerErrorSpy = mock.method(loggerModule.logger, 'error', () => {});

      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed,nvidia/llama-nemotron-embed-vl-1b-v2';
      // Missing API keys
      _validateEmbeddingConfigurationForTesting();

      assert.ok(loggerWarnSpy.mock.callCount() >= 2, 'Should warn about missing keys');
      assert.ok(loggerErrorSpy.mock.callCount() >= 2, 'Should error on missing required keys');

      mock.restoreAll();
    });
  });

  describe('Incompatible Model Filtering', () => {
    test('should filter out nvidia/nemotron-3-embed-1b and fallback to next valid model', async () => {
      let requestedModel = '';
      global.fetch = mock.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        requestedModel = body.model;
        return mockSuccessfulFetch([testEmbedding], body.model);
      });

      process.env.NVIDIA_API_KEY = 'test-nvidia-key';
      process.env.EMBEDDING_MODELS = 'nvidia/nemotron-3-embed-1b,nvidia/llama-nemotron-embed-vl-1b-v2';

      const result = await generateEmbedding('test text', 'passage');
      assert.ok(result !== null, 'Should return valid embedding from fallback');
      assert.strictEqual(requestedModel, 'nvidia/llama-nemotron-embed-vl-1b-v2', 'Should call the compatible fallback model instead');
    });
  });

  describe('NVIDIA Dimensions Parameter Handling', () => {
    test('should include dimensions parameter for compatible NVIDIA models', async () => {
      let lastRequestBody: any = null;
      global.fetch = mock.fn(async (url, options) => {
        lastRequestBody = JSON.parse(options.body);
        return mockSuccessfulFetch([testEmbedding], lastRequestBody.model);
      });

      process.env.NVIDIA_API_KEY = 'test-key';
      process.env.EMBEDDING_MODELS = 'nvidia/llama-nemotron-embed-vl-1b-v2';
      process.env.EMBEDDING_DIM = '1024';

      const result = await generateEmbedding('test', 'passage');
      assert.ok(result !== null);
      assert.strictEqual(lastRequestBody.dimensions, 1024, 'Dimensions should be sent');
    });

    test('should not include dimensions parameter for unsupported NVIDIA models', async () => {
      let lastRequestBody: any = null;
      global.fetch = mock.fn(async (url, options) => {
        lastRequestBody = JSON.parse(options.body);
        return mockSuccessfulFetch([testEmbedding], lastRequestBody.model);
      });

      process.env.NVIDIA_API_KEY = 'test-key';
      process.env.EMBEDDING_MODELS = 'nvidia/some-unsupported-model';

      const result = await generateEmbedding('test', 'passage');
      assert.ok(result !== null);
      assert.strictEqual(lastRequestBody.dimensions, undefined, 'Dimensions should not be sent');
    });
  });

  describe('Rate Limiting (429) & Retry-After Logic', () => {
    test('should retry 429 and eventually succeed', async () => {
      let callCount = 0;
      global.fetch = mock.fn(async (url, options) => {
        callCount++;
        if (callCount < 3) {
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers({ 'retry-after': '0' }),
            json: async () => ({ error: 'Rate limit exceeded' })
          };
        }
        return mockSuccessfulFetch([testEmbedding]);
      });

      process.env.MISTRAL_API_KEY = 'test-mistral-key';
      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed';

      const result = await generateEmbedding('retry me', 'passage');
      assert.ok(result !== null, 'Should succeed after retry');
      assert.strictEqual(callCount, 3, 'Should retry until successful');
    });

    test('should rotate keys on 401/403 errors', async () => {
      const keysUsed: string[] = [];
      global.fetch = mock.fn(async (url, options) => {
        const auth = options.headers['Authorization'];
        keysUsed.push(auth);
        if (keysUsed.length === 1) {
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({ error: 'Invalid API Key' })
          };
        }
        return mockSuccessfulFetch([testEmbedding]);
      });

      process.env.MISTRAL_API_KEY = 'key-1,key-2';
      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed';

      const result = await generateEmbedding('auth rotate', 'passage');
      assert.ok(result !== null, 'Should succeed with secondary key');
      assert.deepStrictEqual(keysUsed, ['Bearer key-1', 'Bearer key-2']);
    });
  });

  describe('Batching and Failover', () => {
    test('should split input into chunks of 50 and aggregate results', async () => {
      let batchSizes: number[] = [];
      global.fetch = mock.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        batchSizes.push(body.input.length);
        return mockSuccessfulFetch(body.input.map(() => testEmbedding));
      });

      process.env.MISTRAL_API_KEY = 'test-key';
      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed';

      const texts = Array(105).fill('sample text');
      const results = await generateEmbeddingsBatch(texts, 'passage');

      assert.ok(results !== null);
      assert.strictEqual(results.length, 105);
      assert.deepStrictEqual(batchSizes, [50, 50, 5], 'Should chunk into 50, 50, 5');
    });

    test('should failover to secondary model if primary model fails with non-retryable error', async () => {
      const modelsCalled: string[] = [];
      global.fetch = mock.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        modelsCalled.push(body.model);
        if (body.model.includes('codestral')) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ error: 'Fatal' })
          };
        }
        return mockSuccessfulFetch([testEmbedding], body.model);
      });

      process.env.MISTRAL_API_KEY = 'test-mistral-key';
      process.env.NVIDIA_API_KEY = 'test-nvidia-key';
      process.env.EMBEDDING_MODELS = 'mistral/codestral-embed,nvidia/llama-nemotron-embed-vl-1b-v2';

      const result = await generateEmbedding('failover test', 'passage');
      assert.ok(result !== null, 'Should succeed using failover model');
      assert.ok(modelsCalled.includes('codestral-embed') || modelsCalled.includes('mistral/codestral-embed'));
      assert.ok(modelsCalled.includes('llama-nemotron-embed-vl-1b-v2') || modelsCalled.includes('nvidia/llama-nemotron-embed-vl-1b-v2'));
    });
  });
});
