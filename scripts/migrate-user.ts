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
  const targetUid = "3jWzs0gigSf6riMPcyiDKnR39OT2"; // User 1's ID
  
  console.log(`Starting Firestore migration to User ID: ${targetUid}`);
  
  const projectsSnapshot = await db.collection("projects").get();
  for (const doc of projectsSnapshot.docs) {
    const docId = doc.id;
    
    // If the doc is already prefixed with a tenant ID, skip it
    if (docId.includes("_")) {
      console.log(`Skipping already-prefixed document: ${docId}`);
      continue;
    }
    
    const newDocId = `${targetUid}_${docId}`;
    const data = doc.data();
    
    console.log(`Migrating: ${docId} -> ${newDocId}`);
    
    // Create new document with tenant prefix
    await db.collection("projects").doc(newDocId).set({
      ...data,
      tenantId: targetUid,
      updatedAt: new Date().toISOString()
    });
    
    // Optional: Delete legacy document to prevent pollution
    await db.collection("projects").doc(docId).delete();
    console.log(`Successfully migrated and cleaned up ${docId}`);
  }
  
  console.log("Migration complete!");
}

main().catch(console.error);
