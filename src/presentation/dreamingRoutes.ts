import express from "express";
import { checkAuth, logActivity } from "../services/authService.js";
import { OracleDreamingService } from "../services/dreamingService.js";
import { loadAnalysisAsync } from "../services/projectService.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

/**
 * REST API routes for Oracle Dreaming (dream memories).
 * Both endpoints accept `apiKey` as a query parameter for authentication,
 * enabling standalone usage from external clients.
 */
export function registerDreamingRoutes(app: express.Application): void {

  // ------------------------------------------------------------------
  // DELETE /api/dreams/delete
  // Query params: id, apiKey
  // ------------------------------------------------------------------
  app.delete("/api/dreams/delete", async (req, res) => {
    try {
      const apiKey = req.query.apiKey as string | undefined;
      const auth = await checkAuth(apiKey);

      const id = req.query.id as string | undefined;
      if (!id || typeof id !== "string" || !id.trim()) {
        return res.status(400).json({ error: "Missing or invalid id parameter" });
      }

      await logActivity(auth, "delete_dream_memory", { id });

      const deleted = await authStorage.run(auth, async () => {
        return await OracleDreamingService.deleteDreamMemory(id);
      });

      if (deleted) {
        res.json({ success: true, id, message: "Dream memory deleted" });
      } else {
        res.status(404).json({ error: "Dream memory not found", id });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Authentication") || msg.includes("API key")) {
        res.status(401).json({ error: msg });
      } else {
        logger.error("[Dreaming Delete] Error:", msg);
        res.status(500).json({ error: msg });
      }
    }
  });

  // ------------------------------------------------------------------
  // POST /api/dreams/save
  // Query params: apiKey
  // Body: { memory_type, content, importance?, session_id?, project? }
  // ------------------------------------------------------------------
  app.post("/api/dreams/save", async (req, res) => {
    try {
      const apiKey = req.query.apiKey as string | undefined;
      const auth = await checkAuth(apiKey);

      const { memory_type, content, importance, session_id, project } = req.body as {
        memory_type: 'MISTAKE' | 'PREFERENCE' | 'KNOWLEDGE' | 'PATTERN';
        content: string;
        importance?: number;
        session_id?: string;
        project?: string;
      };

      // Validate required fields
      if (!memory_type || !["MISTAKE", "PREFERENCE", "KNOWLEDGE", "PATTERN"].includes(memory_type)) {
        return res.status(400).json({
          error: "Invalid or missing memory_type. Must be one of: MISTAKE, PREFERENCE, KNOWLEDGE, PATTERN"
        });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Missing or invalid content (must be a non-empty string)" });
      }
      const importanceVal = typeof importance === "number" ? importance : 5;

      // Resolve project name
      let projectName = project || "global";
      if (project) {
        try {
          const loaded = await loadAnalysisAsync(project);
          if (loaded) projectName = loaded.projectName;
        } catch (err: unknown) {
          logger.warn("[Dreaming] Project lookup failed, using as-is:", err instanceof Error ? err.message : String(err));
        }
      }

      await logActivity(auth, "save_dream_memory", { memory_type, content, importance: importanceVal, session_id, project: projectName });

      const memId = await authStorage.run(auth, async () => {
        return await OracleDreamingService.saveDreamMemory(
          projectName,
          session_id || "unknown",
          memory_type,
          content,
          importanceVal
        );
      });

      res.json({ success: true, id: memId, memory_type });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Authentication") || msg.includes("API key")) {
        res.status(401).json({ error: msg });
      } else {
        logger.error("[Dreaming Save] Error:", msg);
        res.status(500).json({ error: msg });
      }
    }
  });

  // ------------------------------------------------------------------
  // GET /api/dreams/query
  // Query params: query, project?, limit?, apiKey
  // ------------------------------------------------------------------
  app.get("/api/dreams/query", async (req, res) => {
    try {
      const apiKey = req.query.apiKey as string | undefined;
      const auth = await checkAuth(apiKey);

      const queryText = req.query.query as string | undefined;
      const project = req.query.project as string | undefined;
      const limitRaw = req.query.limit as string | undefined;

      if (!queryText || typeof queryText !== "string" || !queryText.trim()) {
        return res.status(400).json({ error: "Missing or invalid query parameter" });
      }

      const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: "limit must be a number between 1 and 100" });
      }

      // Resolve project name
      let projectName = project || "global";
      if (project) {
        try {
          const loaded = await loadAnalysisAsync(project);
          if (loaded) projectName = loaded.projectName;
        } catch (err: unknown) {
          logger.warn("[Dreaming] Project lookup failed, using as-is:", err instanceof Error ? err.message : String(err));
        }
      }

      await logActivity(auth, "query_dream_memories", { query: queryText, project: projectName, limit });

      const rows = await authStorage.run(auth, async () => {
        return await OracleDreamingService.queryDreamMemories(projectName, queryText, limit);
      });

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Authentication") || msg.includes("API key")) {
        res.status(401).json({ error: msg });
      } else {
        logger.error("[Dreaming Query] Error:", msg);
        res.status(500).json({ error: msg });
      }
    }
  });
}
