import { logger } from "./logger.js";

/**
 * Resolves CORS origins securely, rejecting wildcards when credentials are true.
 */
export function createCorsOriginCallback(allowedList: string[]) {
  return function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Explicitly reject null origin to prevent sandboxed iframe bypasses
    if (origin === 'null') {
      return callback(null, false);
    }

    try {
      const parsedOrigin = new URL(origin);
      // Explicitly catch unsupported protocol scenarios (like ws://, file://) that fall through
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        return callback(null, false);
      }

      if (allowedList.includes(origin)) {
        return callback(null, true);
      } else if (allowedList.includes('*')) {
        // Security: explicitly reject wildcard origin when credentials are enabled
        // to prevent arbitrary origin reflection vulnerabilities.
        logger.warn(`[CORS] Security Warning: Wildcard origin (*) is not permitted with credentials enabled. Request from ${origin} rejected.`);
        return callback(null, false);
      } else {
        return callback(null, false);
      }
    } catch (err) {
      // Swallows URL parsing errors (e.g. malformed URIs) and rejects request cleanly
      return callback(null, false);
    }
  };
}
