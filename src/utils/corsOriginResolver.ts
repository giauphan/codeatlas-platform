import { logger } from "./logger.js";

/**
 * Resolves CORS origins securely, rejecting wildcards when credentials are true.
 */
export function createCorsOriginCallback(allowedList: string[]) {
  return function (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) {
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

      // Normalize origin securely using parsedOrigin.origin which automatically
      // handles trailing slashes and edge cases natively, rather than manual string slicing.
      const normalizedOrigin = parsedOrigin.origin;

      // Note: Because httpServer.ts enforces a fail-fast startup crash if '*' is present,
      // this check acts as an additional defense-in-depth layer against dynamic config injections.
      if (allowedList.includes('*')) {
        logger.warn(`[CORS] Security Warning: Wildcard origin (*) is not permitted with credentials enabled. Request from ${origin} rejected.`);
        return callback(null, false);
      }

      if (allowedList.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      // Default reject if no match
      return callback(null, false);
    } catch (err) {
      // Catch URL parsing errors (e.g. malformed URIs) and reject the request cleanly.
      // We log at debug level to allow operators to see dropped traffic without overwhelming prod logs.
      logger.debug(`[CORS] Rejected malformed origin URI: ${origin}`);
      return callback(null, false);
    }
  };
}
