/**
 * Consolidation Engine — AI Second Brain
 *
 * Deduplicates similar dreams, extracts concepts, updates knowledge base.
 * Designed to run both on-demand (API) and as a nightly cron job.
 *
 * NOTE: Oracle `execute()` returns rows as `any[][]` (array of arrays).
 * All row access uses positional indexes, not property names.
 */

import { randomUUID } from "node:crypto";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";

// Row index helpers for Oracle queries
const R_IDX = Object.freeze({
  ID: 0, CONTENT: 1, EMBEDDING: 2, IMPORTANCE: 3,
  MEMORY_TYPE: 4, PROJECT: 5, LABEL: 6, DESCRIPTION: 7,
  CATEGORY: 8, CONFIDENCE: 9, EVIDENCE_COUNT: 10, STATUS: 11,
});

export interface ConsolidationJob {
  project?: string;
  provider?: string;
  operations: ("dedup" | "extract_concepts" | "score")[];
}

export interface ConsolidationReport {
  id: string;
  jobType: string;
  dreamsProcessed: number;
  dreamsMerged: number;
  conceptsCreated: number;
  errors: string[];
}

export class ConsolidationEngine {
  /**
   * Run a consolidation job.
   */
  async run(job: ConsolidationJob): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      id: randomUUID(),
      jobType: "consolidation",
      dreamsProcessed: 0,
      dreamsMerged: 0,
      conceptsCreated: 0,
      errors: [],
    };

    for (const op of job.operations) {
      try {
        switch (op) {
          case "dedup":
            await this.dedupDreams(job.project, job.provider, report);
            break;
          case "extract_concepts":
            await this.extractConcepts(job.project, job.provider, report);
            break;
          case "score":
            await this.scoreRelevance(report);
            break;
        }
      } catch (err) {
        report.errors.push(`[${op}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info(
      `[Consolidation] Done: ${report.dreamsMerged} merged, ${report.conceptsCreated} concepts created`
    );
    return report;
  }

  /**
   * Find and merge duplicate dreams (cosine similarity > 0.85).
   * Keeps the dream with higher importance, merges metadata.
   */
  private async dedupDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const conditions = ["tenant_id = :tenantId"];
      const binds: Record<string, any> = { tenantId };
      if (project) { conditions.push("project = :project"); binds.project = project; }
      if (provider) { conditions.push("provider = :provider"); binds.provider = provider; }
      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      // Get all non-consolidated dreams sorted by importance DESC
      const dreams = await connection.execute<any[]>(
        `SELECT id, content, embedding, importance, memory_type, project
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );
      const rows = dreams.rows || [];
      report!.dreamsProcessed = rows.length;

      if (rows.length < 2) {
        logger.info(`[Consolidation] Only ${rows.length} dreams — skipping dedup`);
        return;
      }

      // Group by project to avoid cross-project false positives
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(row[R_IDX.PROJECT] || "default");
        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let merged = 0;
      for (const [, group] of byProject) {
        const toRemove: string[] = [];

        for (let i = 0; i < group.length; i++) {
          if (toRemove.includes(String(group[i][R_IDX.ID]))) continue;

          for (let j = i + 1; j < group.length; j++) {
            if (toRemove.includes(String(group[j][R_IDX.ID]))) continue;

            // Cosine similarity on embeddings (both must exist)
            const embI = group[i][R_IDX.EMBEDDING];
            const embJ = group[j][R_IDX.EMBEDDING];
            if (!embI || !embJ) continue;

            // Note: Pass Float32Array directly instead of Array.from to avoid GC overhead in nested loops.
            // If embedding is not a Float32Array, pass original value to preserve behavior.
            const similarity = this.cosineSimilarity(
              embI instanceof Float32Array ? embI : (Array.isArray(embI) ? embI : []),
              embJ instanceof Float32Array ? embJ : (Array.isArray(embJ) ? embJ : [])
            );

            if (similarity > 0.85) {
              // Merge: keep the one with higher importance
              const keepIdx = Number(group[i][R_IDX.IMPORTANCE]) >= Number(group[j][R_IDX.IMPORTANCE]) ? i : j;
              const removeIdx = keepIdx === i ? j : i;
              toRemove.push(String(group[removeIdx][R_IDX.ID]));
            }
          }
        }

        // Batch delete duplicate concepts using executeMany for N+1 avoidance.
        if (toRemove.length > 0) {
          try {
            const binds = toRemove.map((id) => ({ id, tenantId }));
            await connection.executeMany(
              `DELETE FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
              binds as any,
              { autoCommit: true }
            );
            merged += toRemove.length;
          } catch {
            // skip delete errors
          }
        }
      }

      report!.dreamsMerged = merged;
      logger.info(`[Consolidation] Dedup: removed ${merged} duplicate dreams`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Extract abstract concepts from dream clusters.
   * For each project, groups related dreams and generates concept entries.
   */
  private async extractConcepts(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      const conditions = ["tenant_id = :tenantId"];
      const binds: Record<string, any> = { tenantId };
      if (project) { conditions.push("project = :project"); binds.project = project; }
      if (provider) { conditions.push("provider = :provider"); binds.provider = provider; }
      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      const dreams = await connection.execute<any[]>(
        `SELECT id, content, memory_type, project, importance
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );
      const rows = dreams.rows || [];

      if (rows.length === 0) return;

      // Group by project for concept extraction
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(row[R_IDX.PROJECT] || "default");
        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let conceptsCreated = 0;

      // Phase 1: Compute embeddings and prepare concept data
      const conceptsData: any[] = [];
      for (const [proj, group] of byProject) {
        // Take top 10 highest-importance dreams per project for concept extraction
        const topDreams = group.slice(0, 10);
        const combinedContent = topDreams
          .map((d) => `[${d[R_IDX.MEMORY_TYPE]}] ${d[R_IDX.CONTENT]}`)
          .join("\n\n");

        // Generate a concept label and description from the content
        const conceptLabel = this.extractLabel(topDreams);
        const conceptDescription = combinedContent.slice(0, 1000);
        const conceptEmbedding = await generateEmbedding(conceptDescription, "passage");

        if (!conceptEmbedding || conceptEmbedding.length === 0) {
          logger.warn(`[Consolidation] No embedding for concept "${conceptLabel}", skipping`);
          continue;
        }

        conceptsData.push({
          proj,
          conceptLabel,
          conceptDescription,
          conceptEmbedding,
          sources: JSON.stringify(topDreams.map((d) => d[R_IDX.ID]))
        });
      }

      if (conceptsData.length > 0) {
        // Phase 2: Batch lookup existing concepts to avoid N+1 queries
        const existingConcepts = new Set<string>();
        const BATCH_SIZE = 50;
        for (let i = 0; i < conceptsData.length; i += BATCH_SIZE) {
          const chunk = conceptsData.slice(i, i + BATCH_SIZE);
          const orConditions: string[] = [];
          const bindsForSelect: Record<string, any> = { tenantId };

          chunk.forEach((c, idx) => {
            bindsForSelect[`l${idx}`] = c.conceptLabel;
            bindsForSelect[`p${idx}`] = c.proj;
            orConditions.push(`(label = :l${idx} AND project = :p${idx})`);
          });

          const query = `SELECT label, project FROM codeatlas_concepts WHERE tenant_id = :tenantId AND (${orConditions.join(' OR ')})`;
          const existing = await connection.execute<any[]>(query, bindsForSelect);

          if (existing.rows) {
            for (const row of existing.rows) {
              existingConcepts.add(`${row[0]}::${row[1]}`); // label::project
            }
          }
        }

        // Phase 3: Split into updates and inserts
        const toUpdate: any[] = [];
        const toInsert: any[] = [];

        for (const data of conceptsData) {
          const key = `${data.conceptLabel}::${data.proj}`;
          if (existingConcepts.has(key)) {
            toUpdate.push({
              label: data.conceptLabel,
              proj: data.proj,
              desc: data.conceptDescription,
              tenantId
            });
          } else {
            toInsert.push({
              id: `concept-${randomUUID().slice(0, 8)}`,
              label: data.conceptLabel,
              desc: data.conceptDescription,
              embedding: new Float32Array(data.conceptEmbedding),
              proj: data.proj,
              sources: data.sources,
              tenantId
            });
            conceptsCreated++;
          }
        }

        // Phase 4: Batch execute updates and inserts
        if (toUpdate.length > 0) {
          await connection.executeMany(
            `UPDATE codeatlas_concepts
             SET description = :desc,
                 evidence_count = evidence_count + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE label = :label AND project = :proj AND tenant_id = :tenantId`,
            toUpdate,
            { autoCommit: true }
          );
        }

        if (toInsert.length > 0) {
          await connection.executeMany(
            `INSERT INTO codeatlas_concepts (id, label, description, category, embedding, project, confidence, source_ids, evidence_count, status, tenant_id)
             VALUES (:id, :label, :desc, 'lesson', :embedding, :proj, 0.50, :sources, 1, 'active', :tenantId)`,
            toInsert,
            { autoCommit: true }
          );
        }

      }


      report!.conceptsCreated = conceptsCreated;
      logger.info(`[Consolidation] Extracted ${conceptsCreated} concepts`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Bayesian confidence scoring:
   * - Each evidence/access event updates confidence via Bayesian update
   * - Confidence decays exponentially with time (0.995 per day)
   * - Archived concepts get reduced confidence
   * - access_count and last_accessed_at are tracked externally (via concepts/search API)
   */
  private async scoreRelevance(report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";
      await setSessionContext(connection, tenantId);

      // Ensure access_count column exists (migration-safe)
      try {
        await connection.execute(`ALTER TABLE codeatlas_concepts ADD (access_count NUMBER DEFAULT 0, last_accessed_at TIMESTAMP)`);
      } catch { /* column exists */ }

      // 1. Base decay: confidence *= 0.995 per day since last_accessed_at, 0.997 if never accessed
      const decayResult = await connection.execute(
        `UPDATE codeatlas_concepts
         SET confidence = confidence * CASE
           WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - last_accessed_at)))
           ELSE POWER(0.997, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - created_at)))
         END
         WHERE status = 'active' AND tenant_id = :tenantId`,
        { tenantId },
        { autoCommit: true }
      );

      // 2. Evidence boost: each evidence_count beyond 1 gives log-space boost
      //    Bayesian: new_conf = (prior * evidence) / (prior * evidence + (1-prior))
      //    Simplified: confidence += 0.05 * log2(evidence_count) capped at 0.25
      await connection.execute(
        `UPDATE codeatlas_concepts
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.05 * LOG(2, evidence_count + 1)
         ))
         WHERE status = 'active' AND evidence_count > 1 AND tenant_id = :tenantId`,
        { tenantId },
        { autoCommit: true }
      );

      // 3. Access bonus: each access_count reinforces confidence
      //    Bayesian: additional 0.02 * log2(access_count + 1) capped at 0.15
      await connection.execute(
        `UPDATE codeatlas_concepts
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.02 * LOG(2, access_count + 1)
         ))
         WHERE status = 'active' AND access_count > 0 AND tenant_id = :tenantId`,
        { tenantId },
        { autoCommit: true }
      );

      // 4. Archive very low confidence concepts (not reinforced for long time)
      const archiveResult = await connection.execute(
        `UPDATE codeatlas_concepts
         SET status = 'archived'
         WHERE confidence < 0.10 AND status = 'active' AND tenant_id = :tenantId`,
        { tenantId },
        { autoCommit: true }
      );

      logger.info(
        `[Consolidation] Score: decay applied, ${(archiveResult.rowsAffected || 0)} archived`
      );
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Cosine similarity between two vectors (either standard arrays or Float32Array).
   */
  private cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Extract a concept label from the top dreams of a cluster.
   * Prioritizes PATTERN and KNOWLEDGE types, then most common memory_type.
   */
  private extractLabel(dreams: any[]): string {
    // Try to find a PATTERN or KNOWLEDGE dream with the most descriptive content
    for (const type of ["PATTERN", "KNOWLEDGE", "MISTAKE"]) {
      const match = dreams.find((d) => d[R_IDX.MEMORY_TYPE] === type);
      if (match) {
        const content = String(match.CONTENT || "");
        return content.length > 80 ? content.slice(0, 80) : content;
      }
    }
    // Fallback: use first dream's beginning
    const first = String(dreams[0]?.CONTENT || "Untitled Concept");
    return first.length > 80 ? first.slice(0, 80) : first;
  }
}

export const consolidationEngine = new ConsolidationEngine();
