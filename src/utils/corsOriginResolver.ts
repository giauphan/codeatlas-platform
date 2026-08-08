import { logger } from "./logger.js";

/**
 * Creates a CORS origin resolution callback for Express that securely validates
 * incoming requests against an allowed list, explicitly rejecting wildcards.
 *
 * @param allowedList An array of explicitly permitted origins (e.g. ['https://example.com'])
 * @returns A callback function matching the Express `cors` middleware signature
 */
export function createCorsOriginCallback(allowedList: string[]) {
  /**
   * Evaluates the incoming Origin header.
   * @param origin The Origin header from the HTTP request (undefined if not provided)
   * @param callback The callback invoked to instruct the middleware to allow/deny
   */
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
