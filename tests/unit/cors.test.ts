import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCorsOriginCallback } from '../../src/utils/corsOriginResolver.js';

describe('CORS Origin Logic', () => {
  // Helper to abstract the callback evaluation cleanly for tests
  const executeOriginCheck = (
    allowedList: string[],
    origin: string | undefined
  ): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      const originCallback = createCorsOriginCallback(allowedList);
      originCallback(origin, (err, allow) => {
        if (err) reject(err);
        else resolve(allow);
      });
    });
  };

  const wildcardAllowedList = ['https://example.com', '*'];

  test('rejects unknown domain when * is in the list', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'https://malicious.com'), false);
  });

  test('rejects known domain when * is in the list (fail-safe)', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'https://example.com'), false);
  });

  test('rejects trailing slash domain when * is in the list', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'https://example.com/'), false);
  });

  test('rejects origin with path component when * is in the list', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'https://example.com//path'), false);
  });

  test('rejects null domain (sandboxed iframe mitigation) when * is in the list', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'null'), false);
  });

  test('rejects invalid URI strings cleanly via catch block', async () => {
    assert.strictEqual(await executeOriginCheck(wildcardAllowedList, 'not a valid url'), false);
  });

  test('rejects unsupported protocols (e.g., file://, wss://) regardless of wildcard configuration', async () => {
    const allowedListWithoutWildcard = ['https://example.com'];
    const allowedListWithWildcard = ['https://example.com', '*'];

    // file:// protocol
    assert.strictEqual(await executeOriginCheck(allowedListWithoutWildcard, 'file:///etc/passwd'), false);
    assert.strictEqual(await executeOriginCheck(allowedListWithWildcard, 'file:///etc/passwd'), false);

    // wss:// protocol
    assert.strictEqual(await executeOriginCheck(allowedListWithoutWildcard, 'wss://example.com'), false);
    assert.strictEqual(await executeOriginCheck(allowedListWithWildcard, 'wss://example.com'), false);
  });

  test('rejects unknown origin when no wildcard is present', async () => {
    const allowedList = ['https://example.com'];

    // Test rejection of unknown domain
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://malicious.com'), false);
  });

  test('allows undefined origins (e.g. non-browser requests)', async () => {
    const allowedList = ['https://example.com'];

    // Test allowance of undefined origin
    assert.strictEqual(await executeOriginCheck(allowedList, undefined), true);
  });

  test('preserves explicit ports during origin evaluation', async () => {
    const allowedList = ['https://example.com:8443'];

    // Allows identical port match
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com:8443'), true);

    // Rejects implicit or omitted port mismatch
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com'), false);

    // Rejects mismatched explicit port
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com:8080'), false);
  });
});
