/**
 * CodeAtlas Genome Service — AI DNA Engine (Phase 3)
 *
 * - Stores knowledge as atomic "Genes" instead of raw documents
 * - Each Gene: problem → solution → context → confidence → version
 * - Gene extraction from dreams, concepts, skills, feedback
 * - Vector search via sqlite-vec with NVIDIA embeddings
 */

import { createDatabaseAdapter } from "../database/factory.js";
import { GeneUpsertPersistenceAdapter } from "../database/adapters/geneUpsertPersistence.js";
import { logger } from "../utils/logger.js";
import { generateEmbedding } from "./embeddingService.js";
import { upsertGene as executeGeneUpsert } from "./geneUpsertUseCase.js";
import {
  mergeGenesOperation,
  mutateGeneOperation,
  retireGenesOperation,
  splitGeneOperation,
} from "./genomeEvolution.js";
import {
  formatSkillPromptFromGene,
  inheritProjectGenesOperation,
} from "./genomeInheritance.js";
import {
  GENOME_SELECT_COLUMNS,
  createPrefixedId,
  fetchGenesByVectorMatches,
  getTenantId,
  incrementGeneUsageInBackground,
  mapRowToGeneRecord,
  withGenomeConnection,
  type ExtractRequest,
  type GeneInput,
  type GeneRecord,
  type GeneSearchResult,
} from "./genomeShared.js";

export {
  getTenantId,
  type ExtractRequest,
  type GeneInput,
  type GeneRecord,
  type GeneSearchResult,
} from "./genomeShared.js";

// ─── Service ─────────────────────────────────────────────────
export class GenomeService {
  /**
   * Create or update a Gene.
   */
  static async upsertGene(input: GeneInput): Promise<string> {
    return withGenomeConnection(async (connection) => {
      return executeGeneUpsert(input, {
        persistence: new GeneUpsertPersistenceAdapter(connection),
        getTenantId,
        generateEmbedding: (text) => generateEmbedding(text, "query"),
        logInfo: (message) => logger.info(message),
        createId: (prefix) => createPrefixedId(prefix),
      });
    });
  }

  /**
   * Search genes by semantic similarity.
   */
  static async searchGenes(
    query: string,
    options: { project?: string; category?: string; limit?: number } = {},
  ): Promise<GeneSearchResult[]> {
    return withGenomeConnection(async (connection) => {
      const { project, category, limit = 20 } = options;
      const tenantId = getTenantId();

      const embedding = await generateEmbedding(query, "query");
      if (!embedding) return [];

      let filterSql = "status = 'active'";
      const filterBinds: Record<string, unknown> = {};
      if (project) {
        filterSql += ` AND project = :project`;
        filterBinds.project = project;
      }
      if (category) {
        filterSql += ` AND category = :category`;
        filterBinds.category = category;
      }

      const tableSubquery = `(SELECT * FROM codeatlas_genome WHERE ${filterSql}) tbl`;
      const db = createDatabaseAdapter();
      await db.connect();
      const searchResults = await db.searchVector(
        tableSubquery,
        embedding,
        limit,
        tenantId,
        filterBinds,
      );

      const { genes } = await fetchGenesByVectorMatches(connection, searchResults, tenantId);
      if (genes.length > 0) {
        incrementGeneUsageInBackground(
          genes.map((g) => g.id),
          getTenantId(),
        );
      }

      return genes;
    });
  }

