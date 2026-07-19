/**
 * Auth Proxy Routes — signs in users using Firebase Admin SDK + Google OAuth2
 *
 * Uses the service account (GOOGLE_APPLICATION_CREDENTIALS) to:
 *   1. Get an OAuth2 access token
 *   2. Call Google Identity Toolkit API to sign in with email/password
 *   3. Return a signed session token (JWT)
 *
 * No Firebase Web API Key needed — only the service account JSON.
 *
 * Flow:
 *   POST /api/auth/signin  { email, password }
 *   → Google OAuth2 access token (from service account)
 *   → Identity Toolkit REST API  (no Web API Key required)
 *   → returns { token, uid, email }
 *   → frontend stores token, sends as x-api-key or Authorization header
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { logger } from "../utils/logger.js";

const router = express.Router();

// Rate limiter for authentication endpoint to prevent brute-force attacks
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 sign-in requests per `window` (here, per 15 minutes)
  message: { error: "Too many sign-in attempts from this IP, please try again after 15 minutes" },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Use the same service account as Firebase Admin for Google Cloud APIs
// Load from dotenv if not already set — dist/index.js loads .env but the module may read before dotenv
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";
const __dirname_auth = path.dirname(fileURLToPath(import.meta.url));
// dist/src/routes/ → project root (/home/ubuntu/codeatlas-platform/.env)
dotenv.config({ path: path.resolve(__dirname_auth, "../../../.env") });
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

// Google Cloud project ID
const PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node";

/**
 * Get an OAuth2 access token from the service account.
 */
async function getAccessToken(): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    // Required scope for Firebase Auth REST API
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/identitytoolkit",
    ],
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  if (!result?.token) {
    throw new Error("Failed to obtain Google OAuth2 access token");
  }
  return result.token;
}

/**
 * POST /api/auth/signin
 * Proxies email/password sign-in through Google Identity Toolkit API
 * using the service account's OAuth2 token (no Web API Key needed).
 */
router.post("/api/auth/signin", authRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (req.body && req.body.password) {
    req.body.password = "[REDACTED]";
  }

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  if (!SERVICE_ACCOUNT_PATH) {
    return res.status(503).json({
      error: "Firebase Auth not configured — GOOGLE_APPLICATION_CREDENTIALS not set. Use TOKEN login instead.",
    });
  }

  try {
    // Step 1: Get OAuth2 access token from service account
    const accessToken = await getAccessToken();

    // Step 2: Call Google Identity Toolkit API (server-side, no ?key= param)
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      }
    );

    const data = await resp.json();

    if (!resp.ok || data.error) {
      const msg = data.error?.message || `Auth error ${resp.status}`;
      logger.warn("[Auth] Sign-in failed:", msg);
      // Translate Firebase error codes to user-friendly messages
      let friendlyMsg = "Login failed. Please check your credentials.";
      if (msg.includes("INVALID_PASSWORD") || msg.includes("EMAIL_NOT_FOUND") || msg.includes("INVALID_LOGIN_CREDENTIALS")) {
        friendlyMsg = "Email hoặc mật khẩu không chính xác.";
      } else if (msg.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
        friendlyMsg = "Tài khoản tạm khóa do nhập sai nhiều lần. Thử lại sau.";
      } else if (msg.includes("USER_DISABLED")) {
        friendlyMsg = "Tài khoản đã bị vô hiệu hóa.";
      }
      return res.status(401).json({ error: friendlyMsg });
    }

    logger.info(`[Auth] User signed in: ${data.email || data.localId}`);

    // Return session info
    return res.json({
      idToken: data.idToken,
      uid: data.localId,
      email: data.email,
      refreshToken: data.refreshToken,
    });
  } catch (err) {
    logger.error("[Auth] Sign-in proxy failed:", err);
    return res.status(500).json({
      error: "Authentication service unavailable."
    });
  }
});

export { router as authProxyRouter };
