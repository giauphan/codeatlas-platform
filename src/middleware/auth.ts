import express from "express";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { checkAuth } from "../services/authService.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

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
      let role = (decodedToken.role as string) || "user";
      if (role !== "admin") {
        try {
          const userDoc = await getFirestore().collection("users").doc(decodedToken.uid).get();
          if (userDoc.exists) {
            role = userDoc.data()?.role || userDoc.data()?.tier || "user";
          }
        } catch (e) {
          logger.error("Failed to fetch user role from Firestore:", e);
        }
      }

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

  // 2. Support API key via header (primary) and query param (deprecated — warn)
  let clientKey = (req.headers["x-api-key"] as string);
  if (!clientKey) {
    clientKey = (req.query.apiKey as string) || "";
    if (clientKey) {
      logger.warn("[Auth] API key passed via query parameter is deprecated and will be removed. Use x-api-key header instead.");
    }
  }
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
