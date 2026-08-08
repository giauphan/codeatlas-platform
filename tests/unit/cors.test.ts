import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCorsOriginCallback } from '../../src/utils/corsOriginResolver.js';

describe('CORS Origin Logic', () => {
  test('handles wildcard correctly and allows valid origins', () => {
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

    // Test normalization (trailing slash) allowance of known domain
    originCallback('https://example.com/', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, true);

    // Test rejection of null domain with * in the list
    originCallback('null', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);

    // Test rejection of invalid URI
    originCallback('not a valid url', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);
  });

  test('rejects unsupported protocols (e.g., file://, wss://)', () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    let allowResult: boolean | undefined;

    // file:// protocol
    originCallback('file:///etc/passwd', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);

    // wss:// protocol
    originCallback('wss://example.com', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);
  });

  test('rejects unknown origin when no wildcard is present', () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    let allowResult: boolean | undefined;

    // Test rejection of unknown domain
    originCallback('https://malicious.com', (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, false);
  });

  test('allows undefined origins (e.g. non-browser requests)', () => {
    const allowedList = ['https://example.com'];
    const originCallback = createCorsOriginCallback(allowedList);

    let allowResult: boolean | undefined;

    // Test allowance of undefined origin
    originCallback(undefined, (err, allow) => { allowResult = allow; });
    assert.strictEqual(allowResult, true);
  });
});
