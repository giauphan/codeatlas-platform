import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS not set.");
  process.exit(1);
}

const absolutePath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
if (!fs.existsSync(absolutePath)) {
  console.error(`Credentials file not found at: ${absolutePath}`);
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({
    credential: cert(absolutePath),
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
  });
}

const db = getFirestore();

async function run() {
  console.log("=== Fetching all users from Firestore ===");
  const usersSnapshot = await db.collection("users").get();
  if (usersSnapshot.empty) {
    console.log("No users found in users collection.");
  } else {
    for (const userDoc of usersSnapshot.docs) {
      console.log(`User ID: ${userDoc.id}`);
      console.log(`User Data:`, userDoc.data());
      
      const keysSnapshot = await userDoc.ref.collection("keys").get();
      if (keysSnapshot.empty) {
        console.log(`  -> No API keys found for this user.`);
      } else {
        for (const keyDoc of keysSnapshot.docs) {
          const data = keyDoc.data();
          console.log(`  -> Key ID: ${keyDoc.id}`);
          console.log(`     Key Value (stored): ${data.key}`);
          console.log(`     Key Hash: ${data.keyHash}`);
          console.log(`     Key Name/Label: ${data.name || data.label || 'N/A'}`);
          console.log(`     Tier: ${data.tier || 'N/A'}`);
        }
      }
    }
  }
}

run().catch(console.error);
