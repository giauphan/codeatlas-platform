import express from "express";
import { checkAuth, logActivity } from "../services/authService.js";
import { OracleDreamingService, DreamMemoryType } from "../services/dreamingService.js";
import { loadAnalysisAsync } from "../services/projectService.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "../middleware/auth.js";
import { summarizeConversationForDreams } from "../services/llmService.js";

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
      const { memory_type, content, importance, session_id, project, provider } = req.body as {
        memory_type: typeof VALID_MEMORY_TYPES[number];
        content: string;
        importance?: number;
        session_id?: string;
        project?: string;
        provider?: string;
      };

      if (!VALID_MEMORY_TYPES.includes(memory_type)) {
        return res.status(400).json({ error: `Invalid memory_type. Must be one of: ${VALID_MEMORY_TYPES.join(", ")}` });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Missing or invalid content (must be a non-empty string)" });
      }
      const importanceVal = typeof importance === "number" ? Math.min(9, Math.max(1, importance)) : 5;
      const projectName = await resolveProjectName(project || "global");

      await logActivity(auth, "save_dream_memory", { memory_type, content, importance: importanceVal, session_id, project: projectName, provider });
      const memId = await authStorage.run(auth, () =>
        OracleDreamingService.saveDreamMemory(projectName, session_id || "unknown", memory_type, content, importanceVal, provider)
      );
      res.json({ success: true, id: memId, memory_type });
    } catch (err) {
      handleError(res, err, "Save");
    }
  });

  // GET /api/dreams/query — authenticated, tenant-isolated
  app.get("/api/dreams/query", authMiddleware, async (req, res) => {
    try {
      const auth = authStorage.getStore()!;
      const queryText = (req.query.query as string)?.trim() || "";
      const project = req.query.project as string | undefined;
      const limitRaw = req.query.limit as string | undefined;
      const offsetRaw = req.query.offset as string | undefined;
      const memoryType = req.query.memory_type as string | undefined;
      const provider = req.query.provider as string | undefined;
      const startDateRaw = req.query.start_date as string | undefined;
      const endDateRaw = req.query.end_date as string | undefined;

      // Parse and validate date filters — accept ISO 8601 or YYYY-MM-DD
      const parseDate = (d?: string): Date | undefined => {
        if (!d) return undefined;
        const parsed = new Date(d);
        if (isNaN(parsed.getTime())) return undefined;
        return parsed;
      };
      const startDate = parseDate(startDateRaw);
      const endDate = parseDate(endDateRaw);

      const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: "limit must be a number between 1 and 100" });
      }
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: "offset must be a non-negative number" });
      }

      const projectName = await resolveProjectName(project);
      await logActivity(auth, "query_dream_memories", { query: queryText, project: projectName, limit, provider });

      const rows = await authStorage.run(
        auth,
        () => OracleDreamingService.queryDreamMemories(projectName, queryText, limit, offset, memoryType, provider, startDate ?? undefined, endDate ?? undefined)
      );

      const rawMemories = (rows ?? []) as unknown as Array<Record<string, unknown>>;
      const memories = rawMemories.map((r: Record<string, unknown>) => ({
        id: r.ID,
        session_id: r.SESSION_ID,
        project: r.PROJECT,
        provider: r.PROVIDER,
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

  // POST /api/dreams/ingest-session — process conversation transcript, extract dreams, save
  app.post("/api/dreams/ingest-session", authMiddleware, async (req, res) => {
    try {
      const auth = authStorage.getStore()!;
      const { content, session_id, project, provider } = req.body as {
        content: string;
        session_id?: string;
        project?: string;
        provider?: string;
      };

      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Missing or invalid content (must be a non-empty string)" });
      }
      const sessId = session_id || `session_${Date.now()}`;
      const projectName = await resolveProjectName(project || "global");
      const prov = provider || "generic";

      await logActivity(auth, "ingest_session", { session_id: sessId, project: projectName, provider: prov });

      const dreams = await summarizeConversationForDreams(content, prov, projectName, sessId);
      if (!dreams || dreams.length === 0) {
        // No dreams extracted, but still success (no learnings to save)
        return res.json({ success: true, session_id: sessId, project: projectName, provider: prov, dreamsExtracted: 0 });
      }

      // Save each extracted dream — skip noise-blocked entries
      const savedDreams: Array<{ id: string; memory_type: string; content: string }> = [];
      const skipped: string[] = [];
      for (const dream of dreams) {
        const memId = await authStorage.run(auth, () =>
          OracleDreamingService.saveDreamMemory(
            projectName, sessId, dream.memoryType as DreamMemoryType, dream.content, dream.importance, prov
          )
        );
        if (memId === '__noise_blocked__') {
          skipped.push(dream.content.slice(0, 60));
        } else {
          savedDreams.push({ id: memId, memory_type: dream.memoryType, content: dream.content });
        }
      }

      logger.info(`[Dreaming] Ingested session ${sessId}: extracted ${savedDreams.length} dreams, ${skipped.length} blocked by noise gate for provider ${prov}`);
      res.json({ success: true, session_id: sessId, project: projectName, provider: prov, dreamsExtracted: savedDreams.length, noiseBlocked: skipped.length, dreams: savedDreams });
    } catch (err) {
      handleError(res, err, "IngestSession");
    }
  });

  // POST /api/dreams/generate-daily-dreams — trigger daily dream generation from all recent sessions
  app.post("/api/dreams/generate-daily-dreams", authMiddleware, async (req, res) => {
    try {
      const auth = authStorage.getStore()!;
      const { project, provider } = req.body as { project?: string; provider?: string };

      await logActivity(auth, "generate_daily_dreams", { project, provider });

      // Query recent unprocessed dreams (any from last 24h — used as a base for consolidation)
      const projectName = await resolveProjectName(project || "");

      // Run consolidation if enabled
      let consolidationResult = null;
      try {
        const { ConsolidationEngine } = await import("../services/consolidationEngine.js");
        const engine = new ConsolidationEngine();
        consolidationResult = await engine.run({
          project: projectName || undefined,
          operations: ["dedup", "extract_concepts", "score", "score_dreams"],
          provider: provider || undefined,
        });
        logger.info(`[Dreaming] Daily consolidation done for project="${projectName}" provider="${provider}"`);
      } catch (consolidationErr) {
        logger.error("[Dreaming] Daily consolidation failed:", consolidationErr);
      }

      res.json({
        success: true,
        project: projectName || "all",
        provider: provider || "all",
        consolidation: consolidationResult,
      });
    } catch (err) {
      handleError(res, err, "GenerateDailyDreams");
    }
  });
}
