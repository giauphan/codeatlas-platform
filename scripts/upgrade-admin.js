
import admin from 'firebase-admin';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

dotenv.config();

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

const email = process.argv[2];
if (!email) {
  console.error('Usage: node upgrade-admin.js <email>');
  console.error('Example: node upgrade-admin.js admin@example.com');
  process.exit(1);
}

async function upgradeUser(email) {
  try {
    const usersSnapshot = await db.collection('users').where('email', '==', email).get();
    
    if (usersSnapshot.empty) {
      console.log(`User with email ${email} not found.`);
      return;
    }

    const userDoc = usersSnapshot.docs[0];
    await userDoc.ref.update({
      tier: 'enterprise',
      role: 'admin',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Successfully upgraded ${email} to enterprise tier!`);
  } catch (err) {
    console.error('Upgrade failed:', err);
  }
}

upgradeUser(email);
