import "dotenv/config";
import { runFirestoreScript } from "../src/utils/firestoreScript.js";

await runFirestoreScript(async (db) => {
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

    // Fetch keys subcollection
    const keysSnap = await db.collection("users").doc(doc.id).collection("keys").get(); // NOSONAR
    for (const keyDoc of keysSnap.docs) {
      console.log(`  Key ID: ${keyDoc.id}`);
      console.log(`  Key Data:`, JSON.stringify(keyDoc.data(), null, 2));
    }
  }
});
