import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import express from 'express';

const srcDir = path.resolve(import.meta.dirname, '../../src');

// 1. Mock firebase-admin/auth
const mockVerifyIdToken = mock.fn();
const getAuthMock = () => ({ verifyIdToken: mockVerifyIdToken });
mock.module('firebase-admin/auth', {
  default: { getAuth: getAuthMock },
  exports: { getAuth: getAuthMock },
});

// 2. Mock firebase-admin/firestore to prevent side-effects
const getFirestoreMock = () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: false, data: () => ({}) }),
    }),
  }),
});
mock.module('firebase-admin/firestore', {
  default: { getFirestore: getFirestoreMock },
  exports: { getFirestore: getFirestoreMock },
});

// 3. Mock authService
const mockCheckAuth = async () => { throw new Error("Unauthorized"); };
const authServiceMock = { checkAuth: mockCheckAuth };
mock.module(path.join(srcDir, 'services/authService.js'), {
  default: authServiceMock,
  exports: authServiceMock,
});

// 4. Mock logger
const mockLoggerObj = { error: mock.fn(), info: mock.fn(), warn: mock.fn() };
const loggerMock = { logger: mockLoggerObj };
mock.module(path.join(srcDir, 'utils/logger.js'), {
  default: loggerMock,
  exports: loggerMock,
});

// Now import the middleware to test
// Note: We need to use dynamic import to ensure mocks are applied before the module is evaluated
describe('Auth Middleware', async () => {
  const { authMiddleware } = await import('../../src/middleware/auth.js');

  test('should return 401 when Firebase ID token is invalid', async () => {
    const errorMessage = 'Firebase ID token has expired. Get a fresh id token from your client app.';
    mockVerifyIdToken.mock.mockImplementation(async () => {
      throw new Error(errorMessage);
    });

    // Create mock Request, Response, NextFunction
    const req = {
      headers: {
        authorization: 'Bearer invalid_token_123',
      },
    } as unknown as express.Request;

    const res = {
      status: mock.fn(() => res),
      json: mock.fn(),
    } as unknown as express.Response;

    const next = mock.fn() as express.NextFunction;

    // Call the middleware
    await authMiddleware(req, res, next);

    // Assertions
    assert.strictEqual(mockVerifyIdToken.mock.calls.length, 1);
    assert.strictEqual(mockVerifyIdToken.mock.calls[0].arguments[0], 'invalid_token_123');

    assert.strictEqual((res.status as any).mock.calls.length, 1);
    assert.strictEqual((res.status as any).mock.calls[0].arguments[0], 401);

    assert.strictEqual((res.json as any).mock.calls.length, 1);
    assert.deepStrictEqual((res.json as any).mock.calls[0].arguments[0], {
      error: `Invalid Firebase ID Token: ${errorMessage}`,
    });

    assert.strictEqual(next.mock.calls.length, 0);
  });
});
