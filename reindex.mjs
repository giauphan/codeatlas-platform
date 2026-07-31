import { indexingService } from "./dist/src/services/indexingService.js";

const dirs = (process.env.CODEATLAS_PROJECT_DIRS || "").split(",").map(s => s.trim()).filter(Boolean);
console.log(`Re-indexing ${dirs.length} projects: ${dirs.join(", ")}`);

for (const dir of dirs) {
  console.log(`\n=== Indexing: ${dir} ===`);
  try {
    const start = Date.now();
    const success = await indexingService.indexProject(dir);
    const secs = ((Date.now()-start)/1000).toFixed(1);
    console.log(`[${secs}s] Result: ${success ? "OK" : "FAIL"}`);
  } catch(e) {
    console.log(`Error: ${e.message}`);
  }
}
console.log("\nDone!");
