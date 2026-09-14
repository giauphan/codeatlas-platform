import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { logger } from "./utils/logger.js";
import { createDatabaseAdapter } from "./database/factory.js";
import { authStorage } from "./utils/context.js";
import { hashApiKey } from "./utils/apiKey.js";

export { DEFAULT_API_KEY_PEPPER, getApiKeyPepper, hashApiKey } from "./utils/apiKey.js";

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

function sanitizeActivityParams(params: ActivityParams): string {
  try {
    const serialized = JSON.stringify(params);
    if (serialized.length > 2000) {
      return serialized.slice(0, 2000) + '... [truncated]';
    }
    return serialized;
  } catch (e) {
    return '{"error": "Failed to serialize params"}';
  }
}

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

      // Hash the API key using PBKDF2-SHA256 with a pepper to query Firestore safely
      const keyHash = await hashApiKey(apiKey);

      // Look up by PBKDF2 keyHash
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
        params: sanitizeActivityParams(params),
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

export class SqliteAuthRepository implements IAuthRepository {
  async verifyKey(apiKey: string): Promise<AuthData | null> {
    try {
      const db = createDatabaseAdapter();
      const keyHash = await hashApiKey(apiKey);
      const rows = await db.query<{ tier: string; uid: string | null; keyId: string; expiresAt: string | null }>(
        `SELECT id AS "keyId", user_id AS "uid", tier, expires_at AS "expiresAt"
         FROM keys
         WHERE key_hash = :keyHash
         LIMIT 1`,
        { keyHash }
      );
      if (rows.length === 0) return null;

      const row = rows[0];
      const expires = row.expiresAt ? new Date(row.expiresAt).getTime() : Infinity;
      if (Number.isNaN(expires) || expires < Date.now()) return null;

      return {
        tier: row.tier || 'free',
        uid: row.uid || 'unknown',
        keyId: row.keyId,
        expires
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SqliteAuthRepository] Verification error: ${msg}`);
      throw new Error(`Authentication store connection failed: ${msg}`);
    }
  }

  async updateLastUsed(_uid: string, keyId: string): Promise<void> {
    try {
      const db = createDatabaseAdapter();
      await db.execute(
        `UPDATE keys SET updated_at = CURRENT_TIMESTAMP WHERE id = :keyId`,
        { keyId }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SqliteAuthRepository] Update last used error: ${msg}`);
    }
  }
}

export class SqliteActivityLogger implements IActivityLogger {
  async logActivity(uid: string, keyId: string, tool: string, params: ActivityParams, success: boolean): Promise<void> {
    if (uid === 'admin') return;

    try {
      const db = createDatabaseAdapter();
      const users = await db.query<{ tenantId: string }>(
        `SELECT tenant_id AS "tenantId" FROM users WHERE id = :uid LIMIT 1`,
        { uid }
      );
      const tenantId = users[0]?.tenantId || authStorage.getStore()?.uid || uid;
      await db.execute(
        `INSERT INTO activity_log (id, tenant_id, key_id, tool, params, success)
         VALUES (:id, :tenantId, :keyId, :tool, :params, :success)`,
        {
          id: crypto.randomUUID(),
          tenantId,
          keyId,
          tool,
          params: sanitizeActivityParams(params),
          success
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SqliteActivityLogger] Failed to log activity: ${msg}`);
    }
  }
}

interface CachedAuthEntry {
  data: AuthData;
  cachedUntil: number;
}

/**
 * Use case: Validating client API keys
 */
export class AuthenticateUserUseCase {
  private authCache = new Map<string, CachedAuthEntry>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private adminFallbackTtl: number;

  constructor(private authRepo: IAuthRepository, adminFallbackTtlMs: number = 5 * 60 * 1000) {
    this.adminFallbackTtl = adminFallbackTtlMs;
  }

  async execute(apiKey: string, superAdminKey?: string): Promise<AuthData> {
    if (!apiKey) {
      throw new Error("Unauthorized: API Key is required. Set CODEATLAS_API_KEY env var or provide x-api-key header.");
    }

    // 1. Super Admin — try the repository first so the key resolves to the user's real uid
    if (superAdminKey && apiKey === superAdminKey) {
      const cached = this.authCache.get(apiKey);
      if (cached && cached.cachedUntil > Date.now()) {
        return cached.data;
      }
      try {
        const firestoreData = await this.authRepo.verifyKey(apiKey);
        if (firestoreData) {
          firestoreData.expires = Infinity;
          this.authCache.set(apiKey, { data: firestoreData, cachedUntil: Infinity });
          return firestoreData;
        }
      } catch (err: unknown) {
        // Fallback gracefully if Firestore is unconfigured or unavailable
        logger.debug(`[AuthenticateUserUseCase] Super admin lookup failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Cache the fallback briefly so a degraded store is not hit on every request
      // We don't overwrite `expires` semantics of the original payload so downstream systems don't treat it differently.
      const fallback: AuthData = {
        tier: 'enterprise',
        uid: 'admin',
        keyId: 'admin',
        expires: Infinity,
      };
      this.authCache.set(apiKey, { data: fallback, cachedUntil: Date.now() + this.adminFallbackTtl });
      return fallback;
    }

    // 2. Check Local RAM Cache
    const cached = this.authCache.get(apiKey);
    if (cached && cached.cachedUntil > Date.now()) {
      return cached.data;
    }

    // 3. Query Repository
    const authData = await this.authRepo.verifyKey(apiKey);
    if (!authData) {
      throw new Error("Unauthorized: Invalid API Key.");
    }

    this.authCache.set(apiKey, { data: authData, cachedUntil: Date.now() + this.CACHE_TTL });

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
