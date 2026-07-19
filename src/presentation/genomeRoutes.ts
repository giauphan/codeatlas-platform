/**
 * Genome Routes — CodeAtlas AI DNA
 */
import express from "express";
import { GenomeService } from "../services/genomeService.js";
import { authMiddleware } from "../services/authService.js";
import { logger } from "../utils/logger.js";

export function mountGenomeRoutes(app: express.Application): void {
  // POST /api/genome/gene — Create or update a gene
  app.post("/api/genome/gene", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const input = req.body;
      if (!input.name || !input.problem || !input.solution || !input.category || !input.project) {
        res.status(400).json({ error: "name, problem, solution, category, project are required" });
        return;
      }
      const geneId = await GenomeService.upsertGene(input);
      res.status(201).json({ success: true, geneId });
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/genome/gene/:id — Get single gene
  app.get("/api/genome/gene/:id", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const gene = await GenomeService.getGene(req.params.id);
      if (!gene) {
        res.status(404).json({ error: "Gene not found" });
        return;
      }
      res.json(gene);
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/genome/search — Semantic search genes
  app.get("/api/genome/search", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const query = String(req.query.query || "");
      if (!query) {
        res.status(400).json({ error: "query parameter is required" });
        return;
      }
      const genes = await GenomeService.searchGenes(query, {
        project: req.query.project as string | undefined,
        category: req.query.category as string | undefined,
        limit: Math.min(Number(req.query.limit) || 20, 50),
      });
      res.json({ genes });
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/genome/extract — Extract gene from dream or concept
  app.post("/api/genome/extract", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { sourceType, sourceId, project } = req.body;
      if (!sourceType || !sourceId) {
        res.status(400).json({ error: "sourceType and sourceId are required" });
        return;
      }
      const geneId = await GenomeService.extractGene({ sourceType, sourceId, project: project || "" });
      res.status(201).json({ success: true, geneId });
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/genome/list — List genes (paginated, no vector search)
  app.get("/api/genome/list", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { initPool, setSessionContext } = await import("../database/connection.js");
      const connection = await (await initPool()).getConnection();
      try {
        await setSessionContext(connection);
        const project = req.query.project as string | undefined;
        const category = req.query.category as string | undefined;
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        const offset = Number(req.query.offset) || 0;

        const pFilter = project ? "WHERE project = :project" : "";
        const catFilter = category ? (pFilter ? "AND category = :category" : "WHERE category = :category") : "";
        const binds: Record<string, any> = { limit, offset };
        if (project) binds.project = project;
        if (category) binds.category = category;

        const result = await connection.execute<any[]>(
          `SELECT id, name, description, problem, solution, architecture,
                  category, project, confidence, version, evolution_score,
                  usage_count, success_rate, status, source_type, created_at, updated_at
           FROM codeatlas_genome ${pFilter} ${catFilter}
           ORDER BY evolution_score DESC
           FETCH FIRST :limit ROWS ONLY`,
          binds as any
        );

        const genes = (result.rows || []).map((r: any[]) => ({
          id: String(r[0]), name: String(r[1]), description: String(r[2] || ""),
          problem: String(r[3] || ""), solution: String(r[4] || ""),
          architecture: String(r[5] || ""), category: String(r[6]),
          project: String(r[7] || ""), confidence: Number(r[8]),
          version: Number(r[9]), evolutionScore: Number(r[10]),
          usageCount: Number(r[11]), successRate: Number(r[12]),
          status: String(r[13]), sourceType: String(r[14] || ""),
          createdAt: String(r[15]), updatedAt: String(r[16]),
        }));

        res.json({ genes, offset, limit });
      } finally {
        try { await connection.close(); } catch { /* ignore */ }
      }
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // ════════════════════════════════════════════════════════
  // Phase 4: Evolution API
  // ════════════════════════════════════════════════════════

  // POST /api/genome/merge — Merge multiple genes into one
  app.post("/api/genome/merge", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { geneIds, targetName, project } = req.body;
      if (!geneIds || geneIds.length < 2 || !targetName || !project) {
        res.status(400).json({ error: "geneIds (min 2), targetName, project required" });
        return;
      }
      const geneId = await GenomeService.mergeGenes(geneIds, targetName, project);
      res.status(201).json({ success: true, geneId, absorbed: geneIds.length });
    } catch (err) {
      logger.error(`[Genome merge] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/genome/split — Split a gene into specialized children
  app.post("/api/genome/split", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { sourceGeneId, childNames, project } = req.body;
      if (!sourceGeneId || !childNames || childNames.length < 2 || !project) {
        res.status(400).json({ error: "sourceGeneId, childNames (min 2), project required" });
        return;
      }
      const childIds = await GenomeService.splitGene(sourceGeneId, childNames, project);
      res.status(201).json({ success: true, childIds });
    } catch (err) {
      logger.error(`[Genome split] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/genome/mutate — Mutate a gene (improve via feedback)
  app.post("/api/genome/mutate", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { geneId, improvements, project } = req.body;
      if (!geneId || !project) {
        res.status(400).json({ error: "geneId and project required" });
        return;
      }
      await GenomeService.mutateGene(geneId, improvements || {}, project);
      res.status(200).json({ success: true, geneId });
    } catch (err) {
      logger.error(`[Genome mutate] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/genome/retire — Retire genes
  app.post("/api/genome/retire", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { geneIds } = req.body;
      if (!geneIds || geneIds.length === 0) {
        res.status(400).json({ error: "geneIds array required" });
        return;
      }
      const count = await GenomeService.retireGenes(geneIds);
      res.status(200).json({ success: true, retired: count });
    } catch (err) {
      logger.error(`[Genome retire] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });


  // ── Auto-Sync: Hermes Skills -> Genome ───────────────────────
  app.post("/api/genome/sync-skills", authMiddleware, async (req: any, res: any) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const skillsDir = path.join(process.env.HOME || "/home/ubuntu", ".hermes", "skills");
      let synced = 0, failed = 0;
      if (!fs.existsSync(skillsDir)) return res.json({ synced: 0, failed: 0 });
      const dirs = await fs.promises.readdir(skillsDir);
      for (const dir of dirs) {
        const sp = path.join(skillsDir, dir, "SKILL.md");
        if (!fs.existsSync(sp)) continue;
        try {
          const c = await fs.promises.readFile(sp, "utf-8");
          const desc = c.match(/^description: "(.+)"$/m)?.[1] || "";
          const cat = c.match(/^category: (.+)$/m)?.[1] || "workflow";
          await GenomeService.upsertGene({ name: dir, description: desc, problem: "Need " + dir, solution: desc || dir, category: cat, project: "codeatlas-genome", sourceType: "skill", confidence: 0.70 });
          synced++;
        } catch { failed++; }
      }
      res.json({ success: true, synced, failed });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Phase 5: Immune System
  // ════════════════════════════════════════════════════════

  // GET /api/genome/immune?problem=...&project=... — Scan immune genes
  app.get("/api/genome/immune", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const problem = String(req.query.problem || "");
      if (!problem) {
        res.status(400).json({ error: "problem query param required" });
        return;
      }
      const genes = await GenomeService.scanImmuneGenes(problem, req.query.project as string | undefined);
      res.json({ genes });
    } catch (err) {
      logger.error(`[Genome immune] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/genome/immune — Create immune gene from failure
  app.post("/api/genome/immune", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { problem, failure, prevention, project } = req.body;
      if (!problem || !failure || !prevention || !project) {
        res.status(400).json({ error: "problem, failure, prevention, project required" });
        return;
      }
      const geneId = await GenomeService.createImmuneGene(problem, failure, prevention, project);
      res.status(201).json({ success: true, geneId });
    } catch (err) {
      logger.error(`[Genome immune] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/genome/immune/context — Build prevention context for injection
  app.get("/api/genome/immune/context", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const problem = String(req.query.problem || "");
      if (!problem) {
        res.status(400).json({ error: "problem query param required" });
        return;
      }
      const context = await GenomeService.buildImmuneContext(
        problem, req.query.project as string | undefined
      );
      res.json({ context, immuneCount: context ? (context.match(/# Application/g) || []).length : 0 });
    } catch (err) {
      logger.error(`[Genome immune] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });
}
