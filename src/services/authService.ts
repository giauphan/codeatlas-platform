import { 
  FirestoreAuthRepository, 
  FirestoreActivityLogger, 
  AuthenticateUserUseCase, 
  LogTelemetryUseCase 
} from "../repositories.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

const authRepo = new FirestoreAuthRepository();
const activityLogger = new FirestoreActivityLogger();
export const authenticateUseCase = new AuthenticateUserUseCase(authRepo);
export const logTelemetryUseCase = new LogTelemetryUseCase(activityLogger);

/**
 * Security: Verify API Key using Clean Architecture Use Case
 */
export async function checkAuth(apiKey?: string): Promise<{ tier: string; uid: string; keyId: string }> {
  const contextAuth = authStorage.getStore();
  if (contextAuth) {
    return contextAuth;
  }
  if (process.env.CODEATLAS_MULTI_TENANT === "true" && !apiKey) {
    throw new Error("Authentication API key is required");
  }
  const keyToVerify = apiKey || process.env.CODEATLAS_API_KEY || "";
  const result = await authenticateUseCase.execute(keyToVerify, process.env.CODEATLAS_API_KEY);
  return {
    tier: result.tier,
    uid: result.uid,
    keyId: result.keyId
  };
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
