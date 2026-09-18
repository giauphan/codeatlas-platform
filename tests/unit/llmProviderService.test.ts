import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LLMProviderService } from '../../src/services/llmProviderService.js';

describe('LLMProviderService', () => {
  const service = new LLMProviderService();

  test('should generate fallback template summary when provider is template or no key', async () => {
    const summary = await service.summarizeModule('AuthService', {
      functions: ['login', 'register', 'verifyToken'],
      dependencies: ['bcrypt', 'jsonwebtoken'],
      filePath: 'src/services/authService.ts'
    }, { provider: 'template' });

    assert.ok(summary.includes('AuthService'));
    assert.ok(summary.includes('login'));
    assert.ok(summary.includes('bcrypt'));
  });

  test('should handle custom prompt generation with template fallback', async () => {
    const result = await service.generateText({
      prompt: 'Explain what this module does: functions=[a, b]',
      provider: 'template'
    });
    assert.ok(result.length > 0);
  });

  test('should fallback to template when provider has no API key', async () => {
    const result = await service.generateText({
      prompt: 'Summarize test module',
      provider: 'anthropic',
      apiKey: ''
    });
    assert.ok(result.length > 0);
  });

  test('should fallback to template for summarizeModule when apiKey is missing', async () => {
    const summary = await service.summarizeModule('UserService', {
      classes: ['UserManager'],
      functions: ['getUser', 'createUser'],
      dependencies: ['sqlite3'],
      filePath: 'src/services/userService.ts'
    }, { provider: 'openai', apiKey: '' });

    assert.ok(summary.includes('UserService'));
    assert.ok(summary.includes('UserManager'));
    assert.ok(summary.includes('getUser'));
    assert.ok(summary.includes('sqlite3'));
  });

  test('should call custom openai-compatible endpoint when configured with mock fetch', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Mocked API response' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch;

      const result = await service.generateText({
        prompt: 'Hello LLM',
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'test-key'
      });
      assert.strictEqual(result, 'Mocked API response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('should call anthropic endpoint when configured with mock fetch', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        return new Response(JSON.stringify({
          content: [{ text: 'Mocked Anthropic response' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch;

      const result = await service.generateText({
        prompt: 'Hello Claude',
        provider: 'anthropic',
        apiKey: 'test-anthropic-key'
      });
      assert.strictEqual(result, 'Mocked Anthropic response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('should call openai endpoint when configured with mock fetch', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Mocked OpenAI response' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch;

      const result = await service.generateText({
        prompt: 'Hello GPT',
        provider: 'openai',
        apiKey: 'test-openai-key'
      });
      assert.strictEqual(result, 'Mocked OpenAI response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('should fallback to template when network call fails', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error('Network error');
      }) as typeof globalThis.fetch;

      const result = await service.generateText({
        prompt: 'Fallback prompt',
        provider: 'openai',
        apiKey: 'test-key'
      });
      assert.ok(result.includes('Fallback prompt'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('SSRF: rejects file: protocol URLs', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url.toString();
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Mocked API response' } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch;

      await service.generateText({
        prompt: 'ssrf test',
        provider: 'openai-compatible',
        baseUrl: 'file:///etc/passwd/v1/chat/completions',
        apiKey: 'test-key'
      });
      // Should reject file: protocol, falling back safely to default localhost Ollama URL without reading file scheme
      assert.strictEqual(capturedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('SSRF: rejects unrecognized hosts and falls back to default URL', async () => {
    let capturedUrl = '';
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = url.toString();
        return new Response('', { status: 500 });
      }) as typeof globalThis.fetch;

      await service.generateText({
        prompt: 'ssrf test 2',
        provider: 'openai-compatible',
        baseUrl: 'https://malicious.evil.com/v1/chat/completions',
        apiKey: 'test-key'
      });
      assert.strictEqual(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
