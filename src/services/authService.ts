import { 
  FirestoreAuthRepository, 
  FirestoreActivityLogger, 
  AuthenticateUserUseCase, 
  LogTelemetryUseCase 
} from "../repositories.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { getAuth } from "firebase-admin/auth";

const authRepo = new FirestoreAuthRepository();
const activityLogger = new FirestoreActivityLogger();
export const authenticateUseCase = new AuthenticateUserUseCase(authRepo);
export const logTelemetryUseCase = new LogTelemetryUseCase(activityLogger);

/**
 * Security: Verify API Key or Firebase Bearer token
 */
export async function checkAuth(apiKey?: string, bearerToken?: string): Promise<{ tier: string; uid: string; keyId: string }> {
  const contextAuth = authStorage.getStore();
  if (contextAuth) {
    return contextAuth;
  }

  // Try Bearer token first (Firebase)
  if (bearerToken) {
    try {
      const decoded = await getAuth().verifyIdToken(bearerToken);
      return {
        tier: "premium",
        uid: decoded.uid,
        keyId: `firebase:${decoded.uid}`,
      };
    } catch (err) {
      logger.warn("[Auth] Firebase token verification failed:", err instanceof Error ? err.message : String(err));
      // Bearer token was provided but invalid — don't fall through to API key
      throw new Error("Invalid or expired authentication token. Please log in again.");
    }
  }

  if (process.env.CODEATLAS_MULTI_TENANT === "true" && !apiKey && !bearerToken) {
    throw new Error("Authentication required");
  }

  // Pass API key explicitly to authentication use case. If it's a super-admin key,
  // the use case will handle it.
  const result = await authenticateUseCase.execute(apiKey || "", process.env.CODEATLAS_API_KEY);
  return {
    tier: result.tier,
    uid: result.uid,
    keyId: result.keyId
  };
}

/**
 * Express middleware for auth that reads x-api-key and Authorization headers.
 */
export async function authMiddleware(req: any, res: any, next: any) {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const bearerMatch = (req.headers['authorization'] as string || '').match(/^Bearer (.+)$/);
    const auth = await checkAuth(apiKey, bearerMatch?.[1]);
    authStorage.run(auth, () => next());
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : "Authentication failed" });
  }
}

/**
 * Log activity using Clean Architecture Use Case
 */
export async function logActivity(auth: { uid: string; keyId: string }, tool: string, params: Record<string, unknown>, success: boolean = true) {
  try {
    await logTelemetryUseCase.execute(auth.uid, auth.keyId, tool, params, success);
  } catch (err: unknown) {
    logger.error("Failed to log activity:", err instanceof Error ? err.message : String(err));
  }
}
