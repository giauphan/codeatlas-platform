import assert from 'node:assert/strict';
import express from 'express';
import { test } from 'node:test';
import type { Server } from 'node:http';

test('sign-in requests from loopback remain subject to the auth rate limit', async () => {
  const previousAllowlist = process.env.CODEATLAS_AUTH_RATE_LIMIT_ALLOW_IPS;
  process.env.CODEATLAS_AUTH_RATE_LIMIT_ALLOW_IPS = '';
  const { authProxyRouter } = await import('../../src/routes/authProxy.js');
  if (previousAllowlist === undefined) delete process.env.CODEATLAS_AUTH_RATE_LIMIT_ALLOW_IPS;
  else process.env.CODEATLAS_AUTH_RATE_LIMIT_ALLOW_IPS = previousAllowlist;

  const app = express();
  app.use(express.json());
  app.use(authProxyRouter);
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/api/auth/signin`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400, 'first ten requests should reach input validation');
    }
    const limited = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(limited.status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
