import 'express';

/**
 * Express Request type augmentation.
 *
 * The `auth` property is set by the authMiddleware on every authenticated request.
 * It carries the resolved identity and access tier for the duration of the request.
 *
 * Usage:
 *   const { uid, tier } = req.auth!;
 */
declare global {
  namespace Express {
    interface Request {
      auth?: {
        /** Access tier (enterprise, pro, free) */
        tier: string;
        /** Unique user/project identifier */
        uid: string;
        /** Email associated with the Firebase session (optional for API-key auth) */
        email?: string;
        /** Role such as admin, user, viewer */
        role: string;
        /** Identifier for the authentication method (firebase-session | api-key) */
        keyId: string;
      };
    }
  }
}
