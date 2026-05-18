import { discoverProjectsAsync } from "../src/services/projectService.js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

async function run() {
  console.log("=== Listing Discovered Projects (Multi-tenant = false) ===");
  const originalMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
  
  process.env.CODEATLAS_MULTI_TENANT = "false";
  const allProjects = await discoverProjectsAsync();
  console.log(`Discovered ${allProjects.length} projects:`);
  for (const p of allProjects) {
    console.log(`- Name: ${p.name}`);
    console.log(`  Dir: ${p.dir}`);
    console.log(`  AnalysisPath: ${p.analysisPath}`);
  }

  console.log("\n=== Listing Discovered Projects (Multi-tenant = true) ===");
  process.env.CODEATLAS_MULTI_TENANT = "true";
  
  // Let's check if there are tenant folders
  const tenantsRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
  console.log(`CODEATLAS_PROJECTS_ROOT: ${tenantsRoot}`);
  
  // Try discovery for a few simulated/hypothetical UIDs
  const testUids = ["admin", "tenant_user_1", "tenant_user_2", "user1", "user2"];
  for (const uid of testUids) {
    const projects = await discoverProjectsAsync(uid);
    console.log(`Tenant '${uid}' has ${projects.length} projects:`);
    for (const p of projects) {
      console.log(`  - Name: ${p.name} (Dir: ${p.dir})`);
    }
  }
}

run().catch(console.error);
