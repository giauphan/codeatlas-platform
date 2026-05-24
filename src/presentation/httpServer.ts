import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as fs from "fs";
import * as path from "path";
import { getAuth } from "firebase-admin/auth";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { checkAuth, logActivity } from "../services/authService.js";
import { 
  discoverProjectsAsync, 
  loadAnalysisAsync, 
  getStats, 
  fileExists,
  resolveProjectDir,
  unregisterProject
} from "../services/projectService.js";
import { authStorage } from "../context.js";
import { registerTools } from "./mcpServer.js";

// Wrapper object to allow clean mocking of Firebase services in testing environments
export const firebaseClient = {
  getApps: () => getApps(),
  getFirestore: () => getFirestore()
};

// Setup Express app to serve as both MCP SSE and REST API
export const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Enable CORS for dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Authentication middleware for ALL API routes
export const authMiddleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // 1. Support Firebase ID Token (Bearer Token) for Dashboard
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      let role = (decodedToken.role as string) || "user";
      if (role !== "admin") {
        try {
          const userDoc = await firebaseClient.getFirestore().collection("users").doc(decodedToken.uid).get();
          if (userDoc.exists) {
            role = userDoc.data()?.role || userDoc.data()?.tier || "user";
          }
        } catch (e) {
          console.error("Failed to fetch user role from Firestore:", e);
        }
      }

      const auth = {
        tier: "enterprise",
        uid: decodedToken.uid,
        email: decodedToken.email,
        role: role,
        keyId: "firebase-session"
      };
      (req as any).auth = auth;
      
      // Assign auth context for the entire asynchronous flow below
      authStorage.run(auth, () => {
        next();
      });
      return;
    } catch (err: unknown) {
      res.status(401).json({ error: `Invalid Firebase ID Token: ${(err instanceof Error ? err.message : String(err))}` });
      return;
    }
  }

  // 2. Support both header and query param for flexibility (Dashboard legacy vs MCP)
  const clientKey = (req.headers["x-api-key"] as string) || (req.query.apiKey as string);
  try {
    const auth = await checkAuth(clientKey);
    (req as any).auth = auth; // Attach auth result to request
    
    // Assign auth context for the entire asynchronous flow below
    authStorage.run(auth, () => {
      next();
    });
  } catch (err: unknown) {
    res.status(401).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
};

