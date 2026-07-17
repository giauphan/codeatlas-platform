/**
 * CodeAtlas Genome Service — AI DNA Engine (Phase 3)
 *
 * - Stores knowledge as atomic "Genes" instead of raw documents
 * - Each Gene: problem → solution → context → confidence → version
 * - Gene extraction from dreams, concepts, skills, feedback
 * - Vector search via Oracle 26ai NVIDIA embeddings
 */

import { randomUUID } from "node:crypto";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";

// ─── Row Index Constants ───────────────────────────────────
const R_IDX = Object.freeze({
  ID: 0, NAME: 1, DESCRIPTION: 2, PROBLEM: 3, SOLUTION: 4,
  ARCHITECTURE: 5, CATEGORY: 6, PROJECT: 7, CONFIDENCE: 8,
  VERSION: 9, EVOLUTION_SCORE: 10, USAGE_COUNT: 11, SUCCESS_RATE: 12,
  EMBEDDING: 13, STATUS: 14, SOURCE_TYPE: 15, SOURCE_ID: 16,
  DEPENDENCIES: 17, CREATED_AT: 18, UPDATED_AT: 19, DISTANCE: 20,
});

// ─── Types ──────────────────────────────────────────────────
export interface GeneInput {
  name: string;
  description: string;
  problem: string;
  solution: string;
  architecture?: string;
  category: string; // 'pattern' | 'decision' | 'lesson' | 'workflow' | 'immune'
  project: string;
  sourceType: string; // 'dream' | 'concept' | 'skill' | 'manual' | 'feedback'
  sourceId?: string;
  dependencies?: string[]; // gene IDs this depends on
  confidence?: number;
}

export interface GeneRecord {
  id: string;
  name: string;
  description: string;
  problem: string;
  solution: string;
  architecture: string;
  category: string;
  project: string;
  confidence: number;
  version: number;
  evolutionScore: number;
  usageCount: number;
  successRate: number;
  status: string;
  sourceType: string;
  sourceId: string;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GeneSearchResult extends GeneRecord {
  score: number; // similarity score
}

export interface ExtractRequest {
  sourceType: string;
  sourceId: string;
  project: string;
  autoExtract?: boolean;
}

// ─── Service ─────────────────────────────────────────────────
export class GenomeService {
  /**
   * Create or update a Gene.
   */
  static async upsertGene(input: GeneInput): Promise<string> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      // Generate embedding from problem + solution combined
      const combinedText = `${input.problem}\n\n${input.solution}`;
      const embedding = await generateEmbedding(combinedText, "query");

      // Gene with the same name + project pair means the same failure pattern.
    // We increment version rather than overwrite, preserving history.
      const existing = await connection.execute<any[]>(
        `SELECT id, version FROM codeatlas_genome WHERE name = :name AND project = :project AND tenant_id = :tenantId`,
        { name: input.name, project: input.project, tenantId } as any
      );

      let geneId: string;
      const rows = existing.rows || [];

      if (rows.length > 0) {
        // Preserve existing usage_count and prevention context;
    // only increment version and update timestamp.
        geneId = String(rows[0][0]);
        const oldVersion = Number(rows[0][1]);
        const newVersion = oldVersion + 1;

        // Save mutation record
        await connection.execute(
          `INSERT INTO gene_mutations (id, gene_id, old_version, new_version, changes, created_at)
           VALUES (:id, :geneId, :oldVer, :newVer, :changes, CURRENT_TIMESTAMP)`,
          {
            id: `mut-${randomUUID().slice(0, 8)}`,
            geneId,
            oldVer: oldVersion,
            newVer: newVersion,
            changes: JSON.stringify({ description: input.description, solution: input.solution }),
          } as any,
          { autoCommit: true }
        );

        // Overwrite gene fields while preserving creation timestamp.
        await connection.execute(
          `UPDATE codeatlas_genome SET
           description = :desc, problem = :problem, solution = :solution,
           architecture = :arch, category = :cat, confidence = :conf,
           version = :ver, evolution_score = evolution_score + 1,
           embedding = :emb, status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE id = :id AND tenant_id = :tenantId`,
          {
            id: geneId, desc: input.description, problem: input.problem,
            solution: input.solution, arch: input.architecture || "",
            cat: input.category, conf: input.confidence || 0.50,
            ver: newVersion, emb: embedding ? new Float32Array(embedding) : null,
            tenantId
          } as any,
          { autoCommit: true }
        );
        logger.info(`[Genome] Gene "${input.name}" updated to v${newVersion}`);
      } else {
        // Insert new
        geneId = `gene-${randomUUID().slice(0, 8)}`;
        await connection.execute(
          `INSERT INTO codeatlas_genome (
             id, name, description, problem, solution, architecture,
             category, project, confidence, version, evolution_score,
             usage_count, success_rate, embedding, status, source_type,
             source_id, dependencies, created_at, updated_at, tenant_id
           ) VALUES (
             :id, :name, :desc, :problem, :solution, :arch,
             :cat, :project, :conf, 1, 1, 0, 0.50, :emb, 'active',
             :srcType, :srcId, :deps, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, :tenantId
           )`,
          {
            id: geneId, name: input.name, desc: input.description,
            problem: input.problem, solution: input.solution,
            arch: input.architecture || "", cat: input.category,
            project: input.project, conf: input.confidence || 0.50,
            emb: embedding ? new Float32Array(embedding) : null,
            srcType: input.sourceType, srcId: input.sourceId || "",
            deps: JSON.stringify(input.dependencies || []),
            tenantId
          } as any,
          { autoCommit: true }
        );
        logger.info(`[Genome] Gene "${input.name}" created (v1)`);
      }

