/**
 * Consolidation API routes — trigger & monitor Second Brain consolidation jobs.
 */
import express from "express";
import { consolidationEngine, type ConsolidationJob } from "../services/consolidationEngine.js";
import { authMiddleware } from "../services/authService.js";
import { logger } from "../utils/logger.js";
import rateLimit from "express-rate-limit";

const consolidationRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // limit each IP to 120 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

export function mountConsolidationRoutes(app: express.Application): void {
  // POST /api/consolidation/run — Run consolidation job manually
  app.post("/api/consolidation/run", consolidationRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const job: ConsolidationJob = req.body;
      if (!job.operations || job.operations.length === 0) {
        res.status(400).json({ error: "operations array is required (e.g. ['dedup','extract_concepts','score'])" });
        return;
      }
      const report = await consolidationEngine.run(job);
      res.status(200).json(report);
    } catch (err) {
      logger.error(`[Consolidation API] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/concepts/search — Search concepts by text
  app.get("/api/concepts/search", consolidationRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const query = String(req.query.query || "");
      const project = req.query.project as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      if (!query) {
        res.json({ results: [], total: 0 });
        return;
      }

      const { initAdapter, setSessionContext } = await import("../database/connection.js");
      const { generateEmbedding } = await import("../services/embeddingService.js");

      const embedding = await generateEmbedding(query, "query");
      if (!embedding || embedding.length === 0) {
        res.json({ concepts: [] });
        return;
      }

      const { authStorage } = await import("../utils/context.js");
      const auth = authStorage.getStore();
      const tenantId = authStorage.getStore()!.uid;

      const adapter = await initAdapter();

        const projectFilter = project ? "AND project = :project" : "";
        const whereClause = `WHERE tenant_id = :tenantId AND status = 'active' ${projectFilter}`;

        const binds: Record<string, unknown> = { tenantId: authStorage.getStore()!.uid, limit, queryVector: embedding };
        if (project) binds.project = project;

        const result = await adapter.query(
          `SELECT id, label, description, category, confidence, evidence_count, project
           FROM codeatlas_concepts ${whereClause}
           ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
           LIMIT :limit`,
          binds
        );

        const concepts = (result || []).map((r: any) => ({
          id: String(r.id),
          label: String(r.label),
          description: String(r.description || ""),
          category: String(r.category || "lesson"),
          confidence: Number(r.confidence),
          evidenceCount: Number(r.evidence_count),
          project: String(r.project || ""),
        }));

        res.json({ concepts });

        // Batch update access counts - reduces N roundtrips to 1
        if (concepts.length > 0) {
          try {
            const binds = concepts.map(c => ({ id: c.id, tenantId }));
            await adapter.executeMany(
              `UPDATE codeatlas_concepts SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
              binds
            );
          } catch { /* skip */ }
        }
    } catch (err) {
      logger.error(`[Concepts API] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });
}
