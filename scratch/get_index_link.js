import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as dotenv from "dotenv";

dotenv.config();

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!serviceAccountPath) {
  throw new Error("GOOGLE_APPLICATION_CREDENTIALS environment variable not set.");
}

initializeApp({
  credential: cert(serviceAccountPath),
  projectId: "atlas-intelligence-node"
});

const db = getFirestore();

async function trigger() {
  try {
    await db.collectionGroup('keys').where('key', '==', 'trigger-link').get();
  } catch (e) {
    console.log(JSON.stringify(e, null, 2));
    console.log("Details:", e.details);
    console.log("Metadata:", e.metadata);
  }
}

trigger();
