#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import * as dotenv from "dotenv";

// Import Presentation Adapters
import { server } from "./src/presentation/mcpServer.js";
import { app, startHttpServer } from "./src/presentation/httpServer.js";

// Import Domain / Application Services
import { checkAuth } from "./src/services/authService.js";
import { 
  getStats, 
  discoverProjects, 
  loadAnalysis, 
  discoverProjectsAsync, 
  loadAnalysisAsync, 
  fileExists 
} from "./src/services/projectService.js";
import { startWatcher } from "./src/services/watcherService.js";

// Load environment variables
dotenv.config();

// Initialize Firebase Admin (Infrastructure Configuration at Composition Root)
const apps = getApps();
if (!apps || apps.length === 0) {
  try {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath) {
      const absolutePath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
      
      if (fs.existsSync(absolutePath)) {
        initializeApp({
          credential: cert(absolutePath),
          projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
        });
      } else {
        console.error(`Firebase Service Account not found at: ${absolutePath}`);
        console.warn("Skipping Firebase Admin initialization with explicit cert since file was not found.");
      }
    } else {
      console.warn("GOOGLE_APPLICATION_CREDENTIALS environment variable not set. Firebase Admin initialization skipped.");
    }
  } catch (e) {
    console.error("Firebase Admin initialization failed. Ensure GOOGLE_APPLICATION_CREDENTIALS is set.");
  }
}

// Start server
async function main() {
  startWatcher();

  // Trigger background scan of all discovered projects on startup
  discoverProjectsAsync().then(async (projectsList) => {
    console.error(`[Auto-Scan] 🔍 Discovered ${projectsList.length} potential projects on startup.`);
    for (const p of projectsList) {
      const hasAnalysis = await fileExists(p.analysisPath);
      if (!hasAnalysis) {
        console.error(`[Auto-Scan] 🔄 Triggering initial background scan for: ${p.name}`);
        // Run in background without awaiting, so server startup is instantaneous!
        loadAnalysisAsync(p.dir).then((loaded) => {
          if (loaded) {
            console.error(`[Auto-Scan] ✅ Initial background scan complete for: ${p.name}`);
          }
        }).catch((err) => {
          console.error(`[Auto-Scan] ❌ Initial background scan failed for ${p.name}: ${err}`);
        });
      }
    }
  }).catch((err) => {
    console.error(`[Auto-Scan] ❌ Failed to discover projects for initial scan: ${err}`);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT) : null;

  if (port) {
    // SSE Mode - for remote server deployment
    await startHttpServer(port);
  } else {
    // Stdio Mode - for local use (e.g. Claude Desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CodeAtlas MCP server running on stdio");
  }
}

// Only run the server if executed directly
const isMain = (process.argv[1] && (
  process.argv[1] === url.fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('bin/codeatlas') ||
  process.argv[1].endsWith('index.ts') ||
  process.argv[1].endsWith('index.js')
)) || (
  process.env.pm_exec_path && (
    process.env.pm_exec_path.endsWith('index.js') ||
    process.env.pm_exec_path.endsWith('index.ts')
  )
);

if (isMain) {
  main().catch(console.error);
}

// Re-export core modules/helpers to maintain compatibility with test suite
export { server, app, checkAuth, getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync };
