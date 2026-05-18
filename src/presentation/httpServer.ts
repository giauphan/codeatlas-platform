import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as fs from "fs";
import * as path from "path";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { checkAuth, logActivity } from "../services/authService.js";
import { 
  discoverProjectsAsync, 
  loadAnalysisAsync, 
  getStats, 
  fileExists 
} from "../services/projectService.js";
import { authStorage } from "../context.js";
import { registerTools } from "./mcpServer.js";
import { CodeAnalyzer } from "../analyzer/parser.js";

// Setup Express app to serve as both MCP SSE and REST API
export const app = express();
app.use(express.json());

// Enable CORS for dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
          const userDoc = await getFirestore().collection("users").doc(decodedToken.uid).get();
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
      
      // Gán auth context cho toàn bộ luồng bất đồng bộ bên dưới
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
    
    // Gán auth context cho toàn bộ luồng bất đồng bộ bên dưới
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
  try {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : undefined;
    const bodyProjectDir = req.body.projectDir as string | undefined;

    let projectPath = bodyProjectDir || process.env.CODEATLAS_PROJECT_DIR || process.cwd();

    // In multi-tenant mode, strictly validate that they own/can access this project directory!
    if (process.env.CODEATLAS_MULTI_TENANT === "true" && tenantId && tenantId !== "admin") {
      const userProjects = await discoverProjectsAsync(tenantId);
      const match = userProjects.find(p => p.dir === projectPath);
      if (!match) {
        return res.status(403).json({ error: "Access denied: You do not own or have access to this project directory" });
      }
      projectPath = match.dir;
    }

    console.error(`[API] Triggering re-index for: ${projectPath}`);
    
    const analyzer = new CodeAnalyzer(projectPath, 5000);
    const result = await analyzer.analyzeProject();
    
    const codeatlasDir = path.join(projectPath, ".codeatlas");
    if (!(await fileExists(codeatlasDir))) {
      await fs.promises.mkdir(codeatlasDir, { recursive: true });
    }
    
    await fs.promises.writeFile(path.join(codeatlasDir, "analysis.json"), JSON.stringify(result, null, 2));
    
    res.json({ success: true, stats: getStats(result as any) });
  } catch (err: unknown) {
    console.error(`[API] Re-index failed: ${(err instanceof Error ? err.message : String(err))}`);
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
        version: "2.9.3",
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
