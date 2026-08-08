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

  test('handles wildcard correctly and allows valid origins', async () => {
    const allowedList = ['https://example.com', '*'];

    // Test rejection of unknown domain with * in the list
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://malicious.com'), false);

    // Test allowance of known domain with * in the list
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com'), true);

    // Test normalization (trailing slash) allowance of known domain
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com/'), true);

    // Test double slash normalization allowance
    assert.strictEqual(await executeOriginCheck(allowedList, 'https://example.com//path'), true);

    // Test rejection of null domain with * in the list
    assert.strictEqual(await executeOriginCheck(allowedList, 'null'), false);

    // Test rejection of invalid URI
    assert.strictEqual(await executeOriginCheck(allowedList, 'not a valid url'), false);
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
});
