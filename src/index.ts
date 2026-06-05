#!/usr/bin/env node

import * as dotenv from "dotenv";
dotenv.config();

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { initializeApp, getApps, cert } from "firebase-admin/app";

// Import Presentation Adapters
import { server } from "./presentation/mcpServer.js";
import { app, startHttpServer } from "./presentation/httpServer.js";

// Import Domain / Application Services
import { checkAuth } from "./services/authService.js";
import { logger } from "./utils/logger.js";
import { 
  getStats, 
  discoverProjects, 
  loadAnalysis, 
  discoverProjectsAsync, 
  loadAnalysisAsync, 
  fileExists 
} from "./services/projectService.js";

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
        logger.error(`Firebase Service Account not found at: ${absolutePath}`);
        logger.warn("Skipping Firebase Admin initialization with explicit cert since file was not found.");
      }
    } else {
      logger.warn("GOOGLE_APPLICATION_CREDENTIALS environment variable not set. Firebase Admin initialization skipped.");
    }
  } catch (e) {
    logger.error("Firebase Admin initialization failed. Ensure GOOGLE_APPLICATION_CREDENTIALS is set.");
  }
}

// Start server
async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : null;

  if (port) {
    // SSE Mode - for remote server deployment
    await startHttpServer(port);
  } else {
    // Stdio Mode - for local use (e.g. Claude Desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("CodeAtlas MCP server running on stdio");
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
  main().catch((err: unknown) => logger.error(err));
}

// Re-export core modules/helpers to maintain compatibility with test suite
export { server, app, checkAuth, getStats, discoverProjects, loadAnalysis, discoverProjectsAsync, loadAnalysisAsync };
