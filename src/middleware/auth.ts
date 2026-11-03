import express from "express";
import { getAuth } from "firebase-admin/auth";
import { checkAuth } from "../services/authService.js";
import { createDatabaseAdapter } from "../database/factory.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

async function resolveFirebaseRole(uid: string, role: string): Promise<string> {
  if (role === "admin") return role;

  try {
    const db = createDatabaseAdapter();
    const rows = await db.query<{ role: string | null; tier: string | null }>(
      `SELECT role, tier FROM users WHERE id = :uid LIMIT 1`,
      { uid }
    );
    return rows.length > 0 ? rows[0].role || rows[0].tier || "user" : role;
  } catch (e) {
    logger.error("Failed to fetch user role from local database:", e);
    return role;
  }
}

/**
 * Authentication middleware for ALL API routes.
 * Supports Firebase ID Token (Bearer Token) and API key (x-api-key header).
 */
export const authMiddleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // 1. Support Firebase ID Token (Bearer Token) for Dashboard
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const role = await resolveFirebaseRole(decodedToken.uid, (decodedToken.role as string) || "user");

      const auth = {
        tier: "enterprise",
        uid: decodedToken.uid,
        email: decodedToken.email,
        role: role,
        keyId: "firebase-session"
      };
      req.auth = auth;

      // Assign auth context for the entire asynchronous flow below
      authStorage.run(auth, () => {
        next();
      });
      return;
    } catch (err: unknown) {
      res.status(401).json({ error: `Invalid Firebase ID Token: ${(err instanceof Error ? err.message : String(err))}` });
      return;
    }
  }

  // 2. Support API key via header only
  const clientKey = (req.headers["x-api-key"] as string) || "";
  try {
    const auth = await checkAuth(clientKey);
    req.auth = auth; // Attach auth result to request
    // Assign auth context for the entire asynchronous flow below
    authStorage.run(auth, () => {
      next();
    });
  } catch (err: unknown) {
    res.status(401).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
};
