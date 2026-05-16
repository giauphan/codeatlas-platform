#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as url from "url";
import chokidar from 'chokidar';
import { exec } from 'child_process';
import express from "express";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as dotenv from "dotenv";
import { CodeAnalyzer } from "./src/analyzer/parser.js";
import { AnalysisResult } from "./src/analyzer/types.js";
import { OracleMemoryService } from "./src/oracleDatabase.js";
import { SecurityScanner } from "./src/securityScanner.js";

// Load environment variables
dotenv.config();

// Initialize Firebase Admin
const apps = getApps();
if (!apps || apps.length === 0) {
  try {
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./atlas-intelligence-node-firebase-adminsdk-fbsvc-6c9d06254d.json";
    const absolutePath = path.isAbsolute(serviceAccountPath) ? serviceAccountPath : path.join(process.cwd(), serviceAccountPath);
    
    if (!fs.existsSync(absolutePath)) {
      console.error(`Firebase Service Account not found at: ${absolutePath}`);
    }

    initializeApp({
      credential: cert(absolutePath),
      projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node"
    });
  } catch (e) {
    console.error("Firebase Admin initialization failed. Ensure GOOGLE_APPLICATION_CREDENTIALS is set.");
  }
}

const db = getFirestore();

// RAM Cache for checkAuth
const authCache = new Map<string, { tier: string, expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Security: Verify API Key from Firestore
 * Instead of environment variables, we query the 'keys' collection group
 * to find if the provided key exists in any user's account.
 */
async function checkAuth(apiKey?: string): Promise<{ tier: string; uid: string; keyId: string }> {
  const keyToVerify = apiKey || process.env.CODEATLAS_API_KEY;

  if (!keyToVerify) {
    throw new Error("Unauthorized: API Key is required. Set CODEATLAS_API_KEY env var or provide x-api-key header.");
  }

  // 1. Super Admin Bypass (via .env)
  console.error(`[Auth Debug] Incoming key check...`);
  
  if (process.env.CODEATLAS_API_KEY && keyToVerify === process.env.CODEATLAS_API_KEY) {
    console.error(`[Auth Debug] Super Admin Bypass Success!`);
    return { tier: 'enterprise', uid: 'admin', keyId: 'admin' }; 
  }

  // 2. Check RAM Cache
  const cached = authCache.get(keyToVerify) as any;
  if (cached && cached.expires > Date.now()) {
    return cached;
  }

  try {
    const keysSnapshot = await db.collectionGroup('keys')
      .where('key', '==', keyToVerify)
      .limit(1)
      .get();

    if (keysSnapshot.empty) {
      console.error(`[Auth] Key not found in Firestore: ${keyToVerify.substring(0, 10)}...`);
      throw new Error("Unauthorized: Invalid API Key.");
    }

    const keyDoc = keysSnapshot.docs[0];
    const userRef = keyDoc.ref.parent.parent;
    if (!userRef) {
      throw new Error("Unauthorized: Invalid key ownership structure.");
    }

    const authData = {
      tier: 'enterprise',
      uid: userRef.id,
      keyId: keyDoc.id,
      expires: Date.now() + CACHE_TTL
    };

    authCache.set(keyToVerify, authData);

    // Update lastUsed timestamp
    await keyDoc.ref.update({
      lastUsed: FieldValue.serverTimestamp()
    });

    console.error(`[Auth] Success: User ${authData.uid} logged in via key ${authData.keyId}`);
    return authData;
  } catch (err: any) {
    if (err.message.includes("Unauthorized")) throw err;
    console.error(`[Auth Error] Project: ${process.env.VITE_FIREBASE_PROJECT_ID}, Error: ${err.message}`);
    throw new Error(`Authentication service unavailable: ${err.message}`);
  }
}

/**
 * Log activity to Firestore for the dashboard
 */
async function logActivity(auth: { uid: string; keyId: string }, tool: string, params: any, success: boolean = true) {
  if (auth.uid === 'admin') return; // Don't log super admin
  try {
    await db.collection('users').doc(auth.uid).collection('activity').add({
      keyId: auth.keyId,
      tool,
      params: JSON.stringify(params),
      success,
      timestamp: FieldValue.serverTimestamp()
    });

    // Increment global stats for user
    const statsRef = db.collection('users').doc(auth.uid);
    await statsRef.set({
      stats: {
        totalRequests: FieldValue.increment(1),
        lastActivity: FieldValue.serverTimestamp()
      }
    }, { merge: true });
  } catch (err) {
    console.error("Failed to log activity:", err);
  }
}

interface AnalysisResultLocal extends AnalysisResult {
  stats?: { files: number; functions: number; classes: number; dependencies: number; circularDeps: number; deadCode: number };
}

/** Helper: get unified stats from analysis (handles both old and new format) */
function getStats(analysis: AnalysisResultLocal) {
  const ec = analysis.entityCounts;
  const st = analysis.stats;
  return {
    files: st?.files ?? analysis.totalFilesAnalyzed ?? ec?.modules ?? 0,
    modules: ec?.modules ?? st?.files ?? analysis.totalFilesAnalyzed ?? 0,
    functions: ec?.functions ?? st?.functions ?? 0,
    classes: ec?.classes ?? st?.classes ?? 0,
    dependencies: ec?.dependencies ?? st?.dependencies ?? 0,
    circularDeps: ec?.circularDeps ?? st?.circularDeps ?? 0,
    deadCode: ec?.deadCode ?? st?.deadCode ?? 0,
  };
}

// Auto-discover all projects with .codeatlas/analysis.json
function discoverProjects(): { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/home";

  // Scan directories for .codeatlas/analysis.json
  const searchDirs: string[] = [];

  // Add env var project if specified
  if (process.env.CODEATLAS_PROJECT_DIR) {
    searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
  }

  // Add cwd
  searchDirs.push(process.cwd());

  // Scan home directory children (max depth 2)
  try {
    const homeDirs = fs.readdirSync(homeDir);
    for (const d of homeDirs) {
      if (d.startsWith(".")) continue;
      const fullPath = path.join(homeDir, d);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          searchDirs.push(fullPath);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // Check each directory for .codeatlas/analysis.json
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
    if (seen.has(analysisPath)) continue;
    seen.add(analysisPath);

    if (fs.existsSync(analysisPath)) {
      try {
        const stat = fs.statSync(analysisPath);
        projects.push({
          name: path.basename(dir),
          dir,
          analysisPath,
          modifiedAt: stat.mtime,
        });
      } catch { /* skip */ }
    }
  }

  // Sort by most recently modified
  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

function loadAnalysis(projectDir?: string): { analysis: AnalysisResult; projectName: string; projectDir: string } | null {
  const projects = discoverProjects();
  if (projects.length === 0) return null;

  let target = projects[0]; // default: most recently modified

  if (projectDir) {
    const match = projects.find(
      (p) => p.dir === projectDir || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) target = match;
  }

  try {
    const data = fs.readFileSync(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch {
    return null;
  }
}

// Create MCP server
const server = new McpServer(
  {
    name: "CodeAtlas",
    version: "2.1.6",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      logging: {},
    },
  }
);

// Auto-Indexing Logic
const projectRoot = process.cwd();
let isAutoIndexing = false;

const triggerAutoIndex = () => {
  if (isAutoIndexing) return;
  isAutoIndexing = true;
  console.log('[Auto-Index] Change detected, re-indexing...');
  
  exec('npx tsx run_indexing.ts', (error, stdout, stderr) => {
    isAutoIndexing = false;
    if (error) {
      console.error(`[Auto-Index] Error: ${error.message}`);
      return;
    }
    console.log('[Auto-Index] Success: Codebase updated.');
  });
};

let indexTimeout: NodeJS.Timeout | null = null;

// Watch for changes in all discovered projects
const projects = discoverProjects();
const watchPaths = projects.map(p => p.dir);

if (watchPaths.length === 0) {
  watchPaths.push(process.cwd());
}

const watcher = chokidar.watch(watchPaths, {
  ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
  persistent: true,
  ignoreInitial: true
});

watcher.on('change', (filePath) => {
  const project = projects.find(p => filePath.startsWith(p.dir));
  const projectName = project ? project.name : 'Unknown';
  
  console.log(`\n[Auto-Scan] ⚡ Change in [${projectName}]: ${filePath}`);
  
  if (indexTimeout) clearTimeout(indexTimeout);
  indexTimeout = setTimeout(() => {
    console.log(`[Auto-Scan] 🔄 Re-indexing [${projectName}]...`);
    
    // Run indexing in the project directory
    const cmd = `cd "${project?.dir || process.cwd()}" && npx tsx "${path.join(projectRoot, 'run_indexing.ts')}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Auto-Index] ❌ Error indexing ${projectName}: ${error.message}`);
        return;
      }
      console.log(`[Auto-Index] ✅ ${projectName} updated and synced to DB.`);
    });
  }, 2000);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`🚀 CODEATLAS ENTERPRISE v2.1.4 ONLINE`);
console.log(`📡 Auto-Indexing: WATCHING ${watchPaths.length} PROJECTS`);
watchPaths.forEach(p => console.log(`   - ${p}`));
console.log(`🛡️  Security: FIREBASE ADMIN ACTIVE`);
console.log(`${'='.repeat(50)}\n`);

// Setup Express app to serve as both MCP SSE and REST API
const app = express();
app.use(express.json());

// Enable CORS for dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// REST API: Get analysis data
app.get("/api/analysis", async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    await checkAuth(apiKey);
    const loaded = loadAnalysis();
    if (!loaded) return res.status(404).json({ error: "No analysis found" });
    res.json(loaded);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// REST API: Trigger re-index
app.post("/api/reindex", async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    await checkAuth(apiKey);
    const projectPath = process.env.CODEATLAS_PROJECT_DIR || process.cwd();
    const analyzer = new CodeAnalyzer(projectPath, 5000);
    const result = await analyzer.analyzeProject();
    const codeatlasDir = path.join(projectPath, ".codeatlas");
    if (!fs.existsSync(codeatlasDir)) fs.mkdirSync(codeatlasDir, { recursive: true });
    fs.writeFileSync(path.join(codeatlasDir, "analysis.json"), JSON.stringify(result, null, 2));
    res.json({ success: true, stats: getStats(result as any) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Tool -1: Analyze a project
server.tool(
  "analyze",
  "Perform deep code analysis on a local project directory. Generates .codeatlas/analysis.json.",
  {
    path: z.string().describe("Absolute path to the project directory to analyze"),
    maxFiles: z.number().optional().describe("Maximum files to analyze (default: 5000)"),
  },
  async ({ path: projectPath, maxFiles }: { path: string; maxFiles?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "analyze", { path: projectPath, maxFiles });
    
    if (!fs.existsSync(projectPath)) {
      return { content: [{ type: "text" as const, text: `Error: Directory does not exist: ${projectPath}` }] };
    }

    try {
      const analyzer = new CodeAnalyzer(projectPath, maxFiles || 5000);
      const result = await analyzer.analyzeProject();

      // Ensure .codeatlas directory exists
      const codeatlasDir = path.join(projectPath, ".codeatlas");
      if (!fs.existsSync(codeatlasDir)) {
        fs.mkdirSync(codeatlasDir, { recursive: true });
      }

      // Save analysis.json
      fs.writeFileSync(
        path.join(codeatlasDir, "analysis.json"),
        JSON.stringify(result, null, 2)
      );

      const stats = getStats(result as AnalysisResultLocal);
      const summary = `Analysis complete for ${path.basename(projectPath)}:
- Modules: ${stats.modules}
- Functions: ${stats.functions}
- Classes: ${stats.classes}
- Dependencies: ${stats.dependencies}
- Total files: ${result.totalFilesAnalyzed}
- Files skipped: ${result.totalFilesSkipped}`;

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Analysis failed: ${error.message}` }] };
    }
  }
);

// Tool 0: List all discovered projects
server.tool(
  "list_projects",
  "List all projects that have been analyzed by CodeAtlas. Returns project names, paths, and last analysis time.",
  {},
  async () => {
    // Enterprise edition: full access enabled
    const projects = discoverProjects();
    if (projects.length === 0) {
      return { content: [{ type: "text" as const, text: "No analyzed projects found. Run 'analyze' tool first." }] };
    }

    const result = {
      projectCount: projects.length,
      projects: projects.map((p) => ({
        name: p.name,
        path: p.dir,
        lastAnalyzed: p.modifiedAt.toISOString(),
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 1: Get project structure
server.tool(
  "get_project_structure",
  "Get all modules, classes, functions, and variables in the analyzed project. Returns entity type, name, file path, and line number.",
  {
    project: z.string().optional().describe("Project name or path (auto-detects if omitted)"),
    type: z.enum(["all", "module", "class", "function", "variable"]).optional().describe("Filter by entity type"),
    limit: z.number().optional().describe("Max results to return (default: 100)"),
  },
  async ({ project, type, limit }: { project?: string; type?: string; limit?: number }) => {
    const tier = await checkAuth();
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    let nodes = loaded.analysis.graph.nodes;
    if (type && type !== "all") {
      nodes = nodes.filter((n) => n.type === type);
    }

    // Filter out venv/node_modules entities
    nodes = nodes.filter((n) => {
      const fp = n.filePath || "";
      return !fp.includes("node_modules") && !fp.includes("venv") && !fp.includes(".venv") && !fp.includes("site-packages");
    });

    const maxResults = limit || 500; // Increased default limit for Enterprise
    const truncated = nodes.length > maxResults;
    nodes = nodes.slice(0, maxResults);

    const stats = getStats(loaded.analysis);

    const result = {
      project: loaded.projectName,
      projectDir: loaded.projectDir,
      total: loaded.analysis.graph.nodes.length,
      showing: nodes.length,
      truncated,
      stats,
      entities: nodes.map((n) => ({
        name: n.label,
        type: n.type,
        filePath: n.filePath || null,
        line: n.line || null,
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 2: Get dependencies
server.tool(
  "get_dependencies",
  "Get import/call/containment/implements relationships between entities. Shows how modules, classes, and functions are connected.",
  {
    project: z.string().optional().describe("Project name or path"),
    source: z.string().optional().describe("Filter by source entity name"),
    target: z.string().optional().describe("Filter by target entity name"),
    relationship: z.enum(["all", "import", "call", "contains", "implements"]).optional().describe("Filter by relationship type"),
    limit: z.number().optional().describe("Max results (default: 100)"),
  },
  async ({ project, source, target, relationship, limit }: { project?: string; source?: string; target?: string; relationship?: string; limit?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "get_dependencies", { project, source, target, relationship, limit });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));
    let links = loaded.analysis.graph.links;

    if (relationship && relationship !== "all") {
      links = links.filter((l) => l.type === relationship);
    }
    if (source) {
      links = links.filter((l) => {
        const label = nodeMap.get(l.source) || l.source;
        return label.toLowerCase().includes(source.toLowerCase());
      });
    }
    if (target) {
      links = links.filter((l) => {
        const label = nodeMap.get(l.target) || l.target;
        return label.toLowerCase().includes(target.toLowerCase());
      });
    }

    // Deduplicate links
    const linkDedup = new Set<string>();
    links = links.filter((l) => {
      const key = l.source + '|' + l.target + '|' + l.type;
      if (linkDedup.has(key)) return false;
      linkDedup.add(key);
      return true;
    });

    const maxResults = limit || 100;
    const truncated = links.length > maxResults;
    links = links.slice(0, maxResults);

    const result = {
      total: loaded.analysis.graph.links.length,
      showing: links.length,
      truncated,
      dependencies: links.map((l) => ({
        source: nodeMap.get(l.source) || l.source,
        target: nodeMap.get(l.target) || l.target,
        type: l.type,
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 3: Get AI insights
server.tool(
  "get_insights",
  "Get AI-generated code insights including refactoring suggestions, security issues, and maintainability analysis.",
  {},
  async () => {
    const auth = await checkAuth();
    await logActivity(auth, "get_insights", {});
    const loaded = loadAnalysis();
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const stats = getStats(loaded.analysis);

    const result = {
      project: loaded.projectName,
      stats,
      insights: loaded.analysis.insights,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 4: Search entities
server.tool(
  "search_entities",
  "Search for functions, classes, modules, or variables by name. Supports fuzzy matching.",
  {
    project: z.string().optional().describe("Project name or path"),
    query: z.string().describe("Search query (case-insensitive, partial match)"),
    type: z.enum(["all", "module", "class", "function", "variable"]).optional().describe("Filter by entity type"),
  },
  async ({ project, query, type }: { project?: string; query: string; type?: string }) => {
    const auth = await checkAuth();
    await logActivity(auth, "search_entities", { project, query, type });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    let nodes = loaded.analysis.graph.nodes;
    if (type && type !== "all") {
      nodes = nodes.filter((n) => n.type === type);
    }

    // Filter out venv/node_modules entities for cleaner results
    nodes = nodes.filter((n) => {
      if (n.id.startsWith('external:')) return false;
      if (n.filePath && (
        n.filePath.includes('/venv/') ||
        n.filePath.includes('/.venv/') ||
        n.filePath.includes('/node_modules/') ||
        n.filePath.includes('/site-packages/')
      )) return false;
      return true;
    });

    const q = query.toLowerCase();
    const matches = nodes.filter((n) => n.label.toLowerCase().includes(q));

    // For each match, find its relationships
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));

    const result = {
      query,
      matchCount: matches.length,
      results: matches.slice(0, 50).map((n) => {
        const incomingLinks = links
          .filter((l) => l.target === n.id)
          .map((l) => ({ from: nodeMap.get(l.source) || l.source, type: l.type }));
        const outgoingLinks = links
          .filter((l) => l.source === n.id)
          .map((l) => ({ to: nodeMap.get(l.target) || l.target, type: l.type }));

        return {
          name: n.label,
          type: n.type,
          filePath: n.filePath || null,
          line: n.line || null,
          incomingRelationships: incomingLinks,
          outgoingRelationships: outgoingLinks,
        };
      }),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 5: Get file entities
server.tool(
  "get_file_entities",
  "Get all entities (classes, functions, variables) defined in a specific file.",
  {
    project: z.string().optional().describe("Project name or path"),
    filePath: z.string().describe("File path (partial match, e.g. 'User.php' or 'src/models')"),
  },
  async ({ filePath, project }: { project?: string; filePath: string }) => {
    const auth = await checkAuth();
    await logActivity(auth, "get_file_entities", { filePath, project });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const q = filePath.toLowerCase().replace(/\\/g, "/");
    const matches = loaded.analysis.graph.nodes.filter((n) => {
      const fp = (n.filePath || n.id).toLowerCase().replace(/\\/g, "/");
      return fp.includes(q);
    });

    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(loaded.analysis.graph.nodes.map((n) => [n.id, n.label]));

    // Group by file
    const byFile = new Map<string, typeof matches>();
    for (const n of matches) {
      const fp = n.filePath || "unknown";
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp)!.push(n);
    }

    let filesEntries = Array.from(byFile.entries());
    // No limit for Enterprise

    const result = {
      query: filePath,
      filesFound: byFile.size,
      showing: filesEntries.length,
      truncated: byFile.size > filesEntries.length,
      files: filesEntries.map(([fp, entities]) => ({
        filePath: fp,
        entities: entities.map((e) => ({
          name: e.label,
          type: e.type,
          line: e.line || null,
          dependencies: links
            .filter((l) => l.source === e.id)
            .map((l) => ({ to: nodeMap.get(l.target) || l.target, type: l.type })),
        })),
      })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 6: Generate System Flow — Auto-generate Mermaid diagram from code analysis
server.tool(
  "generate_system_flow",
  "Auto-generate a Mermaid flowchart diagram showing how modules, classes, and functions connect in the system. Returns a Mermaid diagram string that AI can read to understand the full system flow without reading every file.",
  {
    project: z.string().optional().describe("Project name or path"),
    scope: z.enum(["full", "modules-only", "feature"]).optional().describe("Scope of the diagram: 'full' shows all entities, 'modules-only' shows only module relationships (recommended for large projects), 'feature' requires the 'feature' param"),
    feature: z.string().optional().describe("Feature keyword to focus the diagram on (e.g. 'auth', 'crawl', 'payment'). Only used when scope='feature'"),
    maxNodes: z.number().optional().describe("Maximum nodes in diagram (default: 60). Reduce for large projects"),
  },
  async ({ project, scope, feature, maxNodes }: { project?: string; scope?: string; feature?: string; maxNodes?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "generate_system_flow", { project, scope, feature, maxNodes });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const max = maxNodes || 60;
    const diagramScope = scope || "modules-only";
    let nodes = loaded.analysis.graph.nodes;
    let links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Filter by scope
    if (diagramScope === "modules-only") {
      nodes = nodes.filter((n) => n.type === "module" && (n.filePath || n.id.startsWith("external:")));
      const nodeIds = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target) && l.type === "import");
    } else if (diagramScope === "feature" && feature) {
      const q = feature.toLowerCase();
      // Find nodes matching the feature keyword
      const matchingNodes = new Set<string>();
      nodes.forEach((n) => {
        if (n.label.toLowerCase().includes(q) || (n.filePath && n.filePath.toLowerCase().includes(q))) {
          matchingNodes.add(n.id);
        }
      });
      // Expand to include connected nodes (1 hop)
      links.forEach((l) => {
        if (matchingNodes.has(l.source)) matchingNodes.add(l.target);
        if (matchingNodes.has(l.target)) matchingNodes.add(l.source);
      });
      nodes = nodes.filter((n) => matchingNodes.has(n.id));
      const nodeIds = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));
    }

    // Truncate if too many nodes
    if (nodes.length > max) {
      // Prioritize: modules > classes > functions > variables
      const priorityOrder = ["module", "class", "function", "variable"];
      nodes.sort((a, b) => {
        const ia = priorityOrder.indexOf(a.type);
        const ib = priorityOrder.indexOf(b.type);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      nodes = nodes.slice(0, max);
    }

    const truncatedNodeIds = new Set(nodes.map((n) => n.id));
    links = links.filter((l) => truncatedNodeIds.has(l.source) && truncatedNodeIds.has(l.target));

    // Remove duplicate links
    const linkSet = new Set<string>();
    links = links.filter((l) => {
      const key = `${l.source}|${l.target}|${l.type}`;
      if (linkSet.has(key)) return false;
      linkSet.add(key);
      return true;
    });

    // Build Mermaid diagram
    const nodeIdMap = new Map<string, string>();
    let counter = 0;

    const getMermaidId = (nodeId: string) => {
      if (!nodeIdMap.has(nodeId)) {
        nodeIdMap.set(nodeId, `n${counter++}`);
      }
      return nodeIdMap.get(nodeId)!;
    };

    const lines: string[] = ["graph TD"];

    // Add node declarations
    for (const node of nodes) {
      const mid = getMermaidId(node.id);
      const label = node.label.replace(/"/g, "'");
      const typeIcon = node.type === "module" ? "📄" : node.type === "class" ? "🏗️" : node.type === "function" ? "⚡" : "📦";
      if (node.type === "module") {
        lines.push(`    ${mid}["${typeIcon} ${label}"]`);
      } else if (node.type === "class") {
        lines.push(`    ${mid}[["${typeIcon} ${label}"]]`);
      } else {
        lines.push(`    ${mid}("${typeIcon} ${label}")`);
      }
    }

    // Add link declarations
    const arrowMap: Record<string, string> = { import: "-->", call: "-.->", contains: "-->", implements: "-.->|implements|" };
    const labelMap: Record<string, string> = { import: "imports", call: "calls", contains: "contains", implements: "implements" };
    for (const link of links) {
      const src = getMermaidId(link.source);
      const tgt = getMermaidId(link.target);
      if (src && tgt) {
        const arrow = arrowMap[link.type] || "-->";
        if (link.type === "contains") {
          lines.push(`    ${src} ${arrow} ${tgt}`);
        } else {
          lines.push(`    ${src} ${arrow}|${labelMap[link.type] || link.type}| ${tgt}`);
        }
      }
    }

    const mermaid = lines.join("\n");

    const result = {
      project: loaded.projectName,
      scope: diagramScope,
      feature: feature || null,
      nodeCount: nodes.length,
      linkCount: links.length,
      truncated: loaded.analysis.graph.nodes.length > max,
      mermaidDiagram: mermaid,
      summary: `System flow for ${loaded.projectName}: ${nodes.filter((n) => n.type === "module").length} modules, ${nodes.filter((n) => n.type === "class").length} classes, ${nodes.filter((n) => n.type === "function").length} functions connected by ${links.length} relationships.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 7: Sync System Memory — Create/update .agents/memory/ persistent files
server.tool(
  "sync_system_memory",
  "Create or update the .agents/memory/ folder with auto-generated system documentation. This folder serves as AI's 'long-term memory' — it persists between conversations. After calling this, AI in any future conversation can read these files to understand the full system flow without re-analyzing. Call this after completing any code changes.",
  {
    project: z.string().optional().describe("Project name or path"),
    businessRule: z.string().optional().describe("Optional: A new business rule to add to the memory (e.g. 'VIP users get free shipping')"),
    changeDescription: z.string().optional().describe("Optional: Description of what was just changed (for the changelog)"),
    enableEnterpriseSync: z.boolean().optional().describe("If true, syncs data to Oracle 26ai Knowledge Graph (Pro/Plus feature). Default is false."),
  },
  async ({ project, businessRule, changeDescription, enableEnterpriseSync }: { project?: string; businessRule?: string; changeDescription?: string; enableEnterpriseSync?: boolean }) => {
    const auth = await checkAuth();
    await logActivity(auth, "sync_system_memory", { project, businessRule, changeDescription, enableEnterpriseSync });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const memoryDir = path.join(loaded.projectDir, ".agents", "memory");
    
    // Create directory structure
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to create .agents/memory/ directory: ${e}` }] };
    }

    const nodes = loaded.analysis.graph.nodes;
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const nodeNameMap = new Map(nodes.map((n) => [n.id, n.label]));
    const unifiedStats = getStats(loaded.analysis);

    // === 1. system-map.md — Mermaid diagram of module relationships ===
    const modules = nodes.filter((n) => n.type === "module" && n.filePath);
    const moduleLinks = links.filter((l) => {
      const src = nodeMap.get(l.source);
      const tgt = nodeMap.get(l.target);
      return src?.type === "module" && tgt?.type === "module" && src.filePath && tgt.filePath && l.type === "import";
    });

    // Deduplicate module links
    const mlSet = new Set<string>();
    const dedupModuleLinks = moduleLinks.filter((l) => {
      const key = `${l.source}|${l.target}`;
      if (mlSet.has(key)) return false;
      mlSet.add(key);
      return true;
    });

    // Build compact mermaid (max 50 modules for readability)
    const topModules = modules.slice(0, 50);
    const topModuleIds = new Set(topModules.map((m) => m.id));
    const topModuleLinks = dedupModuleLinks.filter((l) => topModuleIds.has(l.source) && topModuleIds.has(l.target));

    let mermaidLines = ["```mermaid", "graph TD"];
    let nodeCounter = 0;
    const mermaidIdMap = new Map<string, string>();
    for (const mod of topModules) {
      const mid = `m${nodeCounter++}`;
      mermaidIdMap.set(mod.id, mid);
      mermaidLines.push(`    ${mid}["📄 ${mod.label}"]`);
    }
    for (const link of topModuleLinks) {
      const s = mermaidIdMap.get(link.source);
      const t = mermaidIdMap.get(link.target);
      if (s && t) mermaidLines.push(`    ${s} -->|imports| ${t}`);
    }
    mermaidLines.push("```");

    const systemMapContent = [
      `# System Map — ${loaded.projectName}`,
      `> Auto-generated by CodeAtlas MCP on ${new Date().toISOString()}`,
      `> **DO NOT EDIT MANUALLY** — This file is regenerated by \`sync_system_memory\``,
      "",
      `## Overview`,
      `- **Modules**: ${unifiedStats.modules}`,
      `- **Functions**: ${unifiedStats.functions}`,
      `- **Classes**: ${unifiedStats.classes}`,
      `- **Dependencies**: ${unifiedStats.dependencies}`,
      `- **Circular Deps**: ${unifiedStats.circularDeps}`,
      "",
      `## Module Dependency Graph`,
      ...mermaidLines,
      "",
      `## Key Modules (by connection count)`,
    ].join("\n");

    // Count connections per module
    const moduleConnections = new Map<string, number>();
    for (const link of links) {
      if (link.type === "import") {
        moduleConnections.set(link.source, (moduleConnections.get(link.source) || 0) + 1);
        moduleConnections.set(link.target, (moduleConnections.get(link.target) || 0) + 1);
      }
    }
    const keyModules = modules
      .map((m) => ({ name: m.label, path: m.filePath, connections: moduleConnections.get(m.id) || 0 }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 20);

    const keyModulesSection = keyModules
      .map((m, i) => `${i + 1}. **${m.name}** (${m.connections} connections) — \`${path.relative(loaded.projectDir, m.path || "")}\``)
      .join("\n");

    fs.writeFileSync(path.join(memoryDir, "system-map.md"), systemMapContent + "\n" + keyModulesSection + "\n");

    // === 2. modules.json — Module registry ===
    const modulesJson = modules.map((m) => {
      const contained = links
        .filter((l) => l.source === m.id && l.type === "contains")
        .map((l) => {
          const target = nodeMap.get(l.target);
          return target ? { name: target.label, type: target.type } : null;
        })
        .filter(Boolean);

      const imports = links
        .filter((l) => l.source === m.id && l.type === "import")
        .map((l) => nodeNameMap.get(l.target) || l.target);

      return {
        name: m.label,
        path: m.filePath ? path.relative(loaded.projectDir, m.filePath) : null,
        contains: contained,
        imports: imports,
        connectionCount: moduleConnections.get(m.id) || 0,
      };
    });

    fs.writeFileSync(path.join(memoryDir, "modules.json"), JSON.stringify(modulesJson, null, 2));

    // === 3. feature-flows.json — Auto-detect feature groups ===
    // Group files by directory as "features"
    const featureMap = new Map<string, string[]>();
    for (const mod of modules) {
      if (!mod.filePath) continue;
      const rel = path.relative(loaded.projectDir, mod.filePath);
      const dir = path.dirname(rel).split(path.sep)[0] || ".";
      if (!featureMap.has(dir)) featureMap.set(dir, []);
      featureMap.get(dir)!.push(rel);
    }

    const featureFlows: Record<string, { files: string[]; entryPoints: string[] }> = {};
    for (const [dir, files] of featureMap) {
      // Entry points: files with most outgoing imports
      const entryPoints = files
        .map((f) => {
          const moduleId = `module:${f.replace(/\\/g, "/")}`;
          const outgoing = links.filter((l) => l.source === moduleId && l.type === "import").length;
          return { file: f, outgoing };
        })
        .sort((a, b) => b.outgoing - a.outgoing)
        .slice(0, 3)
        .map((e) => e.file);

      featureFlows[dir] = { files, entryPoints };
    }

    fs.writeFileSync(path.join(memoryDir, "feature-flows.json"), JSON.stringify(featureFlows, null, 2));

    // === 4. business-rules.json — Persist business rules ===
    const businessRulesPath = path.join(memoryDir, "business-rules.json");
    let businessRules: Array<{ rule: string; addedAt: string }> = [];
    if (fs.existsSync(businessRulesPath)) {
      try {
        const parsedBR = JSON.parse(fs.readFileSync(businessRulesPath, "utf-8"));
        businessRules = Array.isArray(parsedBR) ? parsedBR : [];
      } catch { /* start fresh */ }
    }
    if (businessRule) {
      businessRules.push({ rule: businessRule, addedAt: new Date().toISOString() });
    }
    fs.writeFileSync(businessRulesPath, JSON.stringify(businessRules, null, 2));

    // === 5. change-log.json — Track recent changes ===
    const changeLogPath = path.join(memoryDir, "change-log.json");
    let changeLog: Array<{ description: string; timestamp: string }> = [];
    if (fs.existsSync(changeLogPath)) {
      try {
        const parsedCL = JSON.parse(fs.readFileSync(changeLogPath, "utf-8"));
        changeLog = Array.isArray(parsedCL) ? parsedCL : [];
      } catch { /* start fresh */ }
    }
    if (changeDescription) {
      changeLog.unshift({ description: changeDescription, timestamp: new Date().toISOString() });
      // Keep only last 50 entries
      changeLog = changeLog.slice(0, 50);
    }
    fs.writeFileSync(changeLogPath, JSON.stringify(changeLog, null, 2));

    // === 6. conventions.md — Auto-detect conventions ===
    const langs = new Map<string, number>();
    modules.forEach((m) => {
      if (!m.filePath) return;
      const ext = path.extname(m.filePath);
      langs.set(ext, (langs.get(ext) || 0) + 1);
    });

    const topLangs = Array.from(langs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const dirs = Array.from(featureMap.keys()).sort();

    const conventionsContent = [
      `# Conventions — ${loaded.projectName}`,
      `> Auto-generated by CodeAtlas MCP on ${new Date().toISOString()}`,
      `> **DO NOT EDIT MANUALLY**`,
      "",
      `## Languages`,
      ...topLangs.map(([ext, count]) => `- \`${ext}\`: ${count} files`),
      "",
      `## Project Structure`,
      ...dirs.map((d) => `- \`${d}/\` — ${featureMap.get(d)?.length || 0} files`),
      "",
      `## Architecture Patterns Detected`,
      modules.some((m) => m.filePath?.includes("controller") || m.filePath?.includes("Controller"))
        ? "- ✅ MVC Pattern (Controllers detected)"
        : "",
      modules.some((m) => m.filePath?.includes("service") || m.filePath?.includes("Service"))
        ? "- ✅ Service Layer (Services detected)"
        : "",
      modules.some((m) => m.filePath?.includes("model") || m.filePath?.includes("Model"))
        ? "- ✅ Model Layer (Models detected)"
        : "",
      modules.some((m) => m.filePath?.includes("middleware") || m.filePath?.includes("Middleware"))
        ? "- ✅ Middleware Pattern"
        : "",
      modules.some((m) => m.filePath?.includes("test") || m.filePath?.includes("spec"))
        ? "- ✅ Test Suite Present"
        : "",
    ].filter(Boolean).join("\n");

    fs.writeFileSync(path.join(memoryDir, "conventions.md"), conventionsContent);

    // === 7. Sync to Oracle 26ai (Enterprise Knowledge Graph) — Gated and Default False ===
    if (enableEnterpriseSync) {
        try {
          console.error(`Syncing Knowledge Graph for ${loaded.projectName} to Oracle 26ai...`);
          await OracleMemoryService.saveSemanticMemory(loaded.projectName, nodes);
          await OracleMemoryService.saveRelationalMemory(loaded.projectName, links);
          if (businessRule) {
            await OracleMemoryService.saveEpisodicMemory(loaded.projectName, "BUSINESS_RULE", businessRule);
          }
          if (changeDescription) {
            await OracleMemoryService.saveEpisodicMemory(loaded.projectName, "CHANGE_LOG", changeDescription);
          }
        } catch (oracleErr) {
          console.error("Failed to sync to Oracle:", oracleErr);
        }
    }

    const result = {
      success: true,
      project: loaded.projectName,
      memoryDir,
      filesCreated: [
        "system-map.md",
        "modules.json",
        "feature-flows.json",
        "business-rules.json",
        "change-log.json",
        "conventions.md",
      ],
      stats: {
        modules: modules.length,
        totalEntities: nodes.length,
        totalLinks: links.length,
        businessRulesCount: businessRules.length,
        changeLogEntries: changeLog.length,
      },
      message: `System memory synced for ${loaded.projectName}. AI can read .agents/memory/ at the start of any new conversation to restore full context.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 8: Trace Feature Flow — Trace how a feature flows through the codebase
server.tool(
  "trace_feature_flow",
  "Trace the complete flow of a feature through the codebase. Given a keyword (e.g. 'login', 'payment', 'crawl'), finds all related files, classes, and functions, then orders them by dependency chain to show the execution flow. This helps AI understand which files to read when working on a feature.",
  {
    project: z.string().optional().describe("Project name or path"),
    keyword: z.string().describe("Feature keyword to trace (e.g. 'auth', 'crawl', 'payment', 'upload')"),
    depth: z.number().optional().describe("How many hops to follow from matching nodes (default: 2)"),
  },
  async ({ keyword, project, depth }: { keyword: string; project?: string; depth?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "trace_feature_flow", { keyword, project, depth });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const maxDepth = depth || 2;
    const q = keyword.toLowerCase();
    const nodes = loaded.analysis.graph.nodes;
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Step 1: Find seed nodes matching the keyword
    const seedNodes = new Set<string>();
    for (const node of nodes) {
      // Skip external modules and venv/node_modules files
      if (node.id.startsWith('external:')) continue;
      if (node.filePath && (
        node.filePath.includes('/venv/') ||
        node.filePath.includes('/.venv/') ||
        node.filePath.includes('/node_modules/') ||
        node.filePath.includes('/vendor/') ||
        node.filePath.includes('/site-packages/')
      )) continue;

      if (
        node.label.toLowerCase().includes(q) ||
        (node.filePath && node.filePath.toLowerCase().includes(q)) ||
        node.id.toLowerCase().includes(q)
      ) {
        seedNodes.add(node.id);
      }
    }

    if (seedNodes.size === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              keyword,
              matchCount: 0,
              message: `No entities found matching '${keyword}'. Try a broader keyword.`,
              suggestions: nodes
                .filter((n) => n.type === "module" && n.filePath)
                .map((n) => n.label)
                .slice(0, 10),
            }, null, 2),
          },
        ],
      };
    }

    // Step 2: BFS expansion to find connected nodes
    const visited = new Set<string>(seedNodes);
    let frontier = new Set<string>(seedNodes);

    for (let d = 0; d < maxDepth; d++) {
      const nextFrontier = new Set<string>();
      for (const link of links) {
        if (frontier.has(link.source) && !visited.has(link.target)) {
          nextFrontier.add(link.target);
          visited.add(link.target);
        }
        if (frontier.has(link.target) && !visited.has(link.source)) {
          nextFrontier.add(link.source);
          visited.add(link.source);
        }
      }
      frontier = nextFrontier;
    }

    // Step 3: Build the trace result
    const traceNodes = nodes.filter((n) => visited.has(n.id));
    const traceLinks = links.filter((l) => visited.has(l.source) && visited.has(l.target));

    // Group by file for readability
    const byFile = new Map<string, Array<{ name: string; type: string; isSeed: boolean; line: number | null }>>();
    for (const node of traceNodes) {
      const filePath = node.filePath || "external";
      if (!byFile.has(filePath)) byFile.set(filePath, []);
      byFile.get(filePath)!.push({
        name: node.label,
        type: node.type,
        isSeed: seedNodes.has(node.id),
        line: node.line || null,
      });
    }

    // Sort files: seed files first, then by entity count
    const filesArray = Array.from(byFile.entries())
      .map(([filePath, entities]) => ({
        filePath: filePath === "external" ? "external" : path.relative(loaded.projectDir, filePath),
        absolutePath: filePath,
        entities,
        hasSeedMatch: entities.some((e) => e.isSeed),
        entityCount: entities.length,
      }))
      .sort((a, b) => {
        if (a.hasSeedMatch && !b.hasSeedMatch) return -1;
        if (!a.hasSeedMatch && b.hasSeedMatch) return 1;
        return b.entityCount - a.entityCount;
      });

    const result = {
      keyword,
      project: loaded.projectName,
      seedMatches: seedNodes.size,
      totalConnected: visited.size,
      depth: maxDepth,
      files: filesArray.filter((f) => f.filePath !== "external").slice(0, 30),
      externalDeps: filesArray.find((f) => f.filePath === "external")?.entities.map((e) => e.name) || [],
      relationships: traceLinks.slice(0, 50).map((l) => ({
        from: nodeMap.get(l.source)?.label || l.source,
        to: nodeMap.get(l.target)?.label || l.target,
        type: l.type,
      })),
      readingOrder: filesArray
        .filter((f) => f.hasSeedMatch && f.filePath !== "external")
        .map((f) => f.filePath),
      message: `Found ${seedNodes.size} direct matches and ${visited.size - seedNodes.size} connected entities for '${keyword}'. Start reading from the files in 'readingOrder'.`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 9: Generate Feature Flow Diagram — Mermaid execution flow for a feature
server.tool(
  "generate_feature_flow_diagram",
  "Generate a Mermaid diagram showing the EXECUTION FLOW of a feature. Unlike generate_system_flow (which shows module imports), this traces the actual call chain: entry point → controller → service → model → database. Given a keyword, it finds all related functions and classes, then builds a flowchart or sequence diagram showing how they call each other at runtime. This is the best tool for understanding HOW a feature works step-by-step.",
  {
    project: z.string().optional().describe("Project name or path"),
    keyword: z.string().describe("Feature keyword to trace (e.g. 'login', 'payment', 'upload', 'auth')"),
    diagramType: z.enum(["flowchart", "sequence"]).optional().describe("Type of Mermaid diagram: 'flowchart' (default) shows call graph, 'sequence' shows step-by-step execution order"),
    depth: z.number().optional().describe("How many call hops to follow (default: 3)"),
    maxNodes: z.number().optional().describe("Maximum nodes in diagram (default: 40)"),
  },
  async ({ project, keyword, diagramType, depth, maxNodes }: { project?: string; keyword: string; diagramType?: 'flowchart' | 'sequence'; depth?: number; maxNodes?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "generate_feature_flow_diagram", { project, keyword, diagramType, depth, maxNodes });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    const q = keyword.toLowerCase();
    const maxDepth = depth || 3;
    const maxN = maxNodes || 40;
    const dType = diagramType || "flowchart";
    const nodes = loaded.analysis.graph.nodes;
    const links = loaded.analysis.graph.links;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const nodeNameMap = new Map(nodes.map((n) => [n.id, n.label]));

    // Step 1: Find seed nodes matching keyword
    const seedNodes = new Set<string>();
    for (const node of nodes) {
      // Skip external modules and venv/node_modules files
      if (node.id.startsWith('external:')) continue;
      if (node.filePath && (
        node.filePath.includes('/venv/') ||
        node.filePath.includes('/.venv/') ||
        node.filePath.includes('/node_modules/') ||
        node.filePath.includes('/vendor/') ||
        node.filePath.includes('/site-packages/')
      )) continue;

      if (
        node.label.toLowerCase().includes(q) ||
        (node.filePath && node.filePath.toLowerCase().includes(q)) ||
        node.id.toLowerCase().includes(q)
      ) {
        seedNodes.add(node.id);
      }
    }

    if (seedNodes.size === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            keyword,
            matchCount: 0,
            message: `No entities found matching '${keyword}'. Try a broader keyword.`,
            suggestions: nodes
              .filter((n) => n.type === "function" || n.type === "class")
              .map((n) => n.label)
              .filter((l, i, arr) => arr.indexOf(l) === i)
              .slice(0, 15),
          }, null, 2),
        }],
      };
    }

    // Step 2: BFS expand following CALL relationships (execution flow)
    const visited = new Set<string>(seedNodes);
    let frontier = new Set<string>(seedNodes);

    // Also follow `contains` to find methods inside classes
    const callAndContainsLinks = links.filter((l) => l.type === "call" || l.type === "contains");

    for (let d = 0; d < maxDepth; d++) {
      const nextFrontier = new Set<string>();
      for (const link of callAndContainsLinks) {
        if (frontier.has(link.source) && !visited.has(link.target)) {
          nextFrontier.add(link.target);
          visited.add(link.target);
        }
        if (frontier.has(link.target) && !visited.has(link.source)) {
          nextFrontier.add(link.source);
          visited.add(link.source);
        }
      }
      frontier = nextFrontier;
      if (nextFrontier.size === 0) break;
    }

    // Step 3: Get trace nodes (only functions, classes, methods — skip modules/variables for execution flow)
    let traceNodes = nodes.filter((n) => visited.has(n.id) && (n.type === "function" || n.type === "class"));

    // Truncate if too many
    if (traceNodes.length > maxN) {
      // Prioritize: seed matches first, then by call connections
      const callConnections = new Map<string, number>();
      for (const link of links) {
        if (link.type === "call") {
          callConnections.set(link.source, (callConnections.get(link.source) || 0) + 1);
          callConnections.set(link.target, (callConnections.get(link.target) || 0) + 1);
        }
      }
      traceNodes.sort((a, b) => {
        if (seedNodes.has(a.id) && !seedNodes.has(b.id)) return -1;
        if (!seedNodes.has(a.id) && seedNodes.has(b.id)) return 1;
        return (callConnections.get(b.id) || 0) - (callConnections.get(a.id) || 0);
      });
      traceNodes = traceNodes.slice(0, maxN);
    }

    const traceNodeIds = new Set(traceNodes.map((n) => n.id));
    const traceLinks = links.filter(
      (l) => traceNodeIds.has(l.source) && traceNodeIds.has(l.target) && l.type === "call"
    );

    // Deduplicate links
    const linkSet = new Set<string>();
    const dedupLinks = traceLinks.filter((l) => {
      const key = `${l.source}|${l.target}`;
      if (linkSet.has(key)) return false;
      linkSet.add(key);
      return true;
    });

    // Step 4: Identify entry points (nodes with no incoming call edges or seed matches)
    const hasIncoming = new Set<string>();
    for (const link of dedupLinks) {
      hasIncoming.add(link.target);
    }
    const entryPoints = traceNodes.filter(
      (n) => !hasIncoming.has(n.id) || seedNodes.has(n.id)
    );

    // Step 5: Build Mermaid diagram
    let mermaid = "";
    const sanitizeLabel = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

    if (dType === "sequence") {
      // === Sequence Diagram ===
      const seqLines: string[] = ["sequenceDiagram"];

      // Declare participants (group by file/class)
      const participantMap = new Map<string, string>();
      let pCounter = 0;
      for (const node of traceNodes) {
        const pid = `P${pCounter++}`;
        participantMap.set(node.id, pid);
        const icon = node.type === "class" ? "🏗️" : "⚡";
        const fileSuffix = node.filePath ? ` (${path.basename(node.filePath)})` : "";
        seqLines.push(`    participant ${pid} as ${icon} ${sanitizeLabel(node.label)}${fileSuffix}`);
      }

      // Add call arrows
      for (const link of dedupLinks) {
        const src = participantMap.get(link.source);
        const tgt = participantMap.get(link.target);
        if (src && tgt && src !== tgt) {
          seqLines.push(`    ${src}->>+${tgt}: calls`);
          seqLines.push(`    ${tgt}-->>-${src}: returns`);
        }
      }

      mermaid = seqLines.join("\n");
    } else {
      // === Flowchart Diagram ===
      const flowLines: string[] = ["graph TD"];

      // Style definitions
      flowLines.push("    classDef entry fill:#4CAF50,stroke:#388E3C,color:#fff,stroke-width:2px");
      flowLines.push("    classDef seed fill:#2196F3,stroke:#1565C0,color:#fff,stroke-width:2px");
      flowLines.push("    classDef cls fill:#FF9800,stroke:#E65100,color:#fff");
      flowLines.push("    classDef func fill:#607D8B,stroke:#37474F,color:#fff");

      // Add nodes
      const mermaidIdMap = new Map<string, string>();
      let nCounter = 0;
      for (const node of traceNodes) {
        const mid = `f${nCounter++}`;
        mermaidIdMap.set(node.id, mid);
        const label = sanitizeLabel(node.label);
        const fileSuffix = node.filePath ? `<br/>${path.basename(node.filePath)}` : "";

        if (node.type === "class") {
          flowLines.push(`    ${mid}[["🏗️ ${label}${fileSuffix}"]]`);
        } else {
          flowLines.push(`    ${mid}("⚡ ${label}${fileSuffix}")`);
        }

        // Apply styles
        if (entryPoints.includes(node) && !hasIncoming.has(node.id)) {
          flowLines.push(`    class ${mid} entry`);
        } else if (seedNodes.has(node.id)) {
          flowLines.push(`    class ${mid} seed`);
        } else if (node.type === "class") {
          flowLines.push(`    class ${mid} cls`);
        } else {
          flowLines.push(`    class ${mid} func`);
        }
      }

      // Add call arrows
      for (const link of dedupLinks) {
        const src = mermaidIdMap.get(link.source);
        const tgt = mermaidIdMap.get(link.target);
        if (src && tgt) {
          flowLines.push(`    ${src} -->|calls| ${tgt}`);
        }
      }

      // Add legend
      flowLines.push("");
      flowLines.push(`    subgraph Legend`);
      flowLines.push(`        L1("🟢 Entry Point"):::entry`);
      flowLines.push(`        L2("🔵 Keyword Match"):::seed`);
      flowLines.push(`        L3("🟠 Class"):::cls`);
      flowLines.push(`        L4("⬜ Function"):::func`);
      flowLines.push(`    end`);

      mermaid = flowLines.join("\n");
    }

    // Step 6: Build execution order (topological sort)
    const executionOrder: Array<{
      step: number;
      name: string;
      type: string;
      file: string | null;
      line: number | null;
      callsTo: string[];
      calledBy: string[];
    }> = [];

    // Simple topological ordering
    const inDegree = new Map<string, number>();
    for (const node of traceNodes) {
      inDegree.set(node.id, 0);
    }
    for (const link of dedupLinks) {
      inDegree.set(link.target, (inDegree.get(link.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let step = 1;
    const ordered = new Set<string>();
    while (queue.length > 0 && step <= maxN) {
      const current = queue.shift()!;
      if (ordered.has(current)) continue;
      ordered.add(current);

      const node = nodeMap.get(current);
      if (node) {
        const callsTo = dedupLinks
          .filter((l) => l.source === current)
          .map((l) => nodeNameMap.get(l.target) || l.target);
        const calledBy = dedupLinks
          .filter((l) => l.target === current)
          .map((l) => nodeNameMap.get(l.source) || l.source);

        executionOrder.push({
          step: step++,
          name: node.label,
          type: node.type,
          file: node.filePath ? path.relative(loaded.projectDir, node.filePath) : null,
          line: node.line || null,
          callsTo,
          calledBy,
        });
      }

      // Add neighbors
      for (const link of dedupLinks) {
        if (link.source === current) {
          const newDeg = (inDegree.get(link.target) || 1) - 1;
          inDegree.set(link.target, newDeg);
          if (newDeg <= 0 && !ordered.has(link.target)) {
            queue.push(link.target);
          }
        }
      }
    }

    // Add any remaining unvisited nodes (cycles)
    for (const node of traceNodes) {
      if (!ordered.has(node.id)) {
        const callsTo = dedupLinks
          .filter((l) => l.source === node.id)
          .map((l) => nodeNameMap.get(l.target) || l.target);
        const calledBy = dedupLinks
          .filter((l) => l.target === node.id)
          .map((l) => nodeNameMap.get(l.source) || l.source);

        executionOrder.push({
          step: step++,
          name: node.label,
          type: node.type,
          file: node.filePath ? path.relative(loaded.projectDir, node.filePath) : null,
          line: node.line || null,
          callsTo,
          calledBy,
        });
      }
    }

    const result = {
      keyword,
      project: loaded.projectName,
      diagramType: dType,
      seedMatches: seedNodes.size,
      nodesInDiagram: traceNodes.length,
      callRelationships: dedupLinks.length,
      entryPoints: entryPoints.map((n) => ({
        name: n.label,
        type: n.type,
        file: n.filePath ? path.relative(loaded.projectDir, n.filePath) : null,
      })),
      mermaidDiagram: mermaid,
      executionOrder,
      readingOrder: executionOrder
        .filter((e) => e.file)
        .map((e) => e.file!)
        .filter((f, i, arr) => arr.indexOf(f) === i),
      message: `Generated ${dType} diagram for '${keyword}': ${traceNodes.length} nodes, ${dedupLinks.length} call relationships. Entry points: ${entryPoints.map((n) => n.label).join(", ")}`,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 11: Detect Architectural Smells — Knowledge Graph Reasoning
server.tool(
  "detect_architectural_smells",
  "Knowledge Graph Reasoning: Use Oracle 26ai Graph features to automatically detect architectural weaknesses, circular dependencies, God objects, and dead code.",
  {
    project: z.string().optional().describe("Project name or path"),
  },
  async ({ project }: { project?: string }) => {
    const auth = await checkAuth();
    await logActivity(auth, "detect_architectural_smells", { project });
    const loaded = loadAnalysis(project);
    if (!loaded) {
      return { content: [{ type: "text" as const, text: "No analysis data found. Run 'analyze' tool first." }] };
    }

    try {
      const smells = await OracleMemoryService.detectArchitecturalSmells(loaded.projectName);
      if (!smells) {
        return { content: [{ type: "text" as const, text: "Failed to run graph reasoning on Oracle 26ai. Ensure graph tables are initialized." }] };
      }

      const result = {
        project: loaded.projectName,
        timestamp: new Date().toISOString(),
        findings: {
          circularDependencies: {
            count: smells.circularDependencies.length,
            details: smells.circularDependencies,
            impact: "High - Causes tight coupling and build issues."
          },
          godObjects: {
            count: smells.godObjects.length,
            details: smells.godObjects,
            impact: "Medium - Violates Single Responsibility Principle, hard to maintain."
          },
          deadCode: {
            count: smells.deadCode.length,
            details: smells.deadCode,
            impact: "Low - Increases codebase size and cognitive load."
          }
        },
        recommendation: "Review high-impact findings (Circular Dependencies) first. Refactor God Objects into smaller services."
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Oracle Graph Reasoning failed: ${err.message}` }] };
    }
  }
);

// Tool 12: Scan Enterprise Vulnerabilities — Full security & architecture audit for all projects
server.tool(
  "scan_enterprise_vulnerabilities",
  "Enterprise Scanner: Automatically scan all analyzed projects for bugs, security vulnerabilities (hardcoded secrets, unsafe functions), and architectural problems. Features Admin Insights and Security Scoring.",
  {
    maxProjects: z.number().optional().describe("Maximum number of projects to scan (default: all)"),
  },
  async ({ maxProjects }: { maxProjects?: number }) => {
    const auth = await checkAuth();
    await logActivity(auth, "scan_enterprise_vulnerabilities", { maxProjects });
    const projects = discoverProjects();
    
    if (projects.length === 0) {
      return { content: [{ type: "text" as const, text: "No analyzed projects found. Run 'analyze' tool first." }] };
    }

    const isEnterprise = auth.tier === 'enterprise';
    const scanResults: any[] = [];
    const limit = maxProjects || (isEnterprise ? projects.length : 3);
    const projectsToScan = projects.slice(0, limit);

    for (const p of projectsToScan) {
      try {
        const loaded = loadAnalysis(p.name);
        if (!loaded) continue;

        const vulnerabilities = SecurityScanner.scan(loaded.analysis);
        
        // Enterprise-only Risk Assessment
        const stats = getStats(loaded.analysis as any);
        const circularDeps = stats.circularDeps || 0;
        const deadCode = stats.deadCode || 0;
        
        const riskLevel = vulnerabilities.length > 10 ? "CRITICAL" : (vulnerabilities.length > 0 ? "HIGH" : "LOW");
        const securityScore = Math.max(0, 100 - (vulnerabilities.length * 5) - (circularDeps * 2));

        scanResults.push({
          project: p.name,
          riskLevel,
          securityScore: isEnterprise ? securityScore : "Upgrade to view",
          vulnerabilities: vulnerabilities.length,
          circularDependencies: circularDeps,
          deadCode: deadCode,
          adminInsights: isEnterprise ? `Project health is ${securityScore > 80 ? 'EXCELLENT' : 'NEEDS ATTENTION'}. Priority: ${riskLevel}.` : null,
          details: { vulnerabilities }
        });
      } catch (err: any) {
        scanResults.push({ 
          project: p.name, 
          error: `Scan failed: ${err.message}` 
        });
      }
    }

    const finalReport = {
      timestamp: new Date().toISOString(),
      tier: auth.tier,
      projectsScanned: projectsToScan.length,
      totalProjectsDiscovered: projects.length,
      results: scanResults,
      enterpriseStatus: isEnterprise ? "ACTIVE (Admin Enabled)" : "INACTIVE"
    };

    return { 
      content: [{ 
        type: "text" as const, 
        text: JSON.stringify(finalReport, null, 2)
      }] 
    };
  }
);

// Start server
async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : null;

  if (port) {
    // SSE Mode - for remote server deployment
    const app = express();

    // Serve static files from built dashboard
    const dashboardDistPath = path.join(process.cwd(), "dashboard", "dist");
    if (fs.existsSync(dashboardDistPath)) {
      app.use(express.static(dashboardDistPath));
      
      // SPA support: redirect all non-API routes to index.html
      app.get(/^\/(?!sse|messages|api).*/, (req, res) => {
        res.sendFile(path.join(dashboardDistPath, "index.html"));
      });
    }

    // Authentication middleware
    app.use(async (req, res, next) => {
      const clientKey = (req.headers["x-api-key"] as string) || (req.query.apiKey as string);
      try {
        await checkAuth(clientKey);
        next();
      } catch (err: any) {
        res.status(401).send(err.message);
      }
    });

    let transport: SSEServerTransport | null = null;

    app.get("/sse", async (req, res) => {
      console.error("New SSE connection");
      transport = new SSEServerTransport("/messages", res);
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send("No active SSE connection");
      }
    });

    // HTTP API for the VS Code Extension Thin Client
    app.get("/api/analysis", async (req, res) => {
      const projectDir = req.query.project as string;
      try {
        const loaded = loadAnalysis(projectDir);
        if (!loaded) {
          return res.status(404).send("Project analysis not found. Run 'analyze' tool first.");
        }
        res.json(loaded.analysis);
      } catch (e: any) {
        res.status(500).send(e.message);
      }
    });

    app.listen(port, () => {
      console.error(`CodeAtlas MCP SSE server running on port ${port}`);
      console.error(`- SSE endpoint: http://localhost:${port}/sse`);
      console.error(`- Message endpoint: http://localhost:${port}/messages`);
      if (process.env.CODEATLAS_API_KEY) {
        console.error(`- Security: API Key enabled`);
      } else {
        console.error(`- Security: DISABLED (Set CODEATLAS_API_KEY to enable)`);
      }
    });
  } else {
    // Stdio Mode - for local use (e.g. Claude Desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CodeAtlas MCP server running on stdio");
  }
}

main().catch(console.error);