      return geneId;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Search genes by semantic similarity.
   */
  static async searchGenes(
    query: string,
    options: { project?: string; category?: string; limit?: number } = {}
  ): Promise<GeneSearchResult[]> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);
      const { project, category, limit = 20 } = options;

      const embedding = await generateEmbedding(query, "query");
      if (!embedding) return [];

      const projectFilter = project ? "AND project = :project" : "";
      const catFilter = category ? "AND category = :category" : "";
      const binds: Record<string, any> = { tenantId, limit, queryVector: new Float32Array(embedding) };
      if (project) binds.project = project;
      if (category) binds.category = category;

      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND status = 'active' ${projectFilter} ${catFilter}
         ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
         FETCH FIRST :limit ROWS ONLY`,
        binds as any
      );

      const genes = (result.rows || []).map((r: any[]) => ({
        id: String(r[R_IDX.ID]),
        name: String(r[R_IDX.NAME]),
        description: String(r[R_IDX.DESCRIPTION] || ""),
        problem: String(r[R_IDX.PROBLEM] || ""),
        solution: String(r[R_IDX.SOLUTION] || ""),
        architecture: String(r[R_IDX.ARCHITECTURE] || ""),
        category: String(r[R_IDX.CATEGORY]),
        project: String(r[R_IDX.PROJECT] || ""),
        confidence: Number(r[R_IDX.CONFIDENCE]),
        version: Number(r[R_IDX.VERSION]),
        evolutionScore: Number(r[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(r[R_IDX.USAGE_COUNT]),
        successRate: Number(r[R_IDX.SUCCESS_RATE]),
        status: String(r[R_IDX.STATUS]),
        sourceType: String(r[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(r[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(r[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(r[R_IDX.CREATED_AT]),
        updatedAt: String(r[R_IDX.UPDATED_AT]),
        score: 1 - Number(r[R_IDX.DISTANCE] ?? 0), // dummy score (real from VECTOR_DISTANCE)
      }));

      // Increment usage count for returned genes
      if (genes.length > 0) {
        try {
          const binds = genes.map(g => ({ id: g.id, tenantId }));
          await connection.executeMany(
            `UPDATE codeatlas_genome SET usage_count = usage_count + 1,
             updated_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
            binds as any,
            { autoCommit: true }
          );
        } catch { /* skip */ }
      }

      return genes;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Get a single gene by ID.
   */
  static async getGene(id: string): Promise<GeneRecord | null> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
        { id, tenantId } as any
      );

      if (!result.rows || result.rows.length === 0) return null;
      const r = result.rows[0];

      return {
        id: String(r[R_IDX.ID]),
        name: String(r[R_IDX.NAME]),
        description: String(r[R_IDX.DESCRIPTION] || ""),
        problem: String(r[R_IDX.PROBLEM] || ""),
        solution: String(r[R_IDX.SOLUTION] || ""),
        architecture: String(r[R_IDX.ARCHITECTURE] || ""),
        category: String(r[R_IDX.CATEGORY]),
        project: String(r[R_IDX.PROJECT] || ""),
        confidence: Number(r[R_IDX.CONFIDENCE]),
        version: Number(r[R_IDX.VERSION]),
        evolutionScore: Number(r[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(r[R_IDX.USAGE_COUNT]),
        successRate: Number(r[R_IDX.SUCCESS_RATE]),
        status: String(r[R_IDX.STATUS]) as GeneRecord['status'],
        sourceType: String(r[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(r[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(r[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(r[R_IDX.CREATED_AT]),
        updatedAt: String(r[R_IDX.UPDATED_AT]),
      };
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Extract genes from existing Dreams or Concepts.
   */
  static async extractGene(req: ExtractRequest): Promise<string> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      let content: string;
      let memoryType = "lesson";

      if (req.sourceType === "dream") {
        const dreams = await connection.execute<any[]>(
          `SELECT id, content, memory_type, project FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
          { id: req.sourceId, tenantId } as any
        );
        if (!dreams.rows || dreams.rows.length === 0) throw new Error("Dream not found");
        const d = dreams.rows[0];
        content = String(d[1]);
        memoryType = String(d[2]);
        req.project = req.project || String(d[3]);
      } else if (req.sourceType === "concept") {
        const concepts = await connection.execute<any[]>(
          `SELECT id, label, description, project FROM codeatlas_concepts WHERE id = :id AND tenant_id = :tenantId`,
          { id: req.sourceId, tenantId } as any
        );
        if (!concepts.rows || concepts.rows.length === 0) throw new Error("Concept not found");
        const c = concepts.rows[0];
        content = `${String(c[1])}: ${String(c[2])}`;
        req.project = req.project || String(c[3]);
      } else {
        throw new Error(`Unsupported source type: ${req.sourceType}`);
      }

      // Parse the structured content block into a gene object.
      const geneId = await this.upsertGene({
        name: this.generateGeneName(content),
        description: content.slice(0, 300),
        problem: this.extractProblem(content),
        solution: this.extractSolution(content),
        architecture: "",
        category: memoryType === "MISTAKE" ? "immune" : memoryType === "PATTERN" ? "pattern" : "lesson",
        project: req.project,
        sourceType: req.sourceType,
        sourceId: req.sourceId,
        confidence: 0.50,
      });

      return geneId;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  // ─── Heuristic helpers ──────────────────────────────────
  private static generateGeneName(content: string): string {
    const firstLine = content.split("\n")[0].slice(0, 80).trim();
    return firstLine || "Untitled Gene";
  }

  private static extractProblem(content: string): string {
    const lines = content.split("\n");
    const problemIdx = lines.findIndex((l) => l.toLowerCase().includes("problem") || l.startsWith("Task:"));
    return problemIdx >= 0 ? lines.slice(problemIdx, Math.min(problemIdx + 3, lines.length)).join("\n") : content.slice(0, 200);
  }

  private static extractSolution(content: string): string {
    const lines = content.split("\n");
    const solutionIdx = lines.findIndex((l) =>
      l.toLowerCase().includes("solution") || l.toLowerCase().includes("fix") || l.startsWith("Learnings:")
    );
    return solutionIdx >= 0 ? lines.slice(solutionIdx, Math.min(solutionIdx + 5, lines.length)).join("\n") : content.slice(0, 300);
  }

  // ════════════════════════════════════════════════════════
  // Phase 4: Evolution Engine
  // ════════════════════════════════════════════════════════

  /**
   * Merge: combine multiple genes into one unified gene.
   * The target gene absorbs source genes — they get marked as 'merged'.
   * Confidence is averaged; version increments.
   */
  static async mergeGenes(geneIds: string[], targetName: string, project: string): Promise<string> {
    if (geneIds.length < 2) throw new Error("Need at least 2 genes to merge");

    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      // Fetch all genes
      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, confidence, version, embedding
         FROM codeatlas_genome WHERE tenant_id = :tenantId AND id IN (${geneIds.map((_, i) => `:id${i}`).join(',')})`,
        { tenantId, ...geneIds.reduce((acc, id, i) => ({ ...acc, [`id${i}`]: id }), {}) } as any
      );

      const genes = result.rows || [];
      if (genes.length < 2) throw new Error("Not all genes found");

      // Combine content
      const combinedProblem = genes.map((g: any[]) => String(g[R_IDX.PROBLEM] || "")).join("\n\n");
      const combinedSolution = genes.map((g: any[]) => String(g[R_IDX.SOLUTION] || "")).join("\n\n");
      const avgConfidence = genes.reduce((s: number, g: any[]) => s + Number(g[R_IDX.CONFIDENCE]), 0) / genes.length;

      // Create unified gene
      const geneId = await this.upsertGene({
        name: targetName,
        description: `Merged from ${geneIds.length} genes:\n${genes.map((g: any[]) => String(g[R_IDX.NAME])).join(", ")}`,
        problem: combinedProblem,
        solution: combinedSolution,
        architecture: String(genes[0][R_IDX.ARCHITECTURE] || ""),
        category: String(genes[0][R_IDX.CATEGORY]),
        project,
        sourceType: "manual",
        sourceId: geneIds.join(","),
        dependencies: geneIds,
        confidence: avgConfidence,
      });

      // Mark source genes as merged
      // ⚡ Bolt Optimization: Batch updates and inserts instead of querying inside loop (avoids N+1 DB roundtrips)
      if (genes.length > 0) {
        const updateBinds = genes.map(g => ({ id: String(g[0]), tenantId }));
        await connection.executeMany(
          `UPDATE codeatlas_genome SET status = 'merged', updated_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
          updateBinds as any,
          { autoCommit: true }
        );

        // Record relationship
        const insertBinds = genes.map(g => ({
          id: `rel-${randomUUID().slice(0, 8)}`,
          src: String(g[0]),
          tgt: geneId
        }));
        await connection.executeMany(
          `INSERT INTO gene_relationships (id, source_id, target_id, relationship, weight)
           VALUES (:id, :src, :tgt, 'merged_into', 1.0)`,
          insertBinds as any,
          { autoCommit: true }
        );
      }

      logger.info(`[Genome] Merged ${geneIds.length} genes → "${targetName}" (${geneId})`);
      return geneId;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Split: break a large gene into multiple specialized genes.
   * The original gene is marked 'retired' and child genes are created.
   */
  static async splitGene(
    sourceGeneId: string,
    childNames: string[],
    project: string
  ): Promise<string[]> {
    if (childNames.length < 2) throw new Error("Need at least 2 child gene names");

    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture, category, confidence
         FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
        { id: sourceGeneId, tenantId } as any
      );

      if (!result.rows || result.rows.length === 0) throw new Error("Source gene not found");
      const g = result.rows[0];

      const sourceConfidence = Number(g[R_IDX.CONFIDENCE]);

      const childIds: string[] = [];
      for (let i = 0; i < childNames.length; i++) {
        const childId = await this.upsertGene({
          name: childNames[i],
          description: `Split from: ${String(g[R_IDX.NAME])} (part ${i + 1}/${childNames.length})`,
          problem: String(g[R_IDX.PROBLEM] || ""),
          solution: String(g[R_IDX.SOLUTION] || "").split("\n").slice(
            Math.floor(i * (String(g[R_IDX.SOLUTION] || "").split("\n").length / childNames.length)),
            Math.floor((i + 1) * (String(g[R_IDX.SOLUTION] || "").split("\n").length / childNames.length))
          ).join("\n") || `Sub-gene ${i + 1} of ${String(g[R_IDX.NAME])}`,
          architecture: String(g[R_IDX.ARCHITECTURE] || ""),
          category: String(g[R_IDX.CATEGORY]),
          project,
          sourceType: "manual",
          sourceId: sourceGeneId,
          confidence: sourceConfidence * 0.8, // slightly lower confidence initially
        });
        childIds.push(childId);

        await connection.execute(
          `INSERT INTO gene_relationships (id, source_id, target_id, relationship, weight)
           VALUES (:id, :src, :tgt, 'split_from', 0.8)`,
          { id: `rel-${randomUUID().slice(0, 8)}`, src: sourceGeneId, tgt: childId } as any,
          { autoCommit: true }
        );
      }

      // Mark source as retired
      await connection.execute(
        `UPDATE codeatlas_genome SET status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
        { id: sourceGeneId, tenantId } as any,
        { autoCommit: true }
      );

      logger.info(`[Genome] Split "${String(g[R_IDX.NAME])}" → ${childNames.length} children`);
      return childIds;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Mutate: increment version with improvements.
   * Uses feedback (success/failure) to adjust confidence.
   */
  static async mutateGene(
    geneId: string,
    improvements: { description?: string; solution?: string; success?: boolean },
    project: string
  ): Promise<string> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const result = await connection.execute<any[]>(
        `SELECT id, name, problem, solution, confidence, version, success_rate, usage_count
         FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
        { id: geneId, tenantId } as any
      );

      if (!result.rows || result.rows.length === 0) throw new Error("Gene not found");
      const g = result.rows[0];

      const oldConfidence = Number(g[R_IDX.CONFIDENCE]);
      const oldVersion = Number(g[R_IDX.VERSION]);
      const oldSuccessRate = Number(g[R_IDX.SUCCESS_RATE]);
      const oldUsage = Number(g[R_IDX.USAGE_COUNT]);

      // Bayesian confidence update based on feedback
      let newConfidence = oldConfidence;
      let newSuccessRate = oldSuccessRate;

      if (improvements.success === true) {
        // Success boosts confidence
        newConfidence = Math.min(0.99, oldConfidence + 0.05 * Math.log2(2 + (oldUsage || 0)));
        newSuccessRate = (oldSuccessRate * oldUsage + 1) / (oldUsage + 1);
      } else if (improvements.success === false) {
        // Failure penalties
        newConfidence = Math.max(0.05, oldConfidence * 0.85);
        newSuccessRate = (oldSuccessRate * oldUsage) / Math.max(1, oldUsage + 1);
      }

      // Save mutation record
      await connection.execute(
        `INSERT INTO gene_mutations (id, gene_id, old_version, new_version, changes)
         VALUES (:id, :geneId, :oldVer, :newVer, :changes)`,
        {
          id: `mut-${randomUUID().slice(0, 8)}`,
          geneId,
          oldVer: oldVersion,
          newVer: oldVersion + 1,
          changes: JSON.stringify({ ...improvements, oldConfidence, newConfidence }),
        } as any,
        { autoCommit: true }
      );

      // Update gene
      const updates: string[] = [];
      const binds: Record<string, any> = { id: geneId, tenantId };

      if (improvements.description) {
        updates.push("description = :desc");
        binds.desc = improvements.description;
      }
      if (improvements.solution) {
        updates.push("solution = :sol");
        binds.sol = improvements.solution;
      }
      updates.push("confidence = :conf", "version = version + 1",
                    "success_rate = :sr", "evolution_score = evolution_score + 1",
                    "updated_at = CURRENT_TIMESTAMP");
      binds.conf = newConfidence;
      binds.sr = newSuccessRate;

      await connection.execute(
        `UPDATE codeatlas_genome SET ${updates.join(", ")} WHERE id = :id AND tenant_id = :tenantId`,
        binds as any,
        { autoCommit: true }
      );

      logger.info(`[Genome] Mutated "${String(g[R_IDX.NAME])}" (v${oldVersion}→v${oldVersion + 1}, confidence: ${oldConfidence}→${newConfidence.toFixed(2)})`);
      return geneId;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Retire: mark one or more genes as retired (obsolete).
   */
  static async retireGenes(geneIds: string[]): Promise<number> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      let count = 0;
      // ⚡ Bolt Optimization: Batch retirement update using executeMany instead of executing queries in a loop.
      if (geneIds.length > 0) {
        const binds = geneIds.map(id => ({ id, tenantId }));
        const result = await connection.executeMany(
          `UPDATE codeatlas_genome SET status = 'retired', updated_at = CURRENT_TIMESTAMP
           WHERE id = :id AND status != 'retired' AND tenant_id = :tenantId`,
          binds as any,
          { autoCommit: true }
        );
        count = result.rowsAffected || 0;
      }

      logger.info(`[Genome] Retired ${count} genes`);
      return count;
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  // ════════════════════════════════════════════════════════
  // Phase 5: Immune System — CRISPR-inspired failure prevention
  // ════════════════════════════════════════════════════════

  /**
   * Scan for immune genes matching a given problem description.
   * Returns prevention context that should be injected BEFORE reasoning.
   */
  static async scanImmuneGenes(problem: string, project?: string): Promise<GeneRecord[]> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const embedding = await generateEmbedding(problem, "query");
      if (!embedding) return [];

      const projectFilter = project ? "AND project = :project" : "";
      const binds: Record<string, any> = { tenantId, limit: 5, queryVector: new Float32Array(embedding) };
      if (project) binds.project = project;

      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND category = 'immune' AND status = 'active' ${projectFilter}
           AND confidence > 0.3
         ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
         FETCH FIRST :limit ROWS ONLY`,
        binds as any
      );

      return (result.rows || []).map((r: any[]) => ({
        id: String(r[R_IDX.ID]),
        name: String(r[R_IDX.NAME]),
        description: String(r[R_IDX.DESCRIPTION] || ""),
        problem: String(r[R_IDX.PROBLEM] || ""),
        solution: String(r[R_IDX.SOLUTION] || ""),
        architecture: String(r[R_IDX.ARCHITECTURE] || ""),
        category: String(r[R_IDX.CATEGORY]),
        project: String(r[R_IDX.PROJECT] || ""),
        confidence: Number(r[R_IDX.CONFIDENCE]),
        version: Number(r[R_IDX.VERSION]),
        evolutionScore: Number(r[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(r[R_IDX.USAGE_COUNT]),
        successRate: Number(r[R_IDX.SUCCESS_RATE]),
        status: String(r[R_IDX.STATUS]),
        sourceType: String(r[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(r[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(r[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(r[R_IDX.CREATED_AT]),
        updatedAt: String(r[R_IDX.UPDATED_AT]),
      }));
    } finally {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Create immune gene from a failure (FEEDBACK dream with result='failure').
   * This records the failure pattern so future tasks can avoid the same mistake.
   */
  static async createImmuneGene(
    problem: string,
    failureDescription: string,
    prevention: string,
    project: string
  ): Promise<string> {
    return this.upsertGene({
      name: `[IMMUNE] ${problem.slice(0, 70)}`,
      description: failureDescription.slice(0, 500),
      problem: `Failure: ${failureDescription.slice(0, 300)}`,
      solution: `Prevention: ${prevention.slice(0, 500)}`,
      architecture: "",
      category: "immune",
      project,
      sourceType: "feedback",
      confidence: 0.70, // immune genes start with higher confidence
    });
  }

  /**
   * Build prevention context from immune genes.
   * Returns formatted text to inject before agent reasoning.
   */
  static async buildImmuneContext(problem: string, project?: string): Promise<string> {
    const genes = await this.scanImmuneGenes(problem, project);
    if (genes.length === 0) return "";

    const parts = ["\n# ⚠️ Immune System: Previously encountered failures\n"];
    for (const g of genes) {
      parts.push(`### ${g.name}`);
      parts.push(`**Failure**: ${g.problem}`);
      parts.push(`**Prevention**: ${g.solution}`);
      parts.push(`**Confidence**: ${(g.confidence * 100).toFixed(0)}% | Success rate: ${(g.successRate * 100).toFixed(0)}%\n`);
    }
    parts.push("⚠️ Apply these preventions before proceeding\n");
    return parts.join("\n");
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 7: Multi-Repository Intelligence & Skill Generation
  // ═══════════════════════════════════════════════════════════

  /**
   * Recommend genes relevant to a task/context across all projects.
   * Enables multi-repository intelligence — knowledge from one project
   * benefits another when relevant.
   */
  static async recommendGenes(
    context: string,
    project?: string,
    limit: number = 10,
    minConfidence: number = 0.3
  ): Promise<GeneSearchResult[]> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);
      const embedding = await generateEmbedding(context, "query");
      if (!embedding) return [];

      const binds: Record<string, any> = { tenantId, limit, queryVector: new Float32Array(embedding) };
      let projectFilter = "";
      let confFilter = "1=1";
      if (project) {
        projectFilter = "AND project = :project";
        binds.project = project;
      }
      confFilter = "confidence >= :minConf";
      binds.minConf = minConfidence;

      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate,embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND status = 'active' ${projectFilter} AND ${confFilter}
         ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
         FETCH FIRST :limit ROWS ONLY`,
        binds as any
      );

      const genes: GeneSearchResult[] = (result.rows || []).map((r: any[]) => ({
        id: String(r[R_IDX.ID]),
        name: String(r[R_IDX.NAME]),
        description: String(r[R_IDX.DESCRIPTION] || ""),
        problem: String(r[R_IDX.PROBLEM] || ""),
        solution: String(r[R_IDX.SOLUTION] || ""),
        architecture: String(r[R_IDX.ARCHITECTURE] || ""),
        category: String(r[R_IDX.CATEGORY]),
        project: String(r[R_IDX.PROJECT] || ""),
        confidence: Number(r[R_IDX.CONFIDENCE]),
        version: Number(r[R_IDX.VERSION]),
        evolutionScore: Number(r[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(r[R_IDX.USAGE_COUNT]),
        successRate: Number(r[R_IDX.SUCCESS_RATE]),
        status: String(r[R_IDX.STATUS]),
        sourceType: String(r[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(r[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(r[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(r[R_IDX.CREATED_AT]),
        updatedAt: String(r[R_IDX.UPDATED_AT]),
        score: 1 - Number(r[R_IDX.DISTANCE] ?? 0),
      }));
      return genes;
    } finally {
      try { await connection.close(); } catch { }
    }
  }

  /**
   * Generate an AI-optimized skill prompt from a gene.
   * Any AI IDE can request this via MCP — no manual installation needed.
   * "Skills Become Genes" — dynamic capability delivery.
   */
  static async generateSkillFromGene(geneId: string): Promise<string | null> {
    const gene = await this.getGene(geneId);
    if (!gene) return null;

    const parts: string[] = [];
    parts.push(`# Skill: ${gene.name}\n`);
    parts.push(`**Description**: ${gene.description}\n`);
    parts.push(`## Problem\n${gene.problem}\n`);
    parts.push(`## Solution\n${gene.solution}\n`);
    if (gene.architecture) {
      parts.push(`## Architecture\n${gene.architecture}\n`);
    }
    parts.push(`## Metadata`);
    parts.push(`- Category: ${gene.category}`);
    parts.push(`- Confidence: ${(gene.confidence * 100).toFixed(0)}%`);
    parts.push(`- Version: ${gene.version}`);
    parts.push(`- Usage count: ${gene.usageCount}`);
    parts.push(`- Success rate: ${(gene.successRate * 100).toFixed(0)}%\n`);
    parts.push(`## Instructions
Apply this knowledge when encountering similar problems.
1. Analyze the current context against the problem description
2. If matched, apply the solution pattern
3. Adapt to current project specifics
4. Report outcome to improve the gene's success rate\n`);
    if (gene.dependencies && gene.dependencies.length > 0) {
      parts.push(`\n**Depends on**: ${gene.dependencies.join(", ")}`);
    }

    // Increment usage count
    try {
      const conn = await (await initPool()).getConnection();
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(conn, tenantId);
      await conn.execute(
        `UPDATE codeatlas_genome SET usage_count = usage_count + 1 WHERE id = :id AND tenant_id = :tenantId`,
        { id: geneId, tenantId } as any,
        { autoCommit: true }
      );
      await conn.close();
    } catch {
      // Non-critical — don't fail the skill generation
    }

    return parts.join("\n");
  }

  /**
   * Inherit relevant genes from other projects when setting up a new project.
   * DNA Inheritance — every new project is born smarter.
   */
  static async inheritProjectGenes(
    newProject: string,
    context: string,
    sourceProjects?: string[],
    limit: number = 20
  ): Promise<{ inherited: number; genes: GeneSearchResult[] }> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);
      const embedding = await generateEmbedding(context, "query");
      if (!embedding) return { inherited: 0, genes: [] };

      let sql: string;
      const binds: Record<string, any> = { tenantId, limit: Math.min(limit, 50) };

      if (sourceProjects && sourceProjects.length > 0) {
        sql = `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND status = 'active' AND project IN (${sourceProjects.map((_, i) => `:src${i}`).join(",")})
         ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
         FETCH FIRST :limit ROWS ONLY`;
        sourceProjects.forEach((p, i) => (binds[`src${i}`] = p));
      } else {
        sql = `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND status = 'active' AND project != :excludeProject
         ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)
         FETCH FIRST :limit ROWS ONLY`;
        binds.excludeProject = newProject;
      }
      binds.queryVector = new Float32Array(embedding);

      const result = await connection.execute<any[]>(sql, binds as any);
      const rows = result.rows || [];

      // Map rows to GeneRecords using R_IDX
      const genes: GeneSearchResult[] = rows.map((r: any[]) => ({
        id: String(r[R_IDX.ID]),
        name: String(r[R_IDX.NAME]),
        description: String(r[R_IDX.DESCRIPTION] || ""),
        problem: String(r[R_IDX.PROBLEM] || ""),
        solution: String(r[R_IDX.SOLUTION] || ""),
        architecture: String(r[R_IDX.ARCHITECTURE] || ""),
        category: String(r[R_IDX.CATEGORY]),
        project: String(r[R_IDX.PROJECT] || ""),
        confidence: Number(r[R_IDX.CONFIDENCE]),
        version: Number(r[R_IDX.VERSION]),
        evolutionScore: Number(r[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(r[R_IDX.USAGE_COUNT]),
        successRate: Number(r[R_IDX.SUCCESS_RATE]),
        status: String(r[R_IDX.STATUS]),
        sourceType: String(r[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(r[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(r[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(r[R_IDX.CREATED_AT]),
        updatedAt: String(r[R_IDX.UPDATED_AT]),
        score: 1 - Number(r[R_IDX.DISTANCE] ?? 0),
      }));

      // Upsert each inherited gene into the new project
      let inherited = 0;
      for (const gene of genes) {
        try {
          await this.upsertGene({
            name: gene.name,
            description: gene.description,
            problem: gene.problem,
            solution: gene.solution,
            architecture: gene.architecture,
            category: gene.category,
            project: newProject,
            sourceType: "inherited",
            sourceId: gene.id,
            dependencies: gene.dependencies,
            confidence: gene.confidence * 0.9,
          });
          inherited++;
        } catch {
          // Skip duplicates
        }
      }

      return { inherited, genes };
    } catch (err) {
      logger.error("inheritProjectGenes failed", err);
      return { inherited: 0, genes: [] };
    } finally {
      try { await connection.close(); } catch { }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Skill Store Methods (Cloud-backed skill persistence)
  // ═══════════════════════════════════════════════════════════

  /**
   * Find a gene by exact name and category (for skill lookup).
   * Uses text match, not vector similarity.
   */
  static async getGeneByNameAndCategory(
    name: string,
    category: string
  ): Promise<GeneSearchResult | null> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);
      const result = await connection.execute<any[]>(
        `SELECT id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND name = :name AND category = :cat AND status = 'active'
         FETCH FIRST 1 ROWS ONLY`,
        { tenantId, name, cat: category } as any
      );
      const row = result.rows?.[0];
      if (!row) return null;
      return {
        id: String(row[R_IDX.ID]),
        name: String(row[row.length - 1] === undefined ? row[R_IDX.NAME] : row[R_IDX.NAME]), // safe index check
        description: String(row[R_IDX.DESCRIPTION] || ""),
        problem: String(row[R_IDX.PROBLEM] || ""),
        solution: String(row[R_IDX.SOLUTION] || ""),
        architecture: String(row[R_IDX.ARCHITECTURE] || ""),
        category: String(row[R_IDX.CATEGORY]),
        project: String(row[R_IDX.PROJECT] || ""),
        confidence: Number(row[R_IDX.CONFIDENCE]),
        version: Number(row[R_IDX.VERSION]),
        evolutionScore: Number(row[R_IDX.EVOLUTION_SCORE]),
        usageCount: Number(row[R_IDX.USAGE_COUNT]),
        successRate: Number(row[R_IDX.SUCCESS_RATE]),
        status: String(row[R_IDX.STATUS]),
        sourceType: String(row[R_IDX.SOURCE_TYPE] || ""),
        sourceId: String(row[R_IDX.SOURCE_ID] || ""),
        dependencies: JSON.parse(String(row[R_IDX.DEPENDENCIES] || "[]")),
        createdAt: String(row[R_IDX.CREATED_AT]),
        updatedAt: String(row[R_IDX.UPDATED_AT]),
        score: 1,
      };
    } catch (err) {
      logger.error(`getGeneByNameAndCategory failed: ${name}/${category}`, err);
      return null;
    } finally {
      try { await connection.close(); } catch { }
    }
  }

  /**
   * Convenience wrapper: create a gene (skill) with defaults.
   * Calls upsertGene internally.
   */
  static async createGene(input: {
    name: string;
    description: string;
    problem?: string;
    solution: string;
    category: string;
    project?: string;
    dependencies?: string[];
    confidence?: number;
  }): Promise<GeneRecord> {
  const geneId = await this.upsertGene({
    name: input.name,
    description: input.description,
    problem: input.problem || "",
    solution: input.solution,
    architecture: "",
    category: input.category,
    project: input.project || "global",
    sourceType: "skill",
    dependencies: input.dependencies || [],
    confidence: input.confidence ?? 0.50,
  });
  // Fetch back the created gene as GeneRecord (has all fields)
  const created = await this.getGene(geneId);
  if (!created) throw new Error(`Gene created but not found: ${geneId}`);
  return created;
  }

  /**
   * Update specific fields of an existing gene.
   * Only updates provided fields, regenerates embedding if name/solution/description changes.
   */
  static async updateGene(
    geneId: string,
    fields: {
      name?: string;
      description?: string;
      problem?: string;
      solution?: string;
      architecture?: string;
      category?: string;
      dependencies?: string[];
      confidence?: number;
      version?: number;
    }
  ): Promise<void> {
    const connection = await (await initPool()).getConnection();
    try {
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);
      const sets: string[] = [];
      const binds: Record<string, any> = { id: geneId, tenantId };
      if (fields.name !== undefined) { sets.push("name = :name"); binds.name = fields.name; }
      if (fields.description !== undefined) { sets.push("description = :desc"); binds.desc = fields.description; }
      if (fields.problem !== undefined) { sets.push("problem = :problem"); binds.problem = fields.problem; }
      if (fields.solution !== undefined) { sets.push("solution = :solution"); binds.solution = fields.solution; }
      if (fields.architecture !== undefined) { sets.push("architecture = :arch"); binds.arch = fields.architecture; }
      if (fields.category !== undefined) { sets.push("category = :cat"); binds.cat = fields.category; }
      if (fields.dependencies !== undefined) { sets.push("dependencies = :deps"); binds.deps = JSON.stringify(fields.dependencies); }
      if (fields.confidence !== undefined) { sets.push("confidence = :conf"); binds.conf = fields.confidence; }
      if (fields.version !== undefined) { sets.push("version = :ver"); binds.ver = fields.version; }
      sets.push("updated_at = CURRENT_TIMESTAMP");

      // Regenerate embedding if content changed
      const shouldReEmbed = fields.name !== undefined || fields.description !== undefined || fields.solution !== undefined;
      if (shouldReEmbed) {
        const embedText = `${fields.name || ""} ${fields.description || ""} ${fields.solution || ""}`.trim();
        if (embedText) {
          const embedding = await generateEmbedding(embedText, "passage");
          if (embedding) {
            sets.push("embedding = :emb");
            binds.emb = new Float32Array(embedding);
          }
        }
      }

      if (sets.length === 1) return; // nothing to update
      const sql = `UPDATE codeatlas_genome SET ${sets.join(", ")} WHERE id = :id AND tenant_id = :tenantId`;
      await connection.execute(sql, binds as any, { autoCommit: true });
    } catch (err) {
      logger.error(`updateGene failed for ${geneId}`, err);
      throw err;
    } finally {
      try { await connection.close(); } catch { }
    }
  }
}
