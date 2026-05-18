import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const apps = getApps();
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (serviceAccountPath) {
  const absolutePath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
  if (fs.existsSync(absolutePath)) {
    try {
      initializeApp({
        credential: cert(absolutePath),
        projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
      });
    } catch (e) {
      console.error(e);
    }
  }
}

async function main() {
  const db = getFirestore();
  
  console.log("=== PROJECTS IN FIRESTORE ===");
  const projectsSnapshot = await db.collection("projects").get();
  for (const doc of projectsSnapshot.docs) {
    console.log(`Document ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
    console.log("-----------------------------------");
  }

  console.log("=== USERS & THEIR KEYS ===");
  const usersSnapshot = await db.collection("users").get();
  for (const doc of usersSnapshot.docs) {
    console.log(`User ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
  }
}

main().catch(console.error);
