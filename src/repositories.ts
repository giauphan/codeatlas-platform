import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { logger } from "./utils/logger.js";

/**
 * Domain Interface for User Authentication details
 */
export interface AuthData {
  tier: string;
  uid: string;
  keyId: string;
  expires: number;
}

/**
 * Authentication Repository interface
 */
export interface IAuthRepository {
  verifyKey(apiKey: string): Promise<AuthData | null>;
  updateLastUsed(uid: string, keyId: string): Promise<void>;
}

/** Activity log parameters (JSON-serializable key-value pairs) */
export type ActivityParams = Record<string, unknown>;

/**
 * Activity Logging Repository interface
 */
export interface IActivityLogger {
  logActivity(uid: string, keyId: string, tool: string, params: ActivityParams, success: boolean): Promise<void>;
}

/**
 * Firestore implementation of IAuthRepository
 */
export class FirestoreAuthRepository implements IAuthRepository {
  private getDb() {
    return getFirestore();
  }

  async verifyKey(apiKey: string): Promise<AuthData | null> {
    try {
      const db = this.getDb();

      // Hash the key using SHA-256 to compare with stored keyHash
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

      // First try to find by keyHash
      let keysSnapshot = await db.collectionGroup('keys')
        .where('keyHash', '==', keyHash)
        .limit(1)
        .get();

      // Fallback for backwards compatibility with unhashed keys
      if (keysSnapshot.empty) {
        keysSnapshot = await db.collectionGroup('keys')
          .where('key', '==', apiKey)
          .limit(1)
          .get();
      }

      if (keysSnapshot.empty) {
        return null;
      }

      const keyDoc = keysSnapshot.docs[0];
      const userRef = keyDoc.ref.parent.parent;
      if (!userRef) {
        return null;
      }

      return {
        tier: 'enterprise',
        uid: userRef.id,
        keyId: keyDoc.id,
        expires: 0 // Cache expiry will be handled by the cached wrapper
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[FirestoreAuthRepository] Verification error: ${msg}`);
      throw new Error(`Authentication store connection failed: ${msg}`);
    }
  }

  async updateLastUsed(uid: string, keyId: string): Promise<void> {
    try {
      const db = this.getDb();
      const keyRef = db.collection('users').doc(uid).collection('keys').doc(keyId);
      await keyRef.update({
        lastUsed: FieldValue.serverTimestamp()
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[FirestoreAuthRepository] Update last used error: ${msg}`);
    }
  }
}

/**
 * Firestore implementation of IActivityLogger
 */
export class FirestoreActivityLogger implements IActivityLogger {
  private getDb() {
    return getFirestore();
  }

  async logActivity(uid: string, keyId: string, tool: string, params: ActivityParams, success: boolean): Promise<void> {
    if (uid === 'admin') return; // Bypass logging for superadmin requests

    try {
      const db = this.getDb();
      await db.collection('users').doc(uid).collection('activity').add({
        keyId,
        tool,
        params: JSON.stringify(params),
        success,
        timestamp: FieldValue.serverTimestamp()
      });

      // Increment global user request metrics
      const statsRef = db.collection('users').doc(uid);
      await statsRef.set({
        stats: {
          totalRequests: FieldValue.increment(1),
          lastActivity: FieldValue.serverTimestamp()
        }
      }, { merge: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[FirestoreActivityLogger] Failed to log activity: ${msg}`);
    }
  }
}

/**
 * Use case: Validating client API keys
 */
export class AuthenticateUserUseCase {
  private authCache = new Map<string, AuthData>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private authRepo: IAuthRepository) {}

  async execute(apiKey: string, superAdminKey?: string): Promise<AuthData> {
    if (!apiKey) {
      throw new Error("Unauthorized: API Key is required. Set CODEATLAS_API_KEY env var or provide x-api-key header.");
    }

    // 1. Super Admin Bypass
    if (superAdminKey && apiKey === superAdminKey) {
      return { tier: 'enterprise', uid: 'admin', keyId: 'admin', expires: Infinity };
    }

    // 2. Check Local RAM Cache
    const cached = this.authCache.get(apiKey);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }

    // 3. Query Repository
    const authData = await this.authRepo.verifyKey(apiKey);
    if (!authData) {
      throw new Error("Unauthorized: Invalid API Key.");
    }

    // Assign cache expiry timestamp
    authData.expires = Date.now() + this.CACHE_TTL;
    this.authCache.set(apiKey, authData);

    // Dynamic updates of usage statistics (non-blocking)
    this.authRepo.updateLastUsed(authData.uid, authData.keyId).catch(() => {});

    return authData;
  }
}

/**
 * Use case: Recording user telemetry and requests
 */
export class LogTelemetryUseCase {
  constructor(private activityLogger: IActivityLogger) {}

  async execute(uid: string, keyId: string, tool: string, params: ActivityParams, success: boolean): Promise<void> {
    await this.activityLogger.logActivity(uid, keyId, tool, params, success);
  }
}
