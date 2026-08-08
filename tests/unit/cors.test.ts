import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCorsOriginCallback } from '../../src/utils/corsOriginResolver.js';

describe('CORS Origin Logic', () => {
  test('rejects wildcard origin when credentials are true, even when a valid origin is in the allowed list', () => {
    // This simulates the behavior of the fix where ANY wildcard in the list explicitly rejects requests
    // when credentials are enabled.
    const allowedOrigins = 'https://example.com,*';
    const allowedList = allowedOrigins.split(',').map(s => s.trim());

    const originCallback = createCorsOriginCallback(allowedList);

    let allowResult: boolean | undefined;

    // Test rejection of unknown domain with * in the list
    originCallback('https://malicious.com', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);

    // Test allowance of known domain with * in the list
    originCallback('https://example.com', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, true);

    // Test rejection of null domain with * in the list
    originCallback('null', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);

    // Test rejection of invalid URI
    originCallback('not a valid url', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);
  });
});
