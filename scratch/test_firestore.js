
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

dotenv.config();

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

async function testFirestore() {
  try {
    console.log("Attempting to list collections...");
    const collections = await db.listCollections();
    console.log("Successfully connected! Collections found:", collections.length);
    collections.forEach(c => console.log(" -", c.id));
  } catch (err) {
    console.error("Firestore Test Failed:");
    console.error("Code:", err.code);
    console.error("Message:", err.message);
    if (err.details) console.error("Details:", err.details);
  }
}

testFirestore();
