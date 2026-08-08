import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCorsOriginCallback } from '../../src/utils/corsOriginResolver.js';

describe('CORS Origin Logic', () => {
  test('handles wildcard correctly and allows valid origins asynchronously', async () => {
    const allowedOrigins = 'https://example.com,*';
    const allowedList = allowedOrigins.split(',').map(s => s.trim());

    const originCallback = createCorsOriginCallback(allowedList);

    const testOriginAsync = (origin: string | undefined): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        // Wrap in setImmediate to simulate CORS middleware asynchronous execution
        setImmediate(() => {
          originCallback(origin, (err, allow) => {
            if (err) reject(err);
            else resolve(allow);
          });
        });
      });
    };

    // Test rejection of unknown domain with * in the list
    assert.strictEqual(await testOriginAsync('https://malicious.com'), false);

    // Test allowance of known domain with * in the list
    assert.strictEqual(await testOriginAsync('https://example.com'), true);

    // Test normalization (trailing slash) allowance of known domain
    assert.strictEqual(await testOriginAsync('https://example.com/'), true);

    // Test double slash normalization allowance
    assert.strictEqual(await testOriginAsync('https://example.com//path'), true);

    // Test rejection of null domain with * in the list
    assert.strictEqual(await testOriginAsync('null'), false);

    // Test rejection of invalid URI
    assert.strictEqual(await testOriginAsync('not a valid url'), false);
  });

  test('rejects unsupported protocols (e.g., file://, wss://) asynchronously', async () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    const testOriginAsync = (origin: string | undefined): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          originCallback(origin, (err, allow) => {
            if (err) reject(err);
            else resolve(allow);
          });
        });
      });
    };

    // file:// protocol
    assert.strictEqual(await testOriginAsync('file:///etc/passwd'), false);

    // wss:// protocol
    assert.strictEqual(await testOriginAsync('wss://example.com'), false);
  });

  test('rejects unknown origin when no wildcard is present asynchronously', async () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    const testOriginAsync = (origin: string | undefined): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          originCallback(origin, (err, allow) => {
            if (err) reject(err);
            else resolve(allow);
          });
        });
      });
    };

    // Test rejection of unknown domain
    assert.strictEqual(await testOriginAsync('https://malicious.com'), false);
  });

  test('allows undefined origins (e.g. non-browser requests) asynchronously', async () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    const testOriginAsync = (origin: string | undefined): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          originCallback(origin, (err, allow) => {
            if (err) reject(err);
            else resolve(allow);
          });
        });
      });
    };

    // Test allowance of undefined origin
    assert.strictEqual(await testOriginAsync(undefined), true);
  });
});
