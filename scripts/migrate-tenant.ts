import "dotenv/config";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createDatabaseAdapter } from "../src/database/factory.js";

/**
 * Migrate existing dreams: change tenant_id from 'admin' to the user's actual uid.
 * Resolves uid from CODEATLAS_API_KEY, then updates the CodeAtlas database.
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
  const API_KEY_PEPPER = process.env.API_KEY_PEPPER || 'codeatlas-api-key-pepper-v1';
  const salt = Buffer.from(API_KEY_PEPPER, 'utf8');
  const keyHash = crypto.pbkdf2Sync(apiKey, salt, 100000, 64, 'sha256').toString('hex');
  const firestore = getFirestore();

  let keysSnapshot = await firestore.collectionGroup("keys")
    .where("keyHash", "==", keyHash)
    .limit(1)
    .get();

  if (keysSnapshot.empty) {
    keysSnapshot = await firestore.collectionGroup("keys")
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

  // 2. Update database tables
  const db = createDatabaseAdapter();
  await db.connect();

  try {
    const tables = [
      "ai_dreaming_memory",
      "codeatlas_concepts",
      "ai_episodic_memory",
      "ai_semantic_memory",
      "ai_relational_memory",
    ];
    for (const table of tables) {
      try {
        const result = await db.execute(
          `UPDATE ${table} SET tenant_id = :uid WHERE tenant_id = 'admin'`,
          { uid }
        );
        console.log(`${table}: ${result.rowsAffected ?? 0} rows updated`);
      } catch (e: unknown) {
        console.log(`${table}: skipped (${e instanceof Error ? e.message : String(e)})`);
      }
    }

    console.log("Migration complete");
  } finally {
    await db.disconnect();
  }
}

migrateTenant().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
