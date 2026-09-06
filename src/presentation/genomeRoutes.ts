/**
 * Genome Routes — CodeAtlas AI DNA
 */
import express from "express";
import { GenomeService } from "../services/genomeService.js";
import { authMiddleware } from "../services/authService.js";
import { logger } from "../utils/logger.js";
import rateLimit from "express-rate-limit";

const genomeRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // limit each IP to 120 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

export function mountGenomeRoutes(app: express.Application): void {
  // POST /api/genome/gene — Create or update a gene
  app.post("/api/genome/gene", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/genome/gene/:id", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/genome/search", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/extract", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/genome/list", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { initAdapter } = await import("../database/connection.js");
      const { authStorage } = await import("../utils/context.js");

      // Note: In this system, `uid` on the AuthContext object represents the tenant identifier
      // for enterprise/multi-tenant requests, not a single user ID.
      const tenantId = authStorage.getStore()?.uid;
      if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
        res.status(401).json({ error: "Unauthorized: Missing or invalid tenant context" });
        return;
      }

      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset);

      if ((req.query.limit !== undefined && isNaN(rawLimit)) ||
          (req.query.offset !== undefined && isNaN(rawOffset))) {
        res.status(400).json({ error: "Bad Request: limit and offset must be valid numbers" });
        return;
      }

      const adapter = await initAdapter();
      const project = typeof req.query.project === 'string' ? req.query.project.trim() : undefined;
      const category = typeof req.query.category === 'string' ? req.query.category.trim() : undefined;
      const limit = Math.max(0, Math.min(rawLimit || 50, 100)); // Still defaults to 50 if 0 or undefined, clamped to 100
      const offset = Math.max(0, rawOffset || 0);

      const binds: Record<string, any> = { limit, offset, tenantId };
      const whereParts = ["tenant_id = :tenantId"];

      if (project) {
        whereParts.push("project = :project");
        binds.project = project;
      }

      if (category) {
        whereParts.push("category = :category");
        binds.category = category;
      }

      const whereSql = `WHERE ${whereParts.join(" AND ")}`;

      const result = await adapter.query<any>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, status, source_type, created_at, updated_at
         FROM codeatlas_genome
         ${whereSql}
         ORDER BY evolution_score DESC, id ASC
         LIMIT :limit OFFSET :offset`,
        binds
      );

      const genes = (result || []).map((r: any) => ({
        id: String(r.id), name: String(r.name), description: String(r.description || ""),
        problem: String(r.problem || ""), solution: String(r.solution || ""),
        architecture: String(r.architecture || ""), category: String(r.category),
        project: String(r.project || ""), confidence: Number(r.confidence),
        version: Number(r.version), evolutionScore: Number(r.evolution_score),
        usageCount: Number(r.usage_count), successRate: Number(r.success_rate),
        status: String(r.status), sourceType: String(r.source_type || ""),
        createdAt: String(r.created_at), updatedAt: String(r.updated_at),
      }));

      res.json({ genes, offset, limit });
    } catch (err) {
      logger.error(`[Genome] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // ════════════════════════════════════════════════════════
  // Phase 4: Evolution API
  // ════════════════════════════════════════════════════════

  // POST /api/genome/merge — Merge multiple genes into one
  app.post("/api/genome/merge", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/split", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/mutate", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/retire", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/sync-skills", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/genome/immune", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.post("/api/genome/immune", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
  app.get("/api/genome/immune/context", genomeRateLimiter, authMiddleware, async (req: express.Request, res: express.Response) => {
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
