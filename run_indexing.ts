import { CodeAnalyzer } from "./src/analyzer/parser.js";
import * as fs from "fs";
import * as path from "path";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as dotenv from "dotenv";

dotenv.config();

interface AnalysisResultLocal {
  stats?: any;
  entityCounts?: any;
  graph: { nodes: any[]; links: any[] };
  totalFilesAnalyzed?: number;
  totalFilesSkipped?: number;
}

// Initialize Firebase for Sync
let db: any = null;
const apps = getApps();
if (!apps.length) {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (serviceAccountPath) {
    const absolutePath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
    if (fs.existsSync(absolutePath)) {
      try {
        initializeApp({
          credential: cert(absolutePath),
          projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
        });
      } catch (e) {
        console.error("Failed to initialize Firebase Admin:", e);
      }
    } else {
      console.warn(`Firebase Service Account not found at: ${absolutePath}`);
    }
  } else {
    console.warn("GOOGLE_APPLICATION_CREDENTIALS environment variable not set. Firebase may not be initialized properly.");
  }
}

if (getApps().length > 0) {
  db = getFirestore();
}

async function run() {
  const projectPath = process.cwd();
  const projectName = path.basename(projectPath);
  console.log(`Starting analysis for: ${projectName}`);
  
  const analyzer = new CodeAnalyzer(projectPath, 5000);
  const result = await analyzer.analyzeProject() as any as AnalysisResultLocal;

  const codeatlasDir = path.join(projectPath, ".codeatlas");
  if (!fs.existsSync(codeatlasDir)) {
    fs.mkdirSync(codeatlasDir, { recursive: true });
  }

  // 1. Save locally
  fs.writeFileSync(
    path.join(codeatlasDir, "analysis.json"),
    JSON.stringify(result, null, 2)
  );

  // 2. Sync to Firestore (Enterprise Database)
  if (db) {
    try {
      await db.collection('projects').doc(projectName).set({
        name: projectName,
        path: projectPath,
        stats: result.stats || result.entityCounts || {},
        lastIndexed: new Date().toISOString(),
        nodesCount: result.graph.nodes.length,
        linksCount: result.graph.links.length,
        status: 'synced'
      }, { merge: true });
      console.log(`✅ Synced ${projectName} to Firestore.`);
    } catch (e) {
      console.error(`❌ Firestore Sync Failed: ${e}`);
    }
  } else {
    console.log("⚠️ Firebase Admin not initialized. Skipping Firestore sync.");
  }

  console.log("Analysis complete! Data saved to .codeatlas/analysis.json");
}

run().catch(console.error);
