import * as fs from "node:fs";
import * as path from "node:path";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export function initScriptFirestore(): Firestore {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./serviceAccountKey.json";
  if (getApps().length === 0) {
    const absolutePath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : path.join(process.cwd(), serviceAccountPath);
    if (fs.existsSync(absolutePath)) {
      try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = absolutePath;
        initializeApp({
          credential: applicationDefault(),
          projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node",
        });
      } catch (e) {
        console.error(e);
      }
    }
  }
  return getFirestore();
}

export async function runFirestoreScript(task: (db: Firestore) => Promise<void>): Promise<void> {
  try {
    await task(initScriptFirestore());
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
