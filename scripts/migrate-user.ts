import "dotenv/config";
import { runFirestoreScript } from "../src/utils/firestoreScript.js";

await runFirestoreScript(async (db) => {
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
    await db.collection("projects").doc(newDocId).set({ // NOSONAR
      ...data,
      tenantId: targetUid,
      updatedAt: new Date().toISOString(),
    });

    // Optional: Delete legacy document to prevent pollution
    await db.collection("projects").doc(docId).delete(); // NOSONAR
    console.log(`Successfully migrated and cleaned up ${docId}`);
  }

  console.log("Migration complete!");
});
