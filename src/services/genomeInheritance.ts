import type { AdapterConnection } from "../database/connection.js";
import { createDatabaseAdapter } from "../database/factory.js";
import { buildInClause } from "../database/utils.js";
import { generateEmbedding } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import {
  createPrefixedId,
  fetchGenesByVectorMatches,
  getTenantId,
  rowValue,
  withGenomeConnection,
  type GeneRecord,
  type GeneSearchResult,
} from "./genomeShared.js";

export function formatSkillPromptFromGene(gene: GeneRecord): string {
  const parts: string[] = [
    `# Skill: ${gene.name}\n`,
    `**Description**: ${gene.description}\n`,
    `## Problem\n${gene.problem}\n`,
    `## Solution\n${gene.solution}\n`,
  ];
  if (gene.architecture) {
    parts.push(`## Architecture\n${gene.architecture}\n`);
  }
  parts.push(
    `## Metadata`,
    `- Category: ${gene.category}`,
    `- Confidence: ${(gene.confidence * 100).toFixed(0)}%`,
    `- Version: ${gene.version}`,
    `- Usage count: ${gene.usageCount}`,
    `- Success rate: ${(gene.successRate * 100).toFixed(0)}%\n`,
    [
      "## Instructions",
      "Apply this knowledge when encountering similar problems.",
      "1. Analyze the current context against the problem description",
      "2. If matched, apply the solution pattern",
      "3. Adapt to current project specifics",
      "4. Report outcome to improve the gene's success rate\n",
    ].join("\n"),
  );
  if (gene.dependencies && gene.dependencies.length > 0) {
    parts.push(`\n**Depends on**: ${gene.dependencies.join(", ")}`);
  }
  return parts.join("\n");
}

export async function inheritProjectGenesOperation(
  newProject: string,
  context: string,
  sourceProjects?: string[],
  limit = 20,
): Promise<{ inherited: number; genes: GeneSearchResult[] }> {
  try {
    return await withGenomeConnection(async (connection) => {
      const tenantId = getTenantId();
      const embedding = await generateEmbedding(context, "query");
      if (!embedding) return { inherited: 0, genes: [] };

      const safeLimit = Math.min(limit, 50);
      let filterSql = `status = 'active'`;
      const filterBinds: Record<string, unknown> = {};

      if (sourceProjects && sourceProjects.length > 0) {
        const projBinds = sourceProjects.map((_, i) => `:proj${i}`).join(",");
        filterSql += ` AND project IN (${projBinds})`;
        sourceProjects.forEach((p, i) => {
          filterBinds[`proj${i}`] = p;
        });
      } else {
        filterSql += ` AND project != :newProject`;
        filterBinds.newProject = newProject;
      }

      const tableSubquery = `(SELECT * FROM codeatlas_genome WHERE ${filterSql}) tbl`;
      const db = createDatabaseAdapter();
      await db.connect();
      const searchResults = await db.searchVector(
        tableSubquery,
        embedding,
        safeLimit,
        tenantId,
        filterBinds,
      );

      const { genes, rows } = await fetchGenesByVectorMatches(connection, searchResults, tenantId);
      if (genes.length === 0) return { inherited: 0, genes: [] };

      const inherited = await persistInheritedGenes(connection, genes, rows, newProject, tenantId);
      return { inherited, genes };
    });
  } catch (err) {
    logger.error("inheritProjectGenes failed", err);
    return { inherited: 0, genes: [] };
  }
}

async function persistInheritedGenes(
  connection: AdapterConnection,
  genes: GeneSearchResult[],
  rows: unknown[],
  newProject: string,
  tenantId: string,
): Promise<number> {
  const nameList = genes.map((g) => g.name);
  const existingRows: unknown[][] = [];

  const chunkSize = 900;
  for (let i = 0; i < nameList.length; i += chunkSize) {
    const chunk = nameList.slice(i, i + chunkSize);
    const { clause: inClause, binds: nameBinds } = buildInClause(chunk, {
      newProject,
      tenantId: getTenantId(),
    });

    const existingQuery = await connection.execute<unknown[]>( // NOSONAR
      `SELECT id, name, version FROM codeatlas_genome WHERE name IN (${inClause}) AND project = :newProject AND tenant_id = :tenantId`,
      nameBinds,
    );
    if (existingQuery.rows) {
      existingRows.push(...existingQuery.rows);
    }
  }
  const existingMap = new Map(
    existingRows.map((r) => [
      String(r[1]),
      { id: String(r[0]), version: Number(r[2]) },
    ]),
  );

  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  const mutations: Record<string, unknown>[] = [];

  for (let i = 0; i < genes.length; i++) {
    const gene = genes[i];
    const rawEmbedding = rowValue(rows[i], "embedding");
    const existing = existingMap.get(gene.name);

    if (existing) {
      const newVersion = existing.version + 1;
      mutations.push({
        id: createPrefixedId("mut"),
        geneId: existing.id,
        oldVer: existing.version,
        newVer: newVersion,
        changes: JSON.stringify({
          description: gene.description,
          solution: gene.solution,
        }),
      });
      toUpdate.push({
        id: existing.id,
        desc: gene.description,
        problem: gene.problem,
        solution: gene.solution,
        arch: gene.architecture || "",
        cat: gene.category,
        conf: gene.confidence * 0.9,
        ver: newVersion,
        emb: rawEmbedding,
        tenantId,
      });
    } else {
      toInsert.push({
        id: createPrefixedId("gene"),
        name: gene.name,
        desc: gene.description,
        problem: gene.problem,
        solution: gene.solution,
        arch: gene.architecture || "",
        cat: gene.category,
        project: newProject,
        conf: gene.confidence * 0.9,
        emb: rawEmbedding,
        srcType: "inherited",
        srcId: gene.id,
        deps: JSON.stringify(gene.dependencies || []),
        tenantId,
      });
    }
  }

  if (mutations.length > 0) {
    await connection.executeMany(
      `INSERT INTO gene_mutations (id, gene_id, old_version, new_version, changes, created_at)
       VALUES (:id, :geneId, :oldVer, :newVer, :changes, CURRENT_TIMESTAMP)`,
      mutations,
      { autoCommit: false, batchErrors: true },
    );
  }

  if (toUpdate.length > 0) {
    await connection.executeMany(
      `UPDATE codeatlas_genome SET
       description = :desc, problem = :problem, solution = :solution,
       architecture = :arch, category = :cat, confidence = :conf,
       version = :ver, evolution_score = evolution_score + 1,
       embedding = :emb, status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE id = :id AND tenant_id = :tenantId`,
      toUpdate,
      { autoCommit: false, batchErrors: true },
    );
  }

  if (toInsert.length > 0) {
    await connection.executeMany(
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
      toInsert,
      { autoCommit: false, batchErrors: true },
    );
  }

  return toUpdate.length + toInsert.length;
}
