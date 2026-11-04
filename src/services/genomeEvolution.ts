import type { AdapterConnection } from "../database/connection.js";
import { buildInClause } from "../database/utils.js";
import { logger } from "../utils/logger.js";
import {
  createPrefixedId,
  getTenantId,
  rowValue,
  withGenomeConnection,
  type GeneInput,
} from "./genomeShared.js";

export async function mergeGenesOperation(
  geneIds: string[],
  targetName: string,
  project: string,
  upsertGeneFn: (input: GeneInput) => Promise<string>,
): Promise<string> {
  if (geneIds.length < 2) throw new Error("Need at least 2 genes to merge");

  return withGenomeConnection(async (connection) => {
    // Bound reads as well as writes; one unbounded SELECT would defeat batching.
    const sourceIds = [...new Set(geneIds)];
    const genes: Record<string, unknown>[] = [];
    const batchSize = 900;
    const tenantId = getTenantId();
    for (let offset = 0; offset < sourceIds.length; offset += batchSize) {
      const { clause, binds } = buildInClause(sourceIds.slice(offset, offset + batchSize), { tenantId });
      const result = await connection.execute<Record<string, unknown>>( // NOSONAR
        `SELECT id, name, description, problem, solution, architecture,
              category, confidence, version, embedding
         FROM codeatlas_genome WHERE tenant_id = :tenantId AND id IN (${clause})`,
        binds,
      );
      genes.push(...(result.rows || []));
    }
    if (genes.length < 2 || genes.length !== sourceIds.length) {
      throw new Error("Not all genes found");
    }

    const combinedProblem = genes
      .map((g) => String(rowValue(g, "problem") || ""))
      .join("\n\n");
    const combinedSolution = genes
      .map((g) => String(rowValue(g, "solution") || ""))
      .join("\n\n");
    const avgConfidence =
      genes.reduce((s, g) => s + Number(rowValue(g, "confidence")), 0) /
      genes.length;

    const geneId = await upsertGeneFn({
      name: targetName,
      description: `Merged from ${genes.length} genes:\n${genes.map((g) => String(rowValue(g, "name"))).join(", ")}`,
      problem: combinedProblem,
      solution: combinedSolution,
      architecture: String(rowValue(genes[0], "architecture") || ""),
      category: String(rowValue(genes[0], "category")),
      project,
      sourceType: "manual",
      sourceId: geneIds.join(","),
      dependencies: geneIds,
      confidence: avgConfidence,
    });

    if (genes.length > 0) {
      const updateIds = genes.map((g) => String(rowValue(g, "id")));
      for (let k = 0; k < updateIds.length; k += batchSize) {
        const chunk = updateIds.slice(k, k + batchSize);
        const { clause, binds } = buildInClause(chunk, { tenantId });
        await connection.execute( // NOSONAR
          `UPDATE codeatlas_genome SET status = 'merged', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = :tenantId AND id IN (${clause})`,
          binds,
          { autoCommit: true },
        );
      }

      const insertBinds = genes.map((g) => ({
        id: createPrefixedId("rel"),
        src: String(rowValue(g, "id")),
        tgt: geneId,
      }));
      await connection.executeMany(
        `INSERT INTO gene_relationships (id, source_id, target_id, relationship, weight)
         VALUES (:id, :src, :tgt, 'merged_into', 1.0)`,
        insertBinds,
        { autoCommit: true },
      );
    }

    logger.info(
      `[Genome] Merged ${geneIds.length} genes → "${targetName}" (${geneId})`,
    );
    return geneId;
  });
}

export async function splitGeneOperation(
  sourceGeneId: string,
  childNames: string[],
  project: string,
  upsertGeneFn: (input: GeneInput) => Promise<string>,
): Promise<string[]> {
  if (childNames.length < 2)
    throw new Error("Need at least 2 child gene names");
  if (childNames.length > 20)
    throw new Error("Cannot split gene into more than 20 child genes");

  return withGenomeConnection(async (connection: AdapterConnection) => {
    const result = await connection.execute<unknown[]>(
      `SELECT id, name, description, problem, solution, architecture, category, confidence
       FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
      { id: sourceGeneId, tenantId: getTenantId() },
    );

    if (!result.rows || result.rows.length === 0)
      throw new Error("Source gene not found");
    const g = result.rows[0];

    const sourceConfidence = Number(rowValue(g, "confidence"));
    const solutionLines = String(rowValue(g, "solution") || "").split("\n");
    const sourceName = String(rowValue(g, "name"));

    const childIds: string[] = [];
    const relBinds: Record<string, unknown>[] = [];
    for (let i = 0; i < childNames.length; i++) {
      const sliceStart = Math.floor(i * (solutionLines.length / childNames.length));
      const sliceEnd = Math.floor((i + 1) * (solutionLines.length / childNames.length));
      const childId = await upsertGeneFn({ // NOSONAR
        name: childNames[i],
        description: `Split from: ${sourceName} (part ${i + 1}/${childNames.length})`,
        problem: String(rowValue(g, "problem") || ""),
        solution:
          solutionLines.slice(sliceStart, sliceEnd).join("\n") ||
          `Sub-gene ${i + 1} of ${sourceName}`,
        architecture: String(rowValue(g, "architecture") || ""),
        category: String(rowValue(g, "category")),
        project,
        sourceType: "manual",
        sourceId: sourceGeneId,
        confidence: sourceConfidence * 0.8,
      });
      childIds.push(childId);

      relBinds.push({
        id: createPrefixedId("rel"),
        src: sourceGeneId,
        tgt: childId,
      });
    }

    if (relBinds.length > 0) {
      const relResult = await connection.executeMany(
        `INSERT INTO gene_relationships (id, source_id, target_id, relationship, weight)
         VALUES (:id, :src, :tgt, 'split_from', 0.8)`,
        relBinds,
        { autoCommit: true, batchErrors: true },
      );
      if (relResult.batchErrors && relResult.batchErrors.length > 0) {
        logger.error(
          `[Genome] Failed to insert relationships during splitGene: ${relResult.batchErrors.map((e) => e.message).join(", ")}`,
        );
      }
    }

    await connection.execute(
      `UPDATE codeatlas_genome SET status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
      { id: sourceGeneId, tenantId: getTenantId() },
      { autoCommit: true },
    );

    logger.info(
      `[Genome] Split "${sourceName}" → ${childNames.length} children`,
    );
    return childIds;
  });
}

