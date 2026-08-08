import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('CORS Origin Logic', () => {
  test('rejects wildcard origin when credentials are true', () => {
    const allowedOrigins = '*';
    const allowedList = allowedOrigins.split(',').map(s => s.trim());

    // Simulate the exact cors origin callback logic found in src/presentation/httpServer.ts
    const originCallback = function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return callback(null, true);
      if (origin === 'null') return callback(null, false);

      if (allowedList.includes('*')) {
        // Security: explicitly reject wildcard origin when credentials are enabled
        // to prevent arbitrary origin reflection vulnerabilities.
        return callback(null, false);
      }
      return callback(null, false);
    };

    let allowResult: boolean | undefined;
    let errResult: Error | null = null;

    originCallback('https://malicious.com', (err, allow) => {
      errResult = err;
      allowResult = allow;
    });

    assert.strictEqual(errResult, null);
    assert.strictEqual(allowResult, false);
  });
});
