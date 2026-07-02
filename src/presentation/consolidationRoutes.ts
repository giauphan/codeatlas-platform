/**
 * Consolidation API routes — trigger & monitor Second Brain consolidation jobs.
 */
import express from "express";
import { consolidationEngine, type ConsolidationJob } from "../services/consolidationEngine.js";
import { checkAuth } from "../services/authService.js";
import { logger } from "../utils/logger.js";

export function mountConsolidationRoutes(app: express.Application): void {
  // POST /api/consolidation/run — Run consolidation job manually
  app.post("/api/consolidation/run", checkAuth, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/concepts/search", checkAuth, async (req: express.Request, res: express.Response) => {
    try {
      const query = String(req.query.query || "");
      const project = req.query.project as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      if (!query) {
        res.status(400).json({ error: "query param is required" });
        return;
      }

      const { initPool, setSessionContext } = await import("../database/connection.js");
      const { generateEmbedding } = await import("../services/embeddingService.js");

      const embedding = await generateEmbedding(query, "query");
      if (!embedding || embedding.length === 0) {
        res.json({ concepts: [] });
        return;
      }

      let connection;
      try {
        const pool = await initPool();
        connection = await pool.getConnection();
        await setSessionContext(connection);

        const whereClause = project
          ? "WHERE project = :project AND status = 'active'"
          : "WHERE status = 'active'";
        const binds: Record<string, unknown> = { limit, queryVector: new Float32Array(embedding) };
        if (project) binds.project = project;

        const result = await connection.execute<any[]>(
          `SELECT id, label, description, category, confidence, evidence_count, project
           FROM codeatlas_concepts ${whereClause}
           ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
           FETCH FIRST :limit ROWS ONLY`,
          binds as any
        );

        const concepts = (result.rows || []).map((r: any[]) => ({
          id: String(r[0]),
          label: String(r[1]),
          description: String(r[2] || ""),
          category: String(r[3] || "lesson"),
          confidence: Number(r[4]),
          evidenceCount: Number(r[5]),
          project: String(r[6] || ""),
        }));

        res.json({ concepts });
      } finally {
        if (connection) {
          try { await connection.close(); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      logger.error(`[Concepts API] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });
}
