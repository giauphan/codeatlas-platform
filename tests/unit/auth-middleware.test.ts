import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const opts = { exports: { default: mockObj, ...mockObj } };
  const specs = new Set<string>([specifier]);

  if (specifier.startsWith('/')) {
    specs.add(pathToFileURL(specifier).href);

    const basePath = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier.endsWith('.ts') ? specifier.slice(0, -2) : specifier;

    for (const p of [basePath + '.js', basePath + '.ts']) {
      specs.add(p);
      specs.add(pathToFileURL(p).href);
    }

    if (basePath.includes('/src/')) {
      for (const distPath of [basePath.replace('/src/', '/dist/'), basePath.replace('/src/', '/dist/src/')]) {
        for (const ext of ['.js', '.ts']) {
          const p = distPath + ext;
          specs.add(p);
          specs.add(pathToFileURL(p).href);
        }
      }
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

// 1. Mock firebase-admin/auth
const mockVerifyIdToken = mock.fn();
const getAuthMock = () => ({ verifyIdToken: mockVerifyIdToken });
const firebaseAuthMock = { getAuth: getAuthMock };
safeMockModule('firebase-admin/auth', firebaseAuthMock);

// 2. Mock firebase-admin/firestore to prevent side-effects
const getFirestoreMock = () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: false, data: () => ({}) }),
    }),
  }),
});
const firebaseFirestoreMock = { getFirestore: getFirestoreMock };
safeMockModule('firebase-admin/firestore', firebaseFirestoreMock);

// 3. Mock authService
const mockCheckAuth = async () => { throw new Error("Unauthorized"); };
const authServiceMock = { checkAuth: mockCheckAuth };
safeMockModule(path.join(srcDir, 'services/authService.js'), authServiceMock);

// 4. Mock logger
const mockLoggerObj = { error: mock.fn(), info: mock.fn(), warn: mock.fn() };
const loggerMock = { logger: mockLoggerObj };
safeMockModule(path.join(srcDir, 'utils/logger.js'), loggerMock);

// 5. Mock context
const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
safeMockModule(path.join(srcDir, 'utils/context.js'), { authStorage: mockAuthStore });

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
