
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

dotenv.config();

if (!getApps().length) {
  initializeApp({
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
  });
}

const db = getFirestore();

async function testQuery() {
  try {
    console.log("Searching for key in collection group 'keys'...");
    // The dashboard saves keys in a structure, probably users/{uid}/keys/{keyId}
    // We use collectionGroup to find them all
    const snapshot = await db.collectionGroup('keys').limit(1).get();
    if (snapshot.empty) {
      console.log("No keys found, but connection might be OK.");
    } else {
      console.log("Found a key! Connection is definitely OK.");
      console.log("Data:", snapshot.docs[0].data());
    }
  } catch (err) {
    console.error("Firestore Query Failed:");
    console.error("Code:", err.code);
    console.error("Message:", err.message);
  }
}

testQuery();
