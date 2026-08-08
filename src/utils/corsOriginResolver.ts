import { logger } from "./logger.js";

/**
 * Resolves CORS origins securely, rejecting wildcards when credentials are true.
 */
export function createCorsOriginCallback(allowedList: string[]) {
  return function (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) {
    if (!origin) return callback(null, true);

    if (origin === 'null') {
      return callback(null, false);
    }

    try {
      const parsedOrigin = new URL(origin);

      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        return callback(null, false);
      }

      const normalizedOrigin = parsedOrigin.origin;

      if (allowedList.includes('*')) {
        logger.warn(`[CORS] Security Warning: Wildcard origin (*) is not permitted with credentials enabled. Request from ${origin} rejected.`);
        return callback(null, false);
      }

      if (allowedList.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      return callback(null, false);
    } catch (err) {
      logger.warn(`[CORS] Rejected malformed origin URI: ${origin}`);
      return callback(null, false);
    }
  };
}