export async function mutateGeneOperation(
  geneId: string,
  improvements: {
    description?: string;
    solution?: string;
    success?: boolean;
  },
): Promise<string> {
  return withGenomeConnection(async (connection) => {
    const result = await connection.execute<unknown[]>(
      `SELECT id, name, problem, solution, confidence, version, success_rate, usage_count
       FROM codeatlas_genome WHERE id = :id AND tenant_id = :tenantId`,
      { id: geneId, tenantId: getTenantId() },
    );

    if (!result.rows || result.rows.length === 0)
      throw new Error("Gene not found");
    const g = result.rows[0];

    const oldConfidence = Number(rowValue(g, "confidence"));
    const oldVersion = Number(rowValue(g, "version"));
    const oldSuccessRate = Number(rowValue(g, "success_rate"));
    const oldUsage = Number(rowValue(g, "usage_count"));

    let newConfidence = oldConfidence;
    let newSuccessRate = oldSuccessRate;

    if (improvements.success === true) {
      newConfidence = Math.min(
        0.99,
        oldConfidence + 0.05 * Math.log2(2 + (oldUsage || 0)),
      );
      newSuccessRate = (oldSuccessRate * oldUsage + 1) / (oldUsage + 1);
    } else if (improvements.success === false) {
      newConfidence = Math.max(0.05, oldConfidence * 0.85);
      newSuccessRate =
        (oldSuccessRate * oldUsage) / Math.max(1, oldUsage + 1);
    }

    await connection.execute(
      `INSERT INTO gene_mutations (id, gene_id, old_version, new_version, changes)
       VALUES (:id, :geneId, :oldVer, :newVer, :changes)`,
      {
        id: createPrefixedId("mut"),
        geneId,
        oldVer: oldVersion,
        newVer: oldVersion + 1,
        changes: JSON.stringify({
          ...improvements,
          oldConfidence,
          newConfidence,
        }),
      },
      { autoCommit: true },
    );

    const updates: string[] = [];
    const binds: Record<string, unknown> = {
      id: geneId,
      tenantId: getTenantId(),
    };

    if (improvements.description) {
      updates.push("description = :desc");
      binds.desc = improvements.description;
    }
    if (improvements.solution) {
      updates.push("solution = :sol");
      binds.sol = improvements.solution;
    }
    updates.push(
      "confidence = :conf",
      "version = version + 1",
      "success_rate = :sr",
      "evolution_score = evolution_score + 1",
      "updated_at = CURRENT_TIMESTAMP",
    );
    binds.conf = newConfidence;
    binds.sr = newSuccessRate;

    await connection.execute(
      `UPDATE codeatlas_genome SET ${updates.join(", ")} WHERE id = :id AND tenant_id = :tenantId`,
      binds,
      { autoCommit: true },
    );

    logger.info(
      `[Genome] Mutated "${String(rowValue(g, "name"))}" (v${oldVersion}→v${oldVersion + 1}, confidence: ${oldConfidence}→${newConfidence.toFixed(2)})`,
    );
    return geneId;
  });
}

export async function retireGenesOperation(geneIds: string[]): Promise<number> {
  return withGenomeConnection(async (connection) => {
    let count = 0;
    if (geneIds.length > 0) {
      const BATCH_CHUNK_SIZE = 900;
      for (let k = 0; k < geneIds.length; k += BATCH_CHUNK_SIZE) {
        const chunk = geneIds.slice(k, k + BATCH_CHUNK_SIZE);
        const { clause, binds } = buildInClause(chunk, { tenantId: getTenantId() });
        const result = await connection.execute( // NOSONAR
          `UPDATE codeatlas_genome SET status = 'retired', updated_at = CURRENT_TIMESTAMP
           WHERE status != 'retired' AND tenant_id = :tenantId AND id IN (${clause})`,
          binds,
          { autoCommit: true },
        );
        count += result.rowsAffected || 0;
      }
    }

    logger.info(`[Genome] Retired ${count} genes`);
    return count;
  });
}
