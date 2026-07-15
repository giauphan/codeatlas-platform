import express from "express";
import { checkAuth, logActivity } from "../services/authService.js";
import { OracleDreamingService } from "../services/dreamingService.js";
import { loadAnalysisAsync } from "../services/projectService.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

const VALID_MEMORY_TYPES = ["MISTAKE", "PREFERENCE", "KNOWLEDGE", "PATTERN"] as const;

/** Extract auth from request headers — API key or Firebase Bearer token. */
function extractAuth(req: express.Request) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const bearerMatch = (req.headers["authorization"] as string || "").match(/^Bearer (.+)$/);
  return { apiKey, bearerToken: bearerMatch?.[1] };
}

/** Resolve project name: if specified, try to load canonical name from analysis. */
async function resolveProjectName(project?: string): Promise<string> {
  if (!project) return "";
  try {
    const loaded = await loadAnalysisAsync(project);
    return loaded?.projectName ?? project;
  } catch (err: unknown) {
    logger.warn(`[Dreaming] Project lookup failed for "${project}", using as-is:`, err instanceof Error ? err.message : String(err));
    return project;
  }
}

/** Unified error handler for dreaming routes — auth errors get 401, everything else 500 + log. */
function handleError(res: express.Response, err: unknown, context: string) {
  const msg = err instanceof Error ? err.message : String(err);
  const isAuthFailure = msg.toLowerCase().includes("authentication") || msg.includes("API key");
  if (isAuthFailure) {
    res.status(401).json({ error: msg });
  } else {
    logger.error(`[Dreaming ${context}] Error:`, msg);
    res.status(500).json({ error: msg });
  }
}

export function registerDreamingRoutes(app: express.Application): void {

  app.delete("/api/dreams/delete", async (req, res) => {
    try {
      const { apiKey, bearerToken } = extractAuth(req);
      const auth = await checkAuth(apiKey, bearerToken);
      const id = req.query.id as string | undefined;
      if (!id?.trim()) return res.status(400).json({ error: "Missing or invalid id parameter" });

      await logActivity(auth, "delete_dream_memory", { id });
      const deleted = await authStorage.run(auth, () => OracleDreamingService.deleteDreamMemory(id));
      deleted
        ? res.json({ success: true, id, message: "Dream memory deleted" })
        : res.status(404).json({ error: "Dream memory not found", id });
    } catch (err) {
      handleError(res, err, "Delete");
    }
  });

  app.post("/api/dreams/save", async (req, res) => {
    try {
      const { apiKey, bearerToken } = extractAuth(req);
      const auth = await checkAuth(apiKey, bearerToken);
      const { memory_type, content, importance, session_id, project } = req.body as {
        memory_type: typeof VALID_MEMORY_TYPES[number];
        content: string;
        importance?: number;
        session_id?: string;
        project?: string;
      };

      if (!VALID_MEMORY_TYPES.includes(memory_type)) {
        return res.status(400).json({ error: `Invalid memory_type. Must be one of: ${VALID_MEMORY_TYPES.join(", ")}` });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Missing or invalid content (must be a non-empty string)" });
      }
      const importanceVal = typeof importance === "number" ? Math.min(9, Math.max(1, importance)) : 5;
      const projectName = await resolveProjectName(project || "global");

      await logActivity(auth, "save_dream_memory", { memory_type, content, importance: importanceVal, session_id, project: projectName });
      const memId = await authStorage.run(auth, () =>
        OracleDreamingService.saveDreamMemory(projectName, session_id || "unknown", memory_type, content, importanceVal)
      );
      res.json({ success: true, id: memId, memory_type });
    } catch (err) {
      handleError(res, err, "Save");
    }
  });

  // GET /api/dreams/query — read-only. Auth is optional (guest fallback).
  // Guest queries use 'admin' tenant to bypass VPD isolation, showing all dreams.
  // Without this override, dreams saved via different auth methods would be invisible
  // due to Oracle Row-Level Security filtering by tenant_id.
  app.get("/api/dreams/query", async (req, res) => {
    try {
      let auth;
      try {
        const { apiKey, bearerToken } = extractAuth(req);
        auth = await checkAuth(apiKey, bearerToken);
      } catch {
        auth = { tier: "guest", uid: "anonymous", keyId: "anonymous" };
      }
      const queryText = (req.query.query as string)?.trim() || "";
      const project = req.query.project as string | undefined;
      const limitRaw = req.query.limit as string | undefined;
      const offsetRaw = req.query.offset as string | undefined;

      const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: "limit must be a number between 1 and 100" });
      }
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: "offset must be a non-negative number" });
      }

      const projectName = await resolveProjectName(project);
      await logActivity(auth, "query_dream_memories", { query: queryText, project: projectName, limit });

      const rows = await authStorage.run(
        auth.tier === "guest" ? { ...auth, uid: "guest" } : auth,
        () => OracleDreamingService.queryDreamMemories(projectName, queryText, limit, offset)
      );

      const rawMemories = (rows ?? []) as unknown as Array<Record<string, unknown>>;
      const memories = rawMemories.map((r: Record<string, unknown>) => ({
        id: r.ID,
        session_id: r.SESSION_ID,
        project: r.PROJECT,
        memory_type: r.MEMORY_TYPE,
        content: r.CONTENT,
        importance: r.IMPORTANCE,
        created_at: r.CREATED_AT,
      }));

      res.json({ memories, count: memories.length });
    } catch (err) {
      handleError(res, err, "Query");
    }
  });
}
