import "dotenv/config";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { initPool, setSessionContext } from "../dist/src/database/connection.js";
import { logger } from "../dist/src/utils/logger.js";

/**
 * Migrate existing dreams: change tenant_id from 'admin' to the user's actual uid.
 * Resolves uid from CODEATLAS_API_KEY, then updates Oracle.
 */
async function migrateTenant() {
  const apiKey = process.env.CODEATLAS_API_KEY;
  if (!apiKey) {
    console.error("CODEATLAS_API_KEY env var required");
    process.exit(1);
  }

  // Initialize Firebase if not already
  if (getApps().length === 0) {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./serviceAccountKey.json";
    const absPath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
    if (fs.existsSync(absPath)) {
      initializeApp({ credential: cert(absPath) });
    } else {
      initializeApp({ projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node" });
    }
  }

  // 1. Resolve uid from API key
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const db = getFirestore();

  let keysSnapshot = await db.collectionGroup("keys")
    .where("keyHash", "==", keyHash)
    .limit(1)
    .get();

  if (keysSnapshot.empty) {
    keysSnapshot = await db.collectionGroup("keys")
      .where("key", "==", apiKey)
      .limit(1)
      .get();
  }

  if (keysSnapshot.empty) {
    console.error("No matching API key found in Firestore");
    process.exit(1);
  }

  const keyDoc = keysSnapshot.docs[0];
  const userRef = keyDoc.ref.parent.parent;
  if (!userRef) {
    console.error("Could not resolve user from key");
    process.exit(1);
  }

  const uid = userRef.id;
  console.log(`Resolved user uid: ${uid}`);

  // 2. Update Oracle tables
  const pool = await initPool();
  const conn = await pool.getConnection();
  await setSessionContext(conn, uid);

  try {
    // ai_dreaming_memory (primary target)
    const dreamResult = await conn.execute(
      `UPDATE ai_dreaming_memory SET tenant_id = :p_uid WHERE tenant_id = 'admin'`,
      { p_uid: uid },
      { autoCommit: true }
    );
    console.log(`ai_dreaming_memory: ${dreamResult.rowsAffected ?? 0} rows updated`);

    // Other tables (best-effort)
    const tables = [
      "codeatlas_concepts",
      "ai_episodic_memory",
      "ai_semantic_memory",
      "ai_relational_memory",
    ];
    for (const table of tables) {
      try {
        const result = await conn.execute(
          `UPDATE ${table} SET tenant_id = :p_uid WHERE tenant_id = 'admin'`,
          { p_uid: uid },
          { autoCommit: true }
        );
        console.log(`${table}: ${result.rowsAffected ?? 0} rows updated`);
      } catch (e: any) {
        console.log(`${table}: skipped (${e.message})`);
      }
    }

    console.log("Migration complete");
  } finally {
    await conn.close();
    await pool.close(10);
  }
}

migrateTenant().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