// REST API: Get all discovered projects
app.get("/api/projects", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    const projects = await discoverProjectsAsync(tenantId);
    res.json(projects.map(p => ({ name: p.name, dir: p.dir, modifiedAt: p.modifiedAt })));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Remove project and its associated data
app.delete("/api/projects", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    
    const rawProjectDir = req.query.projectDir;
    if (typeof rawProjectDir !== "string" || !rawProjectDir.trim()) {
      return res.status(400).json({ error: "Invalid or missing projectDir parameter. It must be a non-empty string." });
    }
    const projectDir = rawProjectDir.trim();
    
    const resolved = await resolveProjectDir(projectDir, tenantId, true);
    if (!resolved) {
      return res.status(403).json({ error: "Access denied or project not found" });
    }
    
    const { cleanProjectName, fullProjectDir } = resolved;
    
    // Derive target owner tenant from project path
    let ownerTenantId = tenantId;
    let isInsideTenantRoot = false;
    const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
    const normalizedTenantRoot = path.resolve(tenantRoot);
    
    // Resolve the real canonical path of the project to securely handle symlinks
    let realProjectDir: string;
    try {
      realProjectDir = await fs.promises.realpath(fullProjectDir);
    } catch {
      realProjectDir = path.resolve(fullProjectDir);
    }
    
    if (process.env.CODEATLAS_MULTI_TENANT === "true") {
      const relativePath = path.relative(normalizedTenantRoot, realProjectDir);
      isInsideTenantRoot = !!relativePath && !(relativePath === ".." || relativePath.startsWith(".." + path.sep)) && !path.isAbsolute(relativePath);
      
      const isSystemAdmin = auth
        ? (auth.uid === "admin" || auth.role === "admin" || auth.email === "admin@genrostore.com")
        : false;
        
      if (!isSystemAdmin) {
        if (!isInsideTenantRoot) {
          return res.status(403).json({ error: "Access denied: Project directory is outside the tenant root sandbox." });
        }
        if (tenantId) {
          const tenantRootPath = path.resolve(path.join(normalizedTenantRoot, tenantId));
          const relToTenant = path.relative(tenantRootPath, realProjectDir);
          const isInsideTenant = !!relToTenant && !(relToTenant === ".." || relToTenant.startsWith(".." + path.sep)) && !path.isAbsolute(relToTenant);
          if (!isInsideTenant) {
            return res.status(403).json({ error: "Access denied: Project directory is outside your tenant sandbox." });
          }
        }
      }

      if (isInsideTenantRoot) {
        const parts = relativePath.split(path.sep);
        if (parts.length > 0 && parts[0]) {
          ownerTenantId = parts[0];
        }
      }
    }
    
    const errors: string[] = [];

    // 1. Remove telemetry data from Firestore (if Firebase is configured)
    try {
      const apps = firebaseClient.getApps();
      if (apps.length) {
        const db = firebaseClient.getFirestore();
        const docId = ownerTenantId ? `${ownerTenantId}_${cleanProjectName}` : cleanProjectName;
        await db.collection('projects').doc(docId).delete();
        console.log(`[Delete Project] Deleted Firestore document: ${docId}`);
        
        // Securely handle legacy unscoped document cleanup if it exists
        if (ownerTenantId) {
          const legacyDocId = cleanProjectName;
          const legacyRef = db.collection('projects').doc(legacyDocId);
          const legacyDoc = await legacyRef.get();
          if (legacyDoc.exists) {
            const legacyData = legacyDoc.data();
            const legacyTenantId = legacyData?.tenantId;
            if (!legacyTenantId || legacyTenantId === ownerTenantId) {
              await legacyRef.delete();
              console.log(`[Delete Project] Cleaned up legacy Firestore document: ${legacyDocId}`);
            }
          }
        }
      }
    } catch (firebaseErr: any) {
      console.error(`[Delete Project] Failed to delete from Firestore: ${firebaseErr}`);
      errors.push(`Firestore cleanup failed: ${firebaseErr.message || String(firebaseErr)}`);
    }

    // 2. Remove semantic/relational/episodic memory from Oracle DB (if Oracle DB is configured)
    try {
      if (process.env.ORACLE_CONN_STRING) {
        const { OracleMemoryService } = await import("../oracleDatabase.js");
        await OracleMemoryService.deleteProjectMemory(cleanProjectName, ownerTenantId);
      }
    } catch (oracleErr: any) {
      console.error(`[Delete Project] Failed to delete from Oracle DB: ${oracleErr}`);
      const errMsg = oracleErr.message || String(oracleErr);
      // If it's a driver/library loading error (e.g. DPI-1047) or connection/network failure,
      // log as a warning and do not block local cleanup, since the DB is unreachable anyway.
      if (
        errMsg.includes("DPI-1047") ||
        errMsg.includes("NJS-511") ||
        errMsg.includes("NJS-040") ||
        errMsg.includes("connection") ||
        errMsg.includes("connect")
      ) {
        console.warn(`[Delete Project] Non-blocking Oracle library/connection warning during delete: ${errMsg}`);
      } else {
        errors.push(`Oracle DB cleanup failed: ${errMsg}`);
      }
    }

    const isForce = req.query.force === "true";

    // If remote cleanups fail, abort before deleting local files so the project remains discoverable and retryable
    // unless force=true is requested to allow recovery under DB connection failures
    if (errors.length > 0 && !isForce) {
      return res.status(500).json({
        success: false,
        error: "Remote cleanup failure. Local files and project registry were not modified to allow retries.",
        details: errors
      });
    }

    // 3. Remote cleanups succeeded (or force=true). Now clean up local index directory and empty tenant sandboxes
    try {
      const codeatlasDir = path.join(realProjectDir, ".codeatlas");
      
      let codeatlasLstat;
      try {
        codeatlasLstat = await fs.promises.lstat(codeatlasDir);
      } catch {}

      if (codeatlasLstat) {
        if (codeatlasLstat.isSymbolicLink()) {
          await fs.promises.unlink(codeatlasDir);
        } else if (fs.existsSync(codeatlasDir)) {
          await fs.promises.rm(codeatlasDir, { recursive: true, force: true });
        }
        console.log(`[Delete Project] Cleaned up directory: ${codeatlasDir}`);
      }

      // If multi-tenant mode is active, the project resides within the tenants directory, and the directory is empty after index cleanup, clean up the empty tenant project folder too
      if (process.env.CODEATLAS_MULTI_TENANT === "true" && isInsideTenantRoot) {
        if (realProjectDir !== normalizedTenantRoot && fs.existsSync(realProjectDir)) {
          const lstat = await fs.promises.lstat(fullProjectDir);
          if (lstat.isSymbolicLink()) {
            await fs.promises.unlink(fullProjectDir);
            console.log(`[Delete Project] Unlinked tenant project symlink: ${fullProjectDir}`);
          } else {
            const remainingFiles = await fs.promises.readdir(realProjectDir);
            if (remainingFiles.length === 0) {
              await fs.promises.rm(realProjectDir, { recursive: true, force: true });
              console.log(`[Delete Project] Cleaned up empty tenant sandbox directory: ${realProjectDir}`);
            }
          }
        }
      }
    } catch (dirErr: any) {
      errors.push(`Failed to clean up index directory: ${dirErr.message || String(dirErr)}`);
    }

    // 4. Unregister project from local registered list only if local cleanup was successful, or if force is enabled
    if (errors.length === 0 || isForce) {
      try {
        unregisterProject(fullProjectDir);
      } catch (regErr: any) {
        errors.push(`Failed to unregister project: ${regErr.message || String(regErr)}`);
      }
    }

    if (errors.length > 0 && !isForce) {
      return res.status(500).json({
        success: false,
        error: "Local cleanup or unregistration failure. Project registry may not have been updated.",
        details: errors
      });
    }

    res.json({ 
      success: true, 
      message: `Successfully removed project: ${cleanProjectName}`,
      details: errors.length > 0 ? errors : undefined
    });
  } catch (err: unknown) {
    console.error(`[Delete Project] Failed: ${(err instanceof Error ? err.message : String(err))}`);
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Get analysis data
app.get("/api/analysis", authMiddleware, async (req, res) => {
  try {
    const projectDir = (req.query.projectDir as string) || (req.query.project as string);
    const loaded = await loadAnalysisAsync(projectDir);
    if (!loaded) return res.status(404).json({ error: "No analysis found" });
    
    // Support legacy thin client format (which only expects the inner analysis object)
    if (req.query.project && !req.query.projectDir) {
      res.json(loaded.analysis);
    } else {
      res.json(loaded);
    }
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Trigger re-index
app.post("/api/reindex", authMiddleware, async (req, res) => {
  res.status(400).json({ 
    error: "Local indexing is not supported on a pure cloud API server. Please trigger indexing locally from your codeatlas-enterprise client to synchronize AST data." 
  });
});

// REST API: Securely sync local AST analysis from Local-First gateway and sync telemetry
app.post("/api/projects/sync", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    
    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized: Missing tenant identification" });
    }
    
    const { projectName, analysis, businessRule, changeDescription } = req.body;
    if (!projectName || !analysis) {
      return res.status(400).json({ error: "Missing projectName or analysis data" });
    }
    
    // Clean project name to avoid directory traversal
    const cleanProjectName = path.basename(projectName);
    
    // Resolve project directory on the VPS
    let projectDir: string;
    if (process.env.CODEATLAS_MULTI_TENANT === "true") {
      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      projectDir = path.join(tenantRoot, tenantId, cleanProjectName);
    } else {
      projectDir = path.join(process.cwd(), "projects", cleanProjectName);
    }
    
    const codeatlasDir = path.join(projectDir, ".codeatlas");
    if (!(await fileExists(codeatlasDir))) {
      await fs.promises.mkdir(codeatlasDir, { recursive: true });
    }
    
    const analysisPath = path.join(codeatlasDir, "analysis.json");
    await fs.promises.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
    
    // Securely sync telemetry / database stats on server-side
    try {
      const apps = firebaseClient.getApps();
      if (apps.length) {
        const db = firebaseClient.getFirestore();
        const docId = tenantId ? `${tenantId}_${cleanProjectName}` : cleanProjectName;
        const docRef = db.collection('projects').doc(docId);

        // Runtime migration fallback: if docId is different from cleanProjectName, check if a legacy doc exists to migrate historical telemetry
        if (tenantId) {
          const legacyDocId = cleanProjectName;
          const legacyRef = db.collection('projects').doc(legacyDocId);
          try {
            const [newDoc, legacyDoc] = await Promise.all([
              docRef.get(),
              legacyRef.get()
            ]);
            if (legacyDoc.exists && !newDoc.exists) {
              const legacyData = legacyDoc.data() || {};
              await docRef.set({
                ...legacyData,
                tenantId: tenantId
              }, { merge: true });
              await legacyRef.delete();
              console.error(`[Sync API] Successfully migrated legacy project doc '${legacyDocId}' to tenant-isolated '${docId}'`);
            }
          } catch (migrateErr) {
            console.error(`[Sync API] Runtime migration check failed: ${migrateErr}`);
          }
        }

        await docRef.set({
          name: cleanProjectName,
          path: projectDir,
          stats: (analysis as any).stats || analysis.entityCounts || {},
          lastIndexed: new Date().toISOString(),
          nodesCount: analysis.graph?.nodes?.length || 0,
          linksCount: analysis.graph?.links?.length || 0,
          status: 'synced',
          tenantId: tenantId
        }, { merge: true });
        console.error(`[Sync API] Securely synced ${cleanProjectName} telemetry to Firestore for tenant: ${tenantId}`);
      }
    } catch (e) {
      console.error(`[Sync API] Secure Firestore Sync Failed: ${e}`);
    }

    let businessRuleSaved = false;
    let changeDescriptionSaved = false;
    let syncError: string | undefined = undefined;

    // Sync to Oracle 26ai (episodic memory is processed synchronously to expose failures to callers)
    if (auth && process.env.ORACLE_CONN_STRING) {
      try {
        const { OracleMemoryService } = await import("../oracleDatabase.js");
        if (businessRule) {
          await authStorage.run(auth, async () => {
            console.error(`[Sync API] Saving business rule for ${cleanProjectName} to Oracle 26ai (length: ${businessRule.length})...`);
            await OracleMemoryService.saveEpisodicMemory(cleanProjectName, "BUSINESS_RULE", businessRule);
            businessRuleSaved = true;
          });
        }
        if (changeDescription) {
          await authStorage.run(auth, async () => {
            console.error(`[Sync API] Saving change log for ${cleanProjectName} to Oracle 26ai (length: ${changeDescription.length})...`);
            await OracleMemoryService.saveEpisodicMemory(cleanProjectName, "CHANGE_LOG", changeDescription);
            changeDescriptionSaved = true;
          });
        }

        // Graph sync is still processed asynchronously in the background as it can be large
        if (analysis.graph?.nodes && analysis.graph?.links) {
          const nodes = analysis.graph.nodes;
          const links = analysis.graph.links;
          Promise.resolve().then(async () => {
            try {
              await authStorage.run(auth, async () => {
                console.error(`[Sync API] Async syncing Knowledge Graph for ${cleanProjectName} to Oracle 26ai...`);
                await OracleMemoryService.saveSemanticMemory(cleanProjectName, nodes);
                await OracleMemoryService.saveRelationalMemory(cleanProjectName, links);
                console.error(`[Sync API] Async Knowledge Graph sync to Oracle 26ai completed successfully for ${cleanProjectName}!`);
              });
            } catch (oracleErr) {
              console.error(`[Sync API] Failed to async sync Knowledge Graph to Oracle 26ai:`, oracleErr);
            }
          });
        }
      } catch (e: any) {
        console.error(`[Sync API] Failed to initialize/sync Oracle DB connection: ${e}`);
        syncError = e instanceof Error ? e.message : String(e);
      }
    } else {
      if (businessRule || changeDescription) {
        syncError = "Oracle DB is not configured or authenticated.";
      }
    }

    if (syncError) {
      res.status(500).json({
        error: syncError,
        projectDir,
        stats: {
          businessRuleSaved,
          changeDescriptionSaved
        }
      });
    } else {
      res.json({
        success: true,
        projectDir,
        stats: {
          businessRuleSaved,
          changeDescriptionSaved
        }
      });
    }
  } catch (err: unknown) {
    console.error(`[Sync API] Secure sync failed: ${(err instanceof Error ? err.message : String(err))}`);
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// Serve static files from built dashboard
const dashboardDistPath = path.join(process.cwd(), "dashboard", "dist");
if (fs.existsSync(dashboardDistPath)) {
  app.use(express.static(dashboardDistPath));
  
  // SPA support: redirect all non-API routes to index.html
  app.get(/^\/(?!sse|messages|api).*/, (req, res) => {
    res.sendFile(path.join(dashboardDistPath, "index.html"));
  });
}

// Auth middleware for SSE endpoints
app.use("/sse", authMiddleware);
app.use("/messages", authMiddleware);

// Multi-session support for concurrent users/reconnections
const transports = new Map<string, SSEServerTransport>();
const sessionServers = new Map<string, McpServer>();
const sessionOwnership = new Map<string, string>();

app.get("/sse", async (req, res) => {
  console.error("[SSE] New connection request");
  
  // Critical for Cloudflare/Nginx/Proxies to prevent buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const apiKey = (req.query.apiKey as string) || (req.headers["x-api-key"] as string) || "";
  const messagesUrl = apiKey ? `/messages?apiKey=${encodeURIComponent(apiKey)}` : "/messages";
  const transport = new SSEServerTransport(messagesUrl, res);
  
  // Store transport by sessionId immediately to prevent race conditions during initialize
  const sessionId = (transport as any).sessionId;
  
  if (sessionId) {
    // If a session with this ID already exists, clean up its server and transport first to avoid conflicts
    if (transports.has(sessionId)) {
      console.error(`[SSE] Session ${sessionId} already exists. Cleaning up the old connection before establishing new one.`);
      const oldTransport = transports.get(sessionId);
      const oldServer = sessionServers.get(sessionId);
      transports.delete(sessionId);
      sessionServers.delete(sessionId);
      sessionOwnership.delete(sessionId);
      if (oldServer) {
        try {
          await oldServer.close();
        } catch (err) {
          // Ignore
        }
      }
      if (oldTransport) {
        try {
          await oldTransport.close();
        } catch (err) {
          // Ignore
        }
      }
    }

    // Dynamically create a session-specific server to isolate state and support concurrent clients
    const sessionServer = new McpServer(
      {
        name: "CodeAtlas",
        version: "2.11.14",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          logging: {},
        },
      }
    );
    registerTools(sessionServer);

    transports.set(sessionId, transport);
    sessionServers.set(sessionId, sessionServer);
    
    const auth = (req as any).auth;
    if (auth && auth.uid) {
      sessionOwnership.set(sessionId, auth.uid);
    }
    
    console.error(`[SSE] Session established: ${sessionId}`);

    // Send a heartbeat ping every 15 seconds to prevent proxy/load balancer timeouts
    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(":\n\n"); // SSE comment - keeps the HTTP connection active
      }
    }, 15000);

    // Cleanup on connection close with a 3-minute grace period
    res.on("close", async () => {
      clearInterval(heartbeatInterval);
      console.error(`[SSE] Session connection closed: ${sessionId}. Keeping session alive for 3-minute grace period.`);
      
      // Keep the session in the map for a 3-minute grace period to prevent immediate 404 errors
      setTimeout(async () => {
        if (transports.has(sessionId)) {
          console.error(`[SSE] Grace period expired. Cleaning up session: ${sessionId}`);
          transports.delete(sessionId);
          const oldServer = sessionServers.get(sessionId);
          sessionServers.delete(sessionId);
          sessionOwnership.delete(sessionId);
          if (oldServer) {
            try {
              await oldServer.close();
            } catch (err) {
              // Ignore
            }
          }
          try {
            await transport.close();
          } catch (err) {
            // Ignore
          }
        }
      }, 180000); // 3 minutes
    });

    await sessionServer.connect(transport);
  } else {
    console.error("[SSE] Critical: failed to retrieve sessionId from transport.");
    res.status(500).send("Failed to initialize session");
  }
});

app.post("/messages", async (req, res) => {
  let sessionId = req.query.sessionId as string;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (transport) {
    const auth = (req as any).auth;
    const ownerUid = sessionOwnership.get(sessionId);
    
    if (ownerUid && ownerUid !== auth?.uid) {
      console.error(`[SSE] Security: session ownership mismatch. Session ${sessionId} belongs to ${ownerUid}, but request is from ${auth?.uid || 'unauthenticated'}`);
      res.status(403).send("Forbidden: session ownership mismatch");
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  } else {
    console.error(`[SSE] Critical: session not found. Requested: "${sessionId || ''}". No active transports available.`);
    res.status(404).send("Session not found");
  }
});

// Secure endpoint to serve markdown documentation
app.get("/api/docs/quick-setup", (req, res) => {
  try {
    const docPath = path.join(process.cwd(), "docs", "QUICK_SETUP.md");
    if (!fs.existsSync(docPath)) {
      return res.status(404).send("Documentation guide not found.");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(docPath);
  } catch (e: unknown) {
    res.status(500).send((e instanceof Error ? e.message : String(e)));
  }
});

/**
 * Start the HTTP/SSE Express server on a specified port
 */
export function startHttpServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.error(`CodeAtlas MCP SSE server running on port ${port}`);
      console.error(`- SSE endpoint: http://localhost:${port}/sse`);
      console.error(`- Message endpoint: http://localhost:${port}/messages`);
      if (process.env.CODEATLAS_API_KEY) {
        console.error(`- Security: API Key enabled`);
      } else {
        console.error(`- Security: DISABLED (Set CODEATLAS_API_KEY to enable)`);
      }
      resolve();
    });
  });
}
