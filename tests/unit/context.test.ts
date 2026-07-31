import { test, describe } from 'node:test';
import assert from 'node:assert';
import { authStorage, AuthContext } from '../../src/utils/context.js';

describe('authStorage', () => {
  test('should return undefined when getStore is called outside of run', () => {
    const store = authStorage.getStore();
    assert.strictEqual(store, undefined, 'Store should be undefined outside of run block');
  });

  test('should return the correct context when getStore is called inside run', () => {
    const mockContext: AuthContext = {
      tier: 'premium',
      uid: 'user123',
      keyId: 'key456',
      email: 'user@example.com',
      role: 'admin'
    };

    authStorage.run(mockContext, () => {
      const store = authStorage.getStore();
      assert.deepStrictEqual(store, mockContext, 'Store should match the context passed to run');
    });
  });

  test('should maintain isolated contexts for concurrent executions', async () => {
    const context1: AuthContext = { tier: 'free', uid: 'user1', keyId: 'key1' };
    const context2: AuthContext = { tier: 'pro', uid: 'user2', keyId: 'key2' };

    let store1: AuthContext | undefined;
    let store2: AuthContext | undefined;

    const task1 = new Promise<void>((resolve) => {
      authStorage.run(context1, () => {
        setTimeout(() => {
          store1 = authStorage.getStore();
          resolve();
        }, 10);
      });
    });

    const task2 = new Promise<void>((resolve) => {
      authStorage.run(context2, () => {
        setTimeout(() => {
          store2 = authStorage.getStore();
          resolve();
        }, 5);
      });
    });

    await Promise.all([task1, task2]);

    assert.deepStrictEqual(store1, context1, 'Task 1 should retain its own context');
    assert.deepStrictEqual(store2, context2, 'Task 2 should retain its own context');
  });
});
