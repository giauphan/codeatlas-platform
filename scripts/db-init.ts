import "dotenv/config";
import { createDatabaseAdapter } from "../src/database/factory.js";

/**
 * Initializes the CodeAtlas database schema.
 * SQLite + sqlite-vec is the default backend and requires no external server.
 */
async function run(): Promise<void> {
  console.log("⚙️ Initializing CodeAtlas database schema...");
  const db = createDatabaseAdapter();
  await db.connect();
  try {
    await db.initializeSchema();
    console.log("🎉 Database schema initialized successfully.");
  } finally {
    await db.disconnect();
  }
}

run().catch((err: unknown) => {
  console.error("❌ Database initialization failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
