import express from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import { IncomingMessage, Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as fs from "fs";
import * as path from "path";
import { getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { checkAuth, logActivity } from "../services/authService.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  discoverProjectsAsync,
  loadAnalysisAsync,
  getStats,
  fileExists,
  resolveProjectDir,
  unregisterProject
} from "../services/projectService.js";
import { authStorage } from "../utils/context.js";
import { registerTools } from "./mcpTools.js";
import { registerA2ATools } from "./a2a/a2aTools.js";
import { registerA2AOrchestrationTools } from "./a2aOrchestrationTools.js";
import { registerDreamingRoutes } from "./dreamingRoutes.js";
import { mountSecondBrainRoutes } from "./secondBrainRoutes.js";
import { mountConsolidationRoutes } from "./consolidationRoutes.js";
import { mountGenomeRoutes } from "./genomeRoutes.js";
import { mountA2ARoutes } from "./a2a/a2aRoutes.js";
import { mountHeartbeatRoutes } from "./a2a/heartbeatRoutes.js";
import { mountCronSettingsRoutes } from "./cronSettingsRoute.js";
import { authProxyRouter } from "../routes/authProxy.js";
import { a2aExecutor } from "./a2a/a2aExecutor.js";
import { a2aOrchestrationService } from "../services/a2aOrchestrationService.js";
import { indexingService } from "../services/indexingService.js";
import { logger } from "../utils/logger.js";
import * as crypto from "crypto";
import { matchesCron } from "../utils/cron.js";
import { loadSettings } from "./cronSettingsRoute.js";

// Wrapper object to allow clean mocking of Firebase services in testing environments
export const firebaseClient = {
  getApps: () => getApps(),
  getFirestore: () => getFirestore()
};

// Custom local rate limiter without external dependencies
const rateLimits = new Map<string, { timestamps: number[]; lastAccess: number }>();
const limitRequests = 60; // Max 60 requests
const limitWindowMs = 60000; // Per 1 minute
const RATE_LIMITER_TTL_MS = 5 * 60 * 1000; // Evict idle entries after 5 minutes

export const localRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : (req.ip || "anonymous");
  
  const now = Date.now();
  const entry = rateLimits.get(tenantId);
  let timestamps: number[];
  if (entry) {
    timestamps = entry.timestamps;
    entry.lastAccess = now;
  } else {
    timestamps = [];
    rateLimits.set(tenantId, { timestamps, lastAccess: now });
  }
  
  // Filter out timestamps outside the window
  const activeTimestamps = timestamps.filter(t => now - t < limitWindowMs);
  
  if (activeTimestamps.length >= limitRequests) {
    logger.warn(`[Rate Limiter] Limit exceeded for tenant/IP: ${tenantId}`);
    return res.status(429).json({ error: "Too many requests. Please try again in a minute." });
  }
  
  activeTimestamps.push(now);
  rateLimits.set(tenantId, { timestamps: activeTimestamps, lastAccess: now });
  
  // Periodic TTL-based eviction (run ~1% of requests)
  if (Math.random() < 0.01) {
    const cutoff = now - RATE_LIMITER_TTL_MS;
    for (const [key, val] of rateLimits) {
      if (val.lastAccess < cutoff) {
        rateLimits.delete(key);
      }
    }
  }

  next();
};

// Task queue to serialize/control concurrency of heavy operations
class TaskQueue {
  private queue: (() => Promise<any>)[] = [];
  private activeCount = 0;
  private maxConcurrency = 1; // Process at most 1 heavy sync task concurrently to prevent connection pool exhaustion
  private static readonly MAX_QUEUED = 10;
  private static readonly TASK_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(maxConcurrency: number = 1) {
    this.maxConcurrency = maxConcurrency;
  }