  /**
   * Get a single gene by ID.
   */
  static async getGene(id: string): Promise<GeneRecord | null> {
    return withGenomeConnection(async (connection) => {
      const result = await connection.execute<unknown[]>(
        `SELECT ${GENOME_SELECT_COLUMNS}
         FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
        { id, tenantId: getTenantId() },
      );

      if (!result.rows || result.rows.length === 0) return null;
      return mapRowToGeneRecord(result.rows[0]);
    });
  }

  /**
   * Extract genes from existing Dreams or Concepts.
   */
  static async extractGene(req: ExtractRequest): Promise<string> {
    return withGenomeConnection(async (connection) => {
      let content: string;
      let memoryType = "lesson";

      if (req.sourceType === "dream") {
        const dreams = await connection.execute<unknown[]>(
          `SELECT id, content, memory_type, project FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
          { id: req.sourceId, tenantId: getTenantId() },
        );
        if (!dreams.rows || dreams.rows.length === 0)
          throw new Error("Dream not found");
        const d = dreams.rows[0];
        content = String(d[1]);
        memoryType = String(d[2]);
        req.project = req.project || String(d[3]);
      } else if (req.sourceType === "concept") {
        const concepts = await connection.execute<unknown[]>(
          `SELECT id, label, description, project FROM codeatlas_concepts WHERE id = :id AND tenant_id = :tenantId`,
          { id: req.sourceId, tenantId: getTenantId() },
        );
        if (!concepts.rows || concepts.rows.length === 0)
          throw new Error("Concept not found");
        const c = concepts.rows[0];
        content = `${String(c[1])}: ${String(c[2])}`;
        req.project = req.project || String(c[3]);
      } else {
        throw new Error(`Unsupported source type: ${req.sourceType}`);
      }

      let geneCategory: "immune" | "pattern" | "lesson" = "lesson";
      if (memoryType === "MISTAKE") {
        geneCategory = "immune";
      } else if (memoryType === "PATTERN") {
        geneCategory = "pattern";
      }

      return this.upsertGene({
        name: this.generateGeneName(content),
        description: content.slice(0, 300),
        problem: this.extractProblem(content),
        solution: this.extractSolution(content),
        architecture: "",
        category: geneCategory,
        project: req.project,
        sourceType: req.sourceType,
        sourceId: req.sourceId,
        confidence: 0.5,
      });
    });
  }

  // ─── Heuristic helpers ──────────────────────────────────
  private static generateGeneName(content: string): string {
    const firstLine = content.split("\n")[0].slice(0, 80).trim();
    return firstLine || "Untitled Gene";
  }

  private static extractProblem(content: string): string {
    const lines = content.split("\n");
    const problemIdx = lines.findIndex(
      (l) => l.toLowerCase().includes("problem") || l.startsWith("Task:"),
    );
    return problemIdx >= 0
      ? lines
          .slice(problemIdx, Math.min(problemIdx + 3, lines.length))
          .join("\n")
      : content.slice(0, 200);
  }

  private static extractSolution(content: string): string {
    const lines = content.split("\n");
    const solutionIdx = lines.findIndex(
      (l) =>
        l.toLowerCase().includes("solution") ||
        l.toLowerCase().includes("fix") ||
        l.startsWith("Learnings:"),
    );
    return solutionIdx >= 0
      ? lines
          .slice(solutionIdx, Math.min(solutionIdx + 5, lines.length))
          .join("\n")
      : content.slice(0, 300);
  }

  // ════════════════════════════════════════════════════════
  // Phase 4: Evolution Engine
  // ════════════════════════════════════════════════════════

  static async mergeGenes(
    geneIds: string[],
    targetName: string,
    project: string,
  ): Promise<string> {
    return mergeGenesOperation(geneIds, targetName, project, (input) => this.upsertGene(input));
  }

  static async splitGene(
    sourceGeneId: string,
    childNames: string[],
    project: string,
  ): Promise<string[]> {
    return splitGeneOperation(sourceGeneId, childNames, project, (input) => this.upsertGene(input));
  }

  static async mutateGene(
    geneId: string,
    improvements: {
      description?: string;
      solution?: string;
      success?: boolean;
    },
    _project: string,
  ): Promise<string> {
    return mutateGeneOperation(geneId, improvements);
  }

  static async retireGenes(geneIds: string[]): Promise<number> {
    return retireGenesOperation(geneIds);
  }

  // ════════════════════════════════════════════════════════
  // Phase 5: Immune System — CRISPR-inspired failure prevention
  // ════════════════════════════════════════════════════════

  static async scanImmuneGenes(
    problem: string,
    project?: string,
  ): Promise<GeneRecord[]> {
    return withGenomeConnection(async (connection) => {
      const tenantId = getTenantId();

      const embedding = await generateEmbedding(problem, "query");
      if (!embedding) return [];

      let filterSql = "status = 'active'";
      const filterBinds: Record<string, unknown> = {};
      if (project) {
        filterSql += ` AND project = :project`;
        filterBinds.project = project;
      }
      filterSql += ` AND (category = 'immune' OR category = 'pattern' OR category = 'lesson')`;
      filterSql += ` AND (confidence > 0.2 OR problem LIKE '%immune%' OR problem LIKE '%prevent%' OR problem LIKE '%failure%')`;

      const tableSubquery = `(SELECT * FROM codeatlas_genome WHERE ${filterSql}) tbl`;
      const db = createDatabaseAdapter();
      await db.connect();
      const limit = 5;
      const searchResults = await db.searchVector(
        tableSubquery,
        embedding,
        limit,
        tenantId,
        filterBinds,
      );

      const { genes } = await fetchGenesByVectorMatches(connection, searchResults, tenantId);
      return genes.map(({ score: _score, ...rest }) => rest);
    });
  }

  static async createImmuneGene(
    problem: string,
    failureDescription: string,
    prevention: string,
    project: string,
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
      confidence: 0.7,
    });
  }

  static async buildImmuneContext(
    problem: string,
    project?: string,
  ): Promise<string> {
    const genes = await this.scanImmuneGenes(problem, project);
    if (genes.length === 0) return "";

    const parts = ["\n# ⚠️ Immune System: Previously encountered failures\n"];
    for (const g of genes) {
      parts.push(
        `### ${g.name}`,
        `**Failure**: ${g.problem}`,
        `**Prevention**: ${g.solution}`,
        `**Confidence**: ${(g.confidence * 100).toFixed(0)}% | Success rate: ${(g.successRate * 100).toFixed(0)}%\n`,
      );
    }
    parts.push("⚠️ Apply these preventions before proceeding\n");
    return parts.join("\n");
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 7: Multi-Repository Intelligence & Skill Generation
  // ═══════════════════════════════════════════════════════════

  static async recommendGenes(
    context: string,
    project?: string,
    limit = 10,
    minConfidence = 0.3,
  ): Promise<GeneSearchResult[]> {
    return withGenomeConnection(async (connection) => {
      const tenantId = getTenantId();
      const embedding = await generateEmbedding(context, "query");
      if (!embedding) return [];

      let filterSql = `status = 'active' AND confidence >= :minConfidence`;
      const filterBinds: Record<string, unknown> = { minConfidence };
      if (project) {
        filterSql += ` AND project = :project`;
        filterBinds.project = project;
      }

      const tableSubquery = `(SELECT * FROM codeatlas_genome WHERE ${filterSql}) tbl`;
      const db = createDatabaseAdapter();
      await db.connect();
      const searchResults = await db.searchVector(
        tableSubquery,
        embedding,
        limit,
        tenantId,
        filterBinds,
      );

      const { genes } = await fetchGenesByVectorMatches(connection, searchResults, tenantId);
      return genes;
    });
  }

  static async generateSkillFromGene(geneId: string): Promise<string | null> {
    const gene = await this.getGene(geneId);
    if (!gene) return null;

    const formatted = formatSkillPromptFromGene(gene);
    incrementGeneUsageInBackground([geneId], getTenantId());
    return formatted;
  }

  static async inheritProjectGenes(
    newProject: string,
    context: string,
    sourceProjects?: string[],
    limit = 20,
  ): Promise<{ inherited: number; genes: GeneSearchResult[] }> {
    return inheritProjectGenesOperation(newProject, context, sourceProjects, limit);
  }

  // ═══════════════════════════════════════════════════════════
  // Skill Store Methods (Cloud-backed skill persistence)
  // ═══════════════════════════════════════════════════════════

  static async getGeneByNameAndCategory(
    name: string,
    category: string,
  ): Promise<GeneSearchResult | null> {
    try {
      return await withGenomeConnection(async (connection) => {
        const result = await connection.execute<unknown[]>(
          `SELECT ${GENOME_SELECT_COLUMNS}
           FROM codeatlas_genome
           WHERE tenant_id = :tenantId AND name = :name AND category = :cat AND status = 'active'
           LIMIT 1`,
          { tenantId: getTenantId(), name, cat: category },
        );
        const row = result.rows?.[0];
        if (!row) return null;
        return {
          ...mapRowToGeneRecord(row),
          score: 1,
        };
      });
    } catch (err) {
      logger.error(`getGeneByNameAndCategory failed: ${name}/${category}`, err);
      return null;
    }
  }

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
      confidence: input.confidence ?? 0.5,
    });
    const created = await this.getGene(geneId);
    if (!created) throw new Error(`Gene created but not found: ${geneId}`);
    return created;
  }

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
    },
  ): Promise<void> {
    try {
      await withGenomeConnection(async (connection) => {
        const sets: string[] = [];
        const binds: Record<string, unknown> = {
          id: geneId,
          tenantId: getTenantId(),
        };
        const fieldMapping: ReadonlyArray<[keyof typeof fields, string, string, (val: unknown) => unknown]> = [
          ["name", "name = :name", "name", (v) => v],
          ["description", "description = :desc", "desc", (v) => v],
          ["problem", "problem = :problem", "problem", (v) => v],
          ["solution", "solution = :solution", "solution", (v) => v],
          ["architecture", "architecture = :arch", "arch", (v) => v],
          ["category", "category = :cat", "cat", (v) => v],
          ["dependencies", "dependencies = :deps", "deps", (v) => JSON.stringify(v)],
          ["confidence", "confidence = :conf", "conf", (v) => v],
          ["version", "version = :ver", "ver", (v) => v],
        ];
        for (const [key, clause, bindKey, transform] of fieldMapping) {
          if (fields[key] !== undefined) {
            sets.push(clause);
            binds[bindKey] = transform(fields[key]);
          }
        }
        sets.push("updated_at = CURRENT_TIMESTAMP");

        await this.addUpdatedEmbedding(fields, sets, binds);

        if (sets.length === 1) return;
        const sql = `UPDATE codeatlas_genome SET ${sets.join(", ")} WHERE id = :id AND tenant_id = :tenantId`;
        await connection.execute(sql, binds, { autoCommit: true });
      });
    } catch (err) {
      logger.error(`updateGene failed for ${geneId}`, err);
      throw err;
    }
  }

  private static async addUpdatedEmbedding(
    fields: { name?: string; description?: string; solution?: string },
    sets: string[],
    binds: Record<string, unknown>,
  ): Promise<void> {
    const shouldReEmbed =
      fields.name !== undefined ||
      fields.description !== undefined ||
      fields.solution !== undefined;
    if (shouldReEmbed) {
      const embedText =
        `${fields.name || ""} ${fields.description || ""} ${fields.solution || ""}`.trim();
      if (embedText) {
        const embedding = await generateEmbedding(embedText, "passage");
        if (embedding) {
          sets.push("embedding = :emb");
          binds.emb = new Uint8Array(new Float32Array(embedding).buffer);
        }
      }
    }
  }
}
