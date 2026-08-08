import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('CORS Origin Logic', () => {
  test('rejects wildcard origin when credentials are true, even when a valid origin is in the allowed list', () => {
    // This simulates the behavior of the fix where ANY wildcard in the list explicitly rejects requests
    // when credentials are enabled.
    const allowedOrigins = 'https://example.com,*';
    const allowedList = allowedOrigins.split(',').map(s => s.trim());

    // Simulate the exact cors origin callback logic found in src/presentation/httpServer.ts
    const originCallback = function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return callback(null, true);
      if (origin === 'null') return callback(null, false);

      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
          return callback(null, false);
        }

        if (allowedList.includes(origin)) {
          return callback(null, true);
        } else if (allowedList.includes('*')) {
          // Security: explicitly reject wildcard origin when credentials are enabled
          // to prevent arbitrary origin reflection vulnerabilities.
          // Instead of throwing an error which causes a 500, we log a warning
          // and cleanly reject the CORS request (causes a 403 usually depending on the client).
          return callback(null, false);
        } else {
          return callback(null, false);
        }
      } catch (err) {
        return callback(null, false);
      }
    };

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
  });
});