  /** Enqueue a task. Rejects immediately if queue is full. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= TaskQueue.MAX_QUEUED) {
      return Promise.reject(new Error("Sync queue full — try again later"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.next();
    });
  }

  private next() {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }
    
    const task = this.queue.shift();
    if (task) {
      this.activeCount++;
      // Safety timeout: if task hangs for 5 min, unblock the queue
      const timeoutId = setTimeout(() => {
        logger.error("[TaskQueue] Task timed out — unblocking queue");
        this.activeCount--;
        this.next();
      }, TaskQueue.TASK_TIMEOUT_MS);
      task().finally(() => {
        clearTimeout(timeoutId);
        this.activeCount--;
        this.next();
      });
    }
  }
}

export const syncQueue = new TaskQueue(1);


// Setup Express app to serve as both MCP SSE and REST API
export const app = express();
// Use helmet for standard security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin to match CORS logic below
}));
// Compression middleware for large JSON responses (gzip, brotli)
app.use(compression({
  level: 6, // Default: 6 (balanced speed/size)
  threshold: 1024, // Compress responses > 1KB
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Enable CORS for dashboard (restrict via ALLOWED_ORIGINS env var if needed)
const allowedOrigins = process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000';
const allowedList = allowedOrigins.split(',').map(s => s.trim());

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Explicitly reject null origin to prevent sandboxed iframe bypasses
    if (origin === 'null') {
      return callback(null, false);
    }

    if (allowedList.includes('*')) {
      return callback(null, '*');
    }

    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        return callback(null, false);
      }

      if (allowedList.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(null, false);
      }
    } catch (err) {
      return callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  credentials: true
}));

// Auth Proxy (Firebase sign-in without Web SDK)
app.use(authProxyRouter);

// REST API Dreaming (dream memories)
registerDreamingRoutes(app);

// REST API: Get all discovered projects
app.get("/api/projects", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    const projects = await discoverProjectsAsync(tenantId);
    res.json(projects.map(p => {
      // Sanitize absolute paths by making them relative to current working directory
      let relativeDir = path.relative(process.cwd(), p.dir);
      if (!relativeDir) relativeDir = ".";
      return { name: p.name, dir: relativeDir, modifiedAt: p.modifiedAt };
    }));
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});


/**
 * Cleans up an empty tenant project folder if it's within the tenant root sandbox.
 */
async function cleanUpEmptyTenantProjectFolder(
  realProjectDir: string,
  normalizedTenantRoot: string,
  fullProjectDir: string
): Promise<void> {
  if (process.env.CODEATLAS_MULTI_TENANT !== "true") return;
  if (realProjectDir === normalizedTenantRoot) return;
  if (!fs.existsSync(realProjectDir)) return;

  const lstat = await fs.promises.lstat(fullProjectDir);
  if (lstat.isSymbolicLink()) {
    await fs.promises.unlink(fullProjectDir);
    logger.info(`[Delete Project] Unlinked tenant project symlink: ${fullProjectDir}`);
    return;
  }

  const remainingFiles = await fs.promises.readdir(realProjectDir);
  if (remainingFiles.length === 0) {
    await fs.promises.rm(realProjectDir, { recursive: true, force: true });
    logger.info(`[Delete Project] Cleaned up empty tenant sandbox directory: ${realProjectDir}`);
  }
}

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
        ? (auth.uid === "admin" || auth.role === "admin")
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
        logger.info(`[Delete Project] Deleted Firestore document: ${docId}`);
        
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
              logger.info(`[Delete Project] Cleaned up legacy Firestore document: ${legacyDocId}`);
            }
          }
        }
      }
    } catch (firebaseErr: unknown) {
      logger.error(`[Delete Project] Failed to delete from Firestore: ${firebaseErr}`);
      errors.push(`Firestore cleanup failed: ${firebaseErr instanceof Error ? firebaseErr.message : String(firebaseErr)}`);
    }

    // 2. Remove semantic/relational/episodic memory from Oracle DB (if Oracle DB is configured)
    try {
      if (process.env.ORACLE_CONN_STRING) {
        const { OracleMemoryService } = await import("../services/memoryService.js");
        await OracleMemoryService.deleteProjectMemory(cleanProjectName);
      }
    } catch (oracleErr: unknown) {
      logger.error(`[Delete Project] Failed to delete from Oracle DB: ${oracleErr}`);
      const errMsg = oracleErr instanceof Error ? oracleErr.message : String(oracleErr);
      // If it's a driver/library loading error (e.g. DPI-1047) or connection/network failure,
      // log as a warning and do not block local cleanup, since the DB is unreachable anyway.
      if (
        errMsg.includes("DPI-1047") ||
        errMsg.includes("NJS-511") ||
        errMsg.includes("NJS-040") ||
        errMsg.includes("connection") ||
        errMsg.includes("connect")
      ) {
        logger.warn(`[Delete Project] Non-blocking Oracle library/connection warning during delete: ${errMsg}`);
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
        logger.info(`[Delete Project] Cleaned up directory: ${codeatlasDir}`);
      }

      // If multi-tenant mode is active, the project resides within the tenants directory, and the directory is empty after index cleanup, clean up the empty tenant project folder too
      if (isInsideTenantRoot) {
        await cleanUpEmptyTenantProjectFolder(realProjectDir, normalizedTenantRoot, fullProjectDir);
      }
    } catch (dirErr: unknown) {
      errors.push(`Failed to clean up index directory: ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`);
    }

    // 4. Unregister project from local registered list only if local cleanup was successful, or if force is enabled
    if (errors.length === 0 || isForce) {
      try {
        unregisterProject(fullProjectDir);
      } catch (regErr: unknown) {
        errors.push(`Failed to unregister project: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
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
    logger.error(`[Delete Project] Failed: ${(err instanceof Error ? err.message : String(err))}`);
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Get episodic memory (business rules / change logs) for a project
app.get("/api/projects/memory", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    if (!auth) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const tenantId = auth.uid;

    const { projectName, eventType } = req.query;
    if (!projectName || typeof projectName !== "string" || !projectName.trim()) {
      return res.status(400).json({ error: "Missing or invalid projectName query parameter" });
    }

    if (eventType !== undefined && eventType !== "BUSINESS_RULE" && eventType !== "CHANGE_LOG") {
      return res.status(400).json({ error: "Invalid eventType parameter. Must be BUSINESS_RULE or CHANGE_LOG" });
    }

    const cleanProjectName = path.basename(projectName.trim());

    if (!process.env.ORACLE_CONN_STRING) {
      return res.json({
        success: true,
        projectName: cleanProjectName,
        memories: [],
        message: "Oracle DB connection string is not configured."
      });
    }

    const { OracleMemoryService } = await import("../services/memoryService.js");
    const memories = await authStorage.run(auth, async () => {
      return await OracleMemoryService.getEpisodicMemories(cleanProjectName, eventType || undefined);
    });

    const rawMemories = (memories ?? []) as Array<Record<string, unknown>>;
    const parsedMemories = OracleMemoryService.parseEpisodicMemories(rawMemories);

    res.json({
      success: true,
      projectName: cleanProjectName,
      memories: parsedMemories
    });
  } catch (err: unknown) {
    logger.error(`[Get Project Memory] Failed: ${(err instanceof Error ? err.message : String(err))}`);
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Get indexing settings for a project
app.get("/api/projects/settings", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    
    const projectDir = req.query.projectDir;
    const projectName = req.query.projectName;
    
    if (projectDir !== undefined && (typeof projectDir !== "string" || !projectDir.trim())) {
      return res.status(400).json({ error: "Invalid projectDir parameter" });
    }
    if (projectName !== undefined && (typeof projectName !== "string" || !projectName.trim())) {
      return res.status(400).json({ error: "Invalid projectName parameter" });
    }
    
    if (!projectDir && !projectName) {
      return res.status(400).json({ error: "Missing projectDir or projectName query parameter" });
    }
    
    let resolved;
    if (projectDir) {
      resolved = await resolveProjectDir(projectDir.trim(), tenantId, true);
    } else if (projectName) {
      resolved = await resolveProjectDir(projectName.trim(), tenantId, false);
    }
    
    if (!resolved) {
      return res.status(404).json({ error: "Project not found" });
    }
    
    const { cleanProjectName, fullProjectDir } = resolved;
    let indexingEnabled = true;
    let checkedLocal = false;
    
    try {
      const settingsPath = path.join(fullProjectDir, ".codeatlas", "settings.json");
      if (fs.existsSync(settingsPath)) {
        const data = await fs.promises.readFile(settingsPath, "utf-8");
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed.indexingEnabled === "boolean") {
            indexingEnabled = parsed.indexingEnabled;
            checkedLocal = true;
          } else {
            logger.warn("[Settings API] Invalid settings file format: indexingEnabled is not a boolean");
          }
        } catch (parseErr) {
          logger.error("[Settings API] Corrupted settings file:", parseErr);
        }
      }
    } catch (e: unknown) {
      logger.error("[Settings API] Error reading settings file:", e);
      if (e instanceof Error && (e as NodeJS.ErrnoException).code !== "ENOENT") {
        return res.status(500).json({ error: `Failed to read local settings: ${e.message}` });
      }
    }
    
    if (!checkedLocal) {
      // Fallback: check Firestore
      try {
        const apps = firebaseClient.getApps();
        if (apps.length) {
          const db = firebaseClient.getFirestore();
          const docId = tenantId ? `${tenantId}_${cleanProjectName}` : cleanProjectName;
          const docRef = db.collection('projects').doc(docId);
          const doc = await docRef.get();
          if (doc.exists && typeof doc.data()?.indexingEnabled === "boolean") {
            indexingEnabled = doc.data()?.indexingEnabled;
          }
        }
      } catch (e: unknown) {
        logger.error("[Settings API] Error reading Firestore fallback:", e);
        return res.status(500).json({ error: `Failed to fetch settings: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    
    res.json({ indexingEnabled });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Update indexing settings for a project
app.post("/api/projects/settings", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    
    const { projectDir, projectName, indexingEnabled } = req.body;
    if (typeof indexingEnabled !== "boolean") {
      return res.status(400).json({ error: "Missing or invalid indexingEnabled parameter (must be boolean)" });
    }
    
    if (projectDir !== undefined && (typeof projectDir !== "string" || !projectDir.trim())) {
      return res.status(400).json({ error: "Invalid projectDir parameter" });
    }
    if (projectName !== undefined && (typeof projectName !== "string" || !projectName.trim())) {
      return res.status(400).json({ error: "Invalid projectName parameter" });
    }
    
    if (!projectDir && !projectName) {
      return res.status(400).json({ error: "Missing projectDir or projectName parameter" });
    }
    
    let resolved;
    if (projectDir) {
      resolved = await resolveProjectDir(projectDir.trim(), tenantId, true);
    } else if (projectName) {
      resolved = await resolveProjectDir(projectName.trim(), tenantId, false);
    }
    
    if (!resolved) {
      return res.status(404).json({ error: "Project not found" });
    }
    
    const { cleanProjectName, fullProjectDir } = resolved;
    
    // Ensure .codeatlas directory exists
    const codeatlasDir = path.join(fullProjectDir, ".codeatlas");
    if (!fs.existsSync(codeatlasDir)) {
      await fs.promises.mkdir(codeatlasDir, { recursive: true });
    }
    
    const settingsPath = path.join(codeatlasDir, "settings.json");
    // Defense-in-depth: Ensure settingsPath is a child of fullProjectDir
    const relativeSettingsPath = path.relative(fullProjectDir, settingsPath);
    if (relativeSettingsPath.startsWith('..') || path.isAbsolute(relativeSettingsPath)) {
      logger.error(`[Settings API] Path traversal attempt detected: ${settingsPath}`);
      return res.status(400).json({ error: "Invalid settings path." });
    }
    await fs.promises.writeFile(settingsPath, JSON.stringify({ indexingEnabled }, null, 2));
    
    // Save to Firestore
    try {
      const apps = firebaseClient.getApps();
      if (apps.length) {
        const db = firebaseClient.getFirestore();
        const docId = tenantId ? `${tenantId}_${cleanProjectName}` : cleanProjectName;
        const docRef = db.collection('projects').doc(docId);
        await docRef.set({ indexingEnabled }, { merge: true });
      }
    } catch (e: unknown) {
      logger.error("[Settings API] Error updating Firestore settings:", e);
      throw new Error(`Firestore update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    res.json({ success: true, indexingEnabled });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// ── Health endpoint — quick liveness check, no auth required ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Version endpoint — returns current deployed version for cache busting ──
app.get("/api/version", async (_req, res) => {
  let version = "unknown";
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version || "unknown";
  } catch {}
  res.json({ version, buildTime: Date.now() });
});

// REST API: Manage API Keys (backend-proxied)
app.get("/api/keys", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const db = firebaseClient.getFirestore();
    const keysSnapshot = await db.collection('users').doc(auth.uid).collection('keys').get();
    const keys = keysSnapshot.docs.map(doc => {
      const data = doc.data();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { keyHash, ...safeData } = data; // Omit keyHash
      return { id: doc.id, ...safeData };
    });
    res.json(keys);
  } catch (err: unknown) {
    logger.error("[API Keys] Failed to fetch keys:", err);
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

app.post("/api/keys", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const newKey = `ca_${crypto.randomBytes(16).toString('hex')}`;
    const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex');

    const db = firebaseClient.getFirestore();
    const keyRef = db.collection('users').doc(auth.uid).collection('keys').doc();
    await keyRef.set({
      keyHash: newKeyHash,
      createdAt: FieldValue.serverTimestamp(),
      tier: auth.tier,
      uid: auth.uid,
      name: `API Key ${new Date().toISOString()}`,
    });

    res.json({ success: true, key: newKey, id: keyRef.id });
  } catch (err: unknown) {
    logger.error("[API Keys] Failed to create key:", err);
    res.status(500).json({ error: "Failed to create API key" });
  }
});

app.delete("/api/keys/:id", authMiddleware, async (req, res) => {
  try {
    const auth = authStorage.getStore();
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const keyId = req.params.id;
    if (!keyId || typeof keyId !== 'string' || keyId.trim() === '') {
        return res.status(400).json({ error: "Invalid API Key ID" });
    }

    const db = firebaseClient.getFirestore();
    const keyRef = db.collection('users').doc(auth.uid).collection('keys').doc(keyId);
    await keyRef.delete();

    res.json({ success: true, id: keyId });
  } catch (err: unknown) {
    logger.error("[API Keys] Failed to delete key:", err);
    res.status(500).json({ error: "Failed to delete API key" });
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
      res.json({
        ...loaded,
        projectDir: path.relative(process.cwd(), loaded.projectDir)
      });
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

// REST API: List A2A orchestration tasks (tenant-scoped)
app.get("/api/orchestration/tasks", authMiddleware, async (req, res) => {
  try {
    const tasks = await a2aOrchestrationService.listTasks();
    res.json({ success: true, tasks });
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// REST API: Securely sync local AST analysis from Local-First gateway and sync telemetry
app.post("/api/projects/sync", authMiddleware, localRateLimiter, async (req, res) => {
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

    // Queue the heavy file write & database sync operations to prevent connection pool starvation/conflicts
    const result = await syncQueue.enqueue(async () => {
      const executeTask = async () => {
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
                  logger.info(`[Sync API] Successfully migrated legacy project doc '${legacyDocId}' to tenant-isolated '${docId}'`);
                }
              } catch (migrateErr) {
                logger.error(`[Sync API] Runtime migration check failed: ${migrateErr}`);
              }
            }

            await docRef.set({
              name: cleanProjectName,
              path: projectDir,
              stats: (analysis as { stats?: unknown; entityCounts?: unknown }).stats || analysis.entityCounts || {},
              lastIndexed: new Date().toISOString(),
              nodesCount: analysis.graph?.nodes?.length || 0,
              linksCount: analysis.graph?.links?.length || 0,
              status: 'synced',
              tenantId: tenantId
            }, { merge: true });
            logger.info(`[Sync API] Securely synced ${cleanProjectName} telemetry to Firestore for tenant: ${tenantId}`);
          }
        } catch (e) {
          logger.error(`[Sync API] Secure Firestore Sync Failed: ${e}`);
        }

        let businessRuleSaved = false;
        let changeDescriptionSaved = false;
        let syncError: string | undefined = undefined;

        // Sync to Oracle 26ai (episodic memory is processed synchronously to expose failures to callers)
        if (auth && process.env.ORACLE_CONN_STRING) {
          try {
            const { OracleMemoryService } = await import("../services/memoryService.js");
            if (businessRule) {
              await authStorage.run(auth, async () => {
                logger.info(`[Sync API] Saving business rule for ${cleanProjectName} to Oracle 26ai (length: ${businessRule.length})...`);
                await OracleMemoryService.saveEpisodicMemory(cleanProjectName, "BUSINESS_RULE", { text: businessRule });
                businessRuleSaved = true;
              });
            }
            if (changeDescription) {
              await authStorage.run(auth, async () => {
                logger.info(`[Sync API] Saving change log for ${cleanProjectName} to Oracle 26ai (length: ${changeDescription.length})...`);
                await OracleMemoryService.saveEpisodicMemory(cleanProjectName, "CHANGE_LOG", { text: changeDescription });
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
                    logger.info(`[Sync API] Async syncing Knowledge Graph for ${cleanProjectName} to Oracle 26ai...`);
                    await OracleMemoryService.saveSemanticMemory(cleanProjectName, nodes);
                    await OracleMemoryService.saveRelationalMemory(cleanProjectName, links);
                    logger.info(`[Sync API] Async Knowledge Graph sync to Oracle 26ai completed successfully for ${cleanProjectName}!`);
                  });
                } catch (oracleErr) {
                  logger.error(`[Sync API] Failed to async sync Knowledge Graph to Oracle 26ai:`, oracleErr);
                }
              });
            }
          } catch (e: unknown) {
            logger.error(`[Sync API] Failed to initialize/sync Oracle DB connection: ${e}`);
            syncError = e instanceof Error ? e.message : String(e);
          }
        } else {
          if (businessRule || changeDescription) {
            syncError = "Oracle DB is not configured or authenticated.";
          }
        }

        const sanitizedProjectDir = path.relative(process.cwd(), projectDir);
        return { sanitizedProjectDir, businessRuleSaved, changeDescriptionSaved, syncError };
      };

      if (auth) {
        return await authStorage.run(auth, executeTask);
      } else {
        return await executeTask();
      }
    });

    if (result.syncError) {
      res.status(500).json({
        error: result.syncError,
        projectDir: result.sanitizedProjectDir,
        stats: {
          businessRuleSaved: result.businessRuleSaved,
          changeDescriptionSaved: result.changeDescriptionSaved
        }
      });
    } else {
      res.json({
        success: true,
        projectDir: result.sanitizedProjectDir,
        stats: {
          businessRuleSaved: result.businessRuleSaved,
          changeDescriptionSaved: result.changeDescriptionSaved
        }
      });
    }
  } catch (err: unknown) {
    logger.error(`[Sync API] Secure sync failed: ${(err instanceof Error ? err.message : String(err))}`);
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

// Serve static files from built dashboard
const dashboardDistPath = path.join(process.cwd(), "dashboard", "dist");
if (fs.existsSync(dashboardDistPath)) {
  // index.html must NEVER be cached — always serve fresh so browser picks up new hashed assets
  app.use(express.static(dashboardDistPath, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: (res: express.Response, filePath: string) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
        res.setHeader("X-Accel-Expires", "0");
      }
    }
  }));
  
  // Catch-all: serve index.html for all non-API, non-SSE, non-well-known routes (SPA routing)
  app.get(/^\/(?!sse|messages|api|\.well-known|a2a).*/, (req, res) => {
    res.sendFile(path.join(dashboardDistPath, "index.html"), {
      cacheControl: false,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      }
    });
  });
}

// Auth middleware for SSE endpoints
app.use("/sse", authMiddleware);
app.use("/messages", authMiddleware);


// Multi-session support for concurrent users/reconnections
const transports = new Map<string, SSEServerTransport>();
const sessionServers = new Map<string, McpServer>();
const sessionOwnership = new Map<string, string>();
const sessionGenerations = new Map<string, number>();

app.get("/sse", async (req, res) => {
  logger.info("[SSE] New connection request");
  
  // Critical for Cloudflare/Nginx/Proxies to prevent buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const apiKey = (req.headers["x-api-key"] as string) || "";
  const messagesUrl = "/messages";
  const transport = new SSEServerTransport(messagesUrl, res);
  
  // Store transport by sessionId immediately to prevent race conditions during initialize
  const sessionId = transport.sessionId;
  
  if (sessionId) {
    // If a session with this ID already exists, clean up its server and transport first to avoid conflicts
    if (transports.has(sessionId)) {
      logger.warn(`[SSE] Session ${sessionId} already exists. Cleaning up the old connection before establishing new one.`);
      const oldTransport = transports.get(sessionId);
      const oldServer = sessionServers.get(sessionId);
      transports.delete(sessionId);
      sessionServers.delete(sessionId);
      sessionOwnership.delete(sessionId);
      sessionGenerations.delete(sessionId);
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
    const auth = req.auth;
    const sessionServer = new McpServer(
      {
        name: "CodeAtlas",
        version: "2.14.4",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          logging: {},
        },
      }
    );
    registerTools(sessionServer, auth);
    registerA2ATools(sessionServer, auth);
    registerA2AOrchestrationTools(sessionServer);

    const currentGen = (sessionGenerations.get(sessionId) || 0) + 1;
    sessionGenerations.set(sessionId, currentGen);

    transports.set(sessionId, transport);
    sessionServers.set(sessionId, sessionServer);
    
    if (auth && auth.uid) {
      sessionOwnership.set(sessionId, auth.uid);
    }
    
    logger.info(`[SSE] Session established: ${sessionId} (generation: ${currentGen})`);

    // Send a heartbeat ping every 15 seconds to prevent proxy/load balancer timeouts
    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(":\n\n"); // SSE comment - keeps the HTTP connection active
      }
    }, 15000);

    const myGen = currentGen;
    // Cleanup on connection close with a 3-minute grace period
    res.on("close", async () => {
      clearInterval(heartbeatInterval);
      logger.info(`[SSE] Session connection closed: ${sessionId} (generation: ${myGen}). Keeping session alive for 3-minute grace period.`);
      
      // Keep the session in the map for a 3-minute grace period to prevent immediate 404 errors
      setTimeout(async () => {
        // Only clean up if the current generation of this session matches the one that closed
        if (sessionGenerations.get(sessionId) === myGen) {
          logger.info(`[SSE] Grace period expired. Cleaning up session: ${sessionId} (generation: ${myGen})`);
          transports.delete(sessionId);
          const oldServer = sessionServers.get(sessionId);
          sessionServers.delete(sessionId);
          sessionOwnership.delete(sessionId);
          sessionGenerations.delete(sessionId);
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
        } else {
          logger.info(`[SSE] Skip cleanup for session: ${sessionId} (current generation: ${sessionGenerations.get(sessionId) || 'none'} newer than closed generation: ${myGen})`);
        }
      }, 180000); // 3 minutes
    });

    await sessionServer.connect(transport);
  } else {
    logger.error("[SSE] Critical: failed to retrieve sessionId from transport.");
    res.status(500).send("Failed to initialize session");
  }
});

app.post("/messages", async (req, res) => {
  let sessionId = req.query.sessionId as string;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (transport) {
    const auth = req.auth;
    const ownerUid = sessionOwnership.get(sessionId);
    
    if (ownerUid && ownerUid !== auth?.uid) {
      logger.error(`[SSE] Security: session ownership mismatch. Session ${sessionId} belongs to ${ownerUid}, but request is from ${auth?.uid || 'unauthenticated'}`);
      res.status(403).send("Forbidden: session ownership mismatch");
      return;
    }

    await transport.handlePostMessage(req as unknown as IncomingMessage, res, req.body);
  } else {
    logger.error(`[SSE] Critical: session not found. Requested: "${sessionId || ''}". No active transports available.`);
    res.status(404).send("Session not found");
  }
});

// Secure endpoint to serve markdown documentation
app.get("/api/docs/quick-setup", authMiddleware, (req, res) => {
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

app.get("/api/docs/memory-setup", authMiddleware, (req, res) => {
  try {
    const docPath = path.join(process.cwd(), "docs", "AI-MEMORY-SETUP.md");
    if (!fs.existsSync(docPath)) {
      return res.status(404).send("AI Memory Setup documentation not found.");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(docPath);
  } catch (e: unknown) {
    res.status(500).send((e instanceof Error ? e.message : String(e)));
  }
});

/**
 * Start the HTTP/SSE Express server on a specified port with retry on EADDRINUSE
 */
export function startHttpServer(port: number, retries = 5): Promise<void> {
  registerDreamingRoutes(app);
  mountSecondBrainRoutes(app);
  mountConsolidationRoutes(app);
  mountGenomeRoutes(app);
  mountA2ARoutes(app, a2aExecutor, `http://localhost:${port}`);
  mountHeartbeatRoutes(app);
  mountCronSettingsRoutes(app);

  // Start a keep-alive database ping every 12 hours to prevent Oracle Free Tier auto-stop
  // Jitter ±15 minutes to prevent thundering herd if multiple instances restart simultaneously
  const DB_PING_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const JITTER_MS = 15 * 60 * 1000;
  const scheduleNextPing = () => {
    const jitter = Math.floor(Math.random() * JITTER_MS * 2 - JITTER_MS);
    setTimeout(async () => {
      try {
        const { ping } = await import("../database/connection.js");
        if (process.env.ORACLE_CONN_STRING) {
          logger.info("[Keep-Alive] Pinging Oracle DB to prevent idle auto-stop...");
          await ping();
        }
      } catch (err) {
        logger.error("[Keep-Alive] Failed to ping Oracle DB:", err);
      }
      scheduleNextPing();
    }, DB_PING_INTERVAL_MS + jitter);
  };
  const initialDelay = Math.floor(Math.random() * JITTER_MS * 2);
  setTimeout(scheduleNextPing, initialDelay);

  // --- Daily Dream Generation Scheduler ---
  let lastDreamRunDate: string | null = null;
  const CRON_CHECK_INTERVAL_MS = 60 * 1000;

  setInterval(async () => {
    const now = new Date();
    const settings = await loadSettings();

    if (settings.dreams_enabled && matchesCron(settings.dreams_schedule, now)) {
      const today = now.toISOString().split('T')[0];
      if (lastDreamRunDate === today) {
        return;
      }

      logger.info(`[DreamCron] Triggering daily dream generation for provider: ${settings.dreams_provider || 'all'}`);
      try {
        const internalApiKey = process.env.CODEATLAS_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (internalApiKey) {
          headers['x-api-key'] = internalApiKey;
        }
        const response = await fetch(`http://localhost:${port}/api/dreams/generate-daily-dreams`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ provider: settings.dreams_provider }),
        });

        if (response.ok) {
          logger.info(`[DreamCron] Daily dream generation successful for ${today}.`);
          lastDreamRunDate = today;
        } else {
          const errorText = await response.text();
          logger.error(`[DreamCron] Daily dream generation failed: ${response.status} - ${errorText}`);
        }
      } catch (err) {
        logger.error("[DreamCron] Error during daily dream generation:", err);
      }
    }
  }, CRON_CHECK_INTERVAL_MS);

  return new Promise((resolve, reject) => {
    function attempt(remaining: number) {
      const serverInstance = app.listen(port)
        .on('listening', () => {
          logger.info(`CodeAtlas MCP SSE server running on port ${port}`);
          logger.info(`- SSE endpoint: http://localhost:${port}/sse`);
          logger.info(`- Message endpoint: http://localhost:${port}/messages`);
          logger.info(`- A2A Agent Card: http://localhost:${port}/.well-known/agent-card.json`);
          logger.info(`- A2A JSON-RPC: http://localhost:${port}/a2a/jsonrpc`);
          if (process.env.CODEATLAS_API_KEY) {
            logger.info(`- Security: API Key enabled`);
          } else {
            logger.info(`- Security: DISABLED (Set CODEATLAS_API_KEY to enable)`);
          }

          // Define shutdown handler
          const shutdown = (signal: string, server: Server) => {
            logger.info(`${signal} received: Closing HTTP server...`);
            server.close(() => {
              logger.info('HTTP server closed');
              process.exit(0);
            });
          };

          // Register handlers once
          process.once('SIGINT', () => shutdown('SIGINT', serverInstance));
          process.once('SIGTERM', () => shutdown('SIGTERM', serverInstance));
          process.once('SIGUSR2', () => { // For nodemon restarts
            logger.info('SIGUSR2 received: Closing HTTP server for reload...');
            serverInstance.close(() => {
              process.kill(process.pid, 'SIGUSR2');
            });
          });

          resolve();
        })
        .on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && remaining > 0) {
            logger.warn(`Port ${port} in use, retrying in 1s... (${remaining} left)`);
            setTimeout(() => attempt(remaining - 1), 1000);
          } else {
            reject(err);
          }
        });
    }
    attempt(retries);
  });
}
