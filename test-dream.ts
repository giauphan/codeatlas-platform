import { DreamingService } from "./src/services/dreamingService.js";
import { authStorage } from "./src/utils/context.js";
import dotenv from "dotenv";

dotenv.config();

async function test() {
  await DreamingService.initialize();
  console.log("DB initialized");

  const tenantId = "account1_admin";
  
  await authStorage.run({ uid: tenantId, role: "admin", claims: {} }, async () => {
    // 1. Save
    const id = await DreamingService.saveDreamMemory(
      "test-project",
      "test-session",
      "KNOWLEDGE",
      "Test dream memory content about authentication pattern",
      5
    );
    console.log("Saved ID:", id);

    // 2. Query
    const results = await DreamingService.queryDreamMemories("test-project", "authentication", 10, 0);
    console.log("Query Results:", results);
  });
}

test().catch(console.error);
