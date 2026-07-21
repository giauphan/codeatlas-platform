import { test, describe } from 'node:test';
import assert from 'node:assert';
import { 
  AuthenticateUserUseCase, 
  LogTelemetryUseCase, 
  IAuthRepository, 
  IActivityLogger, 
  AuthData,
  FirestoreAuthRepository
} from '../../src/repositories.js';

describe('Clean Architecture Repositories & Use Cases', () => {

  // A fully mock implementation of IAuthRepository for strict logic isolation
  class MockAuthRepository implements IAuthRepository {
    public callsToVerifyKey = 0;
    public callsToUpdateLastUsed = 0;
    public keysMap = new Map<string, { uid: string; keyId: string }>();

    async verifyKey(apiKey: string): Promise<AuthData | null> {
      this.callsToVerifyKey++;
      const found = this.keysMap.get(apiKey);
      if (!found) return null;
      return {
        tier: 'enterprise',
        uid: found.uid,
        keyId: found.keyId,
        expires: 0
      };
    }

    async updateLastUsed(uid: string, keyId: string): Promise<void> {
      this.callsToUpdateLastUsed++;
    }
  }

  // A fully mock implementation of IActivityLogger for strict logic isolation
  class MockActivityLogger implements IActivityLogger {
    public logs: { uid: string; keyId: string; tool: string; params: any; success: boolean }[] = [];

    async logActivity(uid: string, keyId: string, tool: string, params: any, success: boolean): Promise<void> {
      this.logs.push({ uid, keyId, tool, params, success });
    }
  }

  test('should authenticate super admin using bypass logic', async () => {
    const mockRepo = new MockAuthRepository();
    const useCase = new AuthenticateUserUseCase(mockRepo);
    
    const adminKey = 'super_admin_secret_token';
    const auth = await useCase.execute(adminKey, adminKey);

    assert.strictEqual(auth.uid, 'admin');
    assert.strictEqual(auth.tier, 'enterprise');
    assert.strictEqual(auth.keyId, 'admin');
    assert.strictEqual(mockRepo.callsToVerifyKey, 1, 'Should query repository first to try resolving real uid');
  });

  test('should authenticate standard tenant key and update usage stats', async () => {
    const mockRepo = new MockAuthRepository();
    mockRepo.keysMap.set('client_api_key_123', { uid: 'tenant_abc', keyId: 'key_xyz' });

    const useCase = new AuthenticateUserUseCase(mockRepo);
    const auth = await useCase.execute('client_api_key_123', 'different_admin_key');

    assert.strictEqual(auth.uid, 'tenant_abc');
    assert.strictEqual(auth.keyId, 'key_xyz');
    assert.strictEqual(auth.tier, 'enterprise');
    assert.strictEqual(mockRepo.callsToVerifyKey, 1);
    
    // Give async updates of lastUsed a brief moment to run
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(mockRepo.callsToUpdateLastUsed, 1, 'Should call updateLastUsed asynchronously');
  });

  test('should load from RAM Cache for subsequent requests within TTL', async () => {
    const mockRepo = new MockAuthRepository();
    mockRepo.keysMap.set('cached_api_key', { uid: 'tenant_cached', keyId: 'key_cached' });

    const useCase = new AuthenticateUserUseCase(mockRepo);
    
    // First call: hits the repository
    const auth1 = await useCase.execute('cached_api_key', 'admin_key');
    assert.strictEqual(mockRepo.callsToVerifyKey, 1);

    // Second call: should hit local RAM Cache
    const auth2 = await useCase.execute('cached_api_key', 'admin_key');
    assert.strictEqual(auth2.uid, 'tenant_cached');
    assert.strictEqual(mockRepo.callsToVerifyKey, 1, 'Should reuse cached auth info without hitting repo again');
  });

  test('should fail authentication for invalid API key', async () => {
    const mockRepo = new MockAuthRepository();
    const useCase = new AuthenticateUserUseCase(mockRepo);

    await assert.rejects(
      async () => {
        await useCase.execute('invalid_key', 'admin_key');
      },
      (err: any) => {
        assert.ok(err.message.includes('Unauthorized: Invalid API Key'));
        return true;
      }
    );
  });

  test('should throw error if API key is missing', async () => {
    const mockRepo = new MockAuthRepository();
    const useCase = new AuthenticateUserUseCase(mockRepo);

    await assert.rejects(
      async () => {
        await useCase.execute('', 'admin_key');
      },
      (err: any) => {
        assert.ok(err.message.includes('API Key is required'));
        return true;
      }
    );
  });

  test('should successfully record user telemetry and requests', async () => {
    const mockLogger = new MockActivityLogger();
    const useCase = new LogTelemetryUseCase(mockLogger);

    await useCase.execute('tenant_user', 'key_123', 'get_insights', { project: 'test_project' }, true);

    assert.strictEqual(mockLogger.logs.length, 1);
    const entry = mockLogger.logs[0];
    assert.strictEqual(entry.uid, 'tenant_user');
    assert.strictEqual(entry.keyId, 'key_123');
    assert.strictEqual(entry.tool, 'get_insights');
    assert.deepStrictEqual(entry.params, { project: 'test_project' });
    assert.strictEqual(entry.success, true);
  });

  test('FirestoreAuthRepository.verifyKey should handle and rethrow database errors', async () => {
    const repo = new FirestoreAuthRepository();
    // Override the private getDb method to simulate a Firestore connection failure
    (repo as any).getDb = () => {
      return {
        collectionGroup: () => {
          throw new Error("Simulated Firestore Error");
        }
      };
    };

    await assert.rejects(
      async () => {
        await repo.verifyKey('test_key_123');
      },
      (err: any) => {
        assert.strictEqual(err.message, "Authentication store connection failed: Simulated Firestore Error");
        return true;
      }
    );
  });

  test('FirestoreAuthRepository.verifyKey should handle errors thrown during get() call', async () => {
    const repo = new FirestoreAuthRepository();
    // Override the private getDb method to simulate a Firestore get() failure
    (repo as any).getDb = () => {
      return {
        collectionGroup: () => ({
          where: () => ({
            limit: () => ({
              get: async () => {
                throw new Error("Simulated Firestore get() Error");
              }
            })
          })
        })
      };
    };

    await assert.rejects(
      async () => {
        await repo.verifyKey('test_key_123');
      },
      (err: any) => {
        assert.strictEqual(err.message, "Authentication store connection failed: Simulated Firestore get() Error");
        return true;
      }
    );
  });
});
