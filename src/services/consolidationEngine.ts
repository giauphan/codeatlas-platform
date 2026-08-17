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
import { createDatabaseAdapter } from "../database/factory.js";
import { generateEmbeddingsBatch } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import { OracleDreamingService } from "./dreamingService.js";

// Row index helpers for Oracle queries
const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.85;

const R_IDX = Object.freeze({
  ID: 0, CONTENT: 1, EMBEDDING: 2, IMPORTANCE: 3,
  MEMORY_TYPE: 4, PROJECT: 5, LABEL: 6, DESCRIPTION: 7,
  CATEGORY: 8, CONFIDENCE: 9, EVIDENCE_COUNT: 10, STATUS: 11,
});

// Row index helpers for scoreDreams Oracle queries
// Query: SELECT id, project, memory_type, embedding, confidence, created_at FROM ai_dreaming_memory
const SCORE_IDX = Object.freeze({
  ID: 0, PROJECT: 1, MEMORY_TYPE: 2, EMBEDDING: 3, CONFIDENCE: 4, CREATED_AT: 5
});

export interface ConsolidationJob {
  project?: string;
  provider?: string;
  operations: ("dedup" | "extract_concepts" | "score" | "score_dreams")[];
}

export interface ConsolidationReport {
  id: string;
  jobType: string;
  dreamsProcessed: number;
  dreamsMerged: number;
  conceptsCreated: number;
  dreamsArchived: number;
  dreamsSuperseded: number;
  invalidEmbeddingsSkipped: number;
  errors: string[];
}

export class ConsolidationEngine {

  private getVal(row: any, index: number, keyStr: string): any {
    if (!row) return undefined;
    if (row[index] !== undefined) return row[index];
    if (row[keyStr] !== undefined) return row[keyStr];
    const lowerKey = keyStr.toLowerCase();
    if (row[lowerKey] !== undefined) return row[lowerKey];
    return undefined;
  }

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
      dreamsArchived: 0,
      dreamsSuperseded: 0,
      invalidEmbeddingsSkipped: 0,
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
          case "score_dreams":
            await this.scoreDreams(job.project, job.provider, report);
            break;
        }
      } catch (err) {
        report.errors.push(`[${op}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info(
      `[Consolidation] Done: ${report.dreamsMerged} merged, ${report.conceptsCreated} concepts created, ${report.invalidEmbeddingsSkipped} embeddings skipped`
    );
    return report;
  }

  /**
   * Find and merge duplicate dreams based on high cosine similarity.
   * Keeps the dream with higher importance, merges metadata.
   */
  private async dedupDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, any> = { tenantId: authStorage.getStore()!.uid };
      if (project) { conditions.push("project = :project"); binds.project = project; }
      if (provider) { conditions.push("provider = :provider"); binds.provider = provider; }
      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : '';

      // Get all non-consolidated dreams sorted by importance DESC
      const rows = await db.query<any>(
        `SELECT id, content, embedding, importance, memory_type, project
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );
      report!.dreamsProcessed = rows.length;

      if (rows.length < 2) {
        logger.info(`[Consolidation] Only ${rows.length} dreams — skipping dedup`);
        return;
      }

      // Group by project to avoid cross-project false positives
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, R_IDX.PROJECT, 'PROJECT')  || "default");

        if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "Dedup")) {
          if (report) report.invalidEmbeddingsSkipped++;
          continue;
        }

        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let merged = 0;
      for (const [, group] of byProject) {
        const toRemove = new Set<string>();

        for (let i = 0; i < group.length; i++) {
          if (toRemove.has(String(this.getVal(group[i], R_IDX.ID, 'ID') ))) continue;
          // Embeddings validated above during preprocessing
          const embI = this.getVal(group[i], R_IDX.EMBEDDING, 'EMBEDDING') ;

          for (let j = i + 1; j < group.length; j++) {
            if (toRemove.has(String(this.getVal(group[j], R_IDX.ID, 'ID') ))) continue;

            // Cosine similarity on embeddings
            const embJ = this.getVal(group[j], R_IDX.EMBEDDING, 'EMBEDDING') ;

            const similarity = this.cosineSimilarity(embI, embJ);

            if (similarity > CONSOLIDATION_SIMILARITY_THRESHOLD) {
              // Merge: keep the one with higher importance
              const keepIdx = Number(this.getVal(group[i], R_IDX.IMPORTANCE, 'IMPORTANCE') ) >= Number(this.getVal(group[j], R_IDX.IMPORTANCE, 'IMPORTANCE') ) ? i : j;
              const removeIdx = keepIdx === i ? j : i;
              toRemove.add(String(this.getVal(group[removeIdx], R_IDX.ID, 'ID') ));

              // Early exit if the outer loop element was just marked for removal
              // (This is safe because the outer loop guarantees skipping over removed indices on subsequent iterations)
              if (removeIdx === i) break;
            }
          }
        }

        // Batch delete duplicate concepts using executeMany for N+1 avoidance.
        if (toRemove.size > 0) {
          try {
            const binds = Array.from(toRemove).map((id) => ({ id }));
            await db.executeMany(
              `DELETE FROM ai_dreaming_memory WHERE id = :id`,
              binds as any
            );
            merged += toRemove.size;
          } catch {
            // skip delete errors
          }
        }
      }

      report!.dreamsMerged = merged;
      logger.info(`[Consolidation] Dedup: removed ${merged} duplicate dreams`);
  }

  /**
   * Extract abstract concepts from dream clusters.
   * For each project, groups related dreams and generates concept entries.
   */
  private async extractConcepts(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, any> = { tenantId: authStorage.getStore()!.uid };
      if (project) { conditions.push("project = :project"); binds.project = project; }
      if (provider) { conditions.push("provider = :provider"); binds.provider = provider; }
      const whereClause = `WHERE ${conditions.join(" AND ")}`;



      const rows = await db.query<any>(
        `SELECT id, content, memory_type, project, importance
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );

      if (rows.length === 0) return;

      // Column indices for extract concepts query (different from dedup — no embedding column)
      const CX = { ID: 0, CONTENT: 1, MEMORY_TYPE: 2, PROJECT: 3, IMPORTANCE: 4 };

      // Group by project for concept extraction
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, CX.PROJECT, 'PROJECT')  || "default");
        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let conceptsCreated = 0;

      // Phase 1: Compute embeddings and prepare concept data
      const conceptsData: any[] = [];

      const intermediateData: {
        proj: string;
        conceptLabel: string;
        conceptDescription: string;
        sources: string;
      }[] = [];

      for (const [proj, group] of byProject) {
        // Take top 10 highest-importance dreams per project for concept extraction
        const topDreams = group.slice(0, 10);
        const combinedContent = topDreams
          .map((d) => `[${this.getVal(d, R_IDX.MEMORY_TYPE, 'MEMORY_TYPE') }] ${this.getVal(d, R_IDX.CONTENT, 'CONTENT') }`)
          .join("\n\n");

        // Generate a concept label and description from the content
        const conceptLabel = this.extractLabel(topDreams);
        const conceptDescription = combinedContent.slice(0, 1000);

        intermediateData.push({
          proj,
          conceptLabel,
          conceptDescription,
          sources: JSON.stringify(topDreams.map((d) => this.getVal(d, R_IDX.ID, 'ID') ))
        });
      }

      const descriptions = intermediateData.map(d => d.conceptDescription);
      // Batch embedding generation to avoid N+1 API calls.
      let batchEmbeddings: number[][] | null = null;
      if (descriptions.length > 0) {
        batchEmbeddings = await generateEmbeddingsBatch(descriptions, "passage");
      }

      if (batchEmbeddings) {
        for (let i = 0; i < intermediateData.length; i++) {
          const data = intermediateData[i];

          if (i >= batchEmbeddings.length) {
            logger.warn(`[Consolidation] Batch returned fewer embeddings than requested. Missing embedding for "${data.conceptLabel}", skipping`);
            continue;
          }

          const conceptEmbedding = batchEmbeddings[i];

          if (!conceptEmbedding || conceptEmbedding.length === 0) {
            logger.warn(`[Consolidation] No embedding for concept "${data.conceptLabel}", skipping`);
            continue;
          }

          conceptsData.push({
            ...data,
            conceptEmbedding,
          });
        }
      } else if (intermediateData.length > 0) {
        logger.warn(`[Consolidation] Batch embedding generation returned null for ${intermediateData.length} concepts, skipping`);
      }

      if (conceptsData.length > 0) {
        // Phase 2: Batch lookup existing concepts to avoid N+1 queries
        const existingConcepts = new Set<string>();
        const BATCH_SIZE = 50;
        for (let i = 0; i < conceptsData.length; i += BATCH_SIZE) {
          const chunk = conceptsData.slice(i, i + BATCH_SIZE);
          const orConditions: string[] = [];
          const bindsForSelect: Record<string, any> = {};

          chunk.forEach((c, idx) => {
            bindsForSelect[`l${idx}`] = c.conceptLabel;
            bindsForSelect[`p${idx}`] = c.proj;
            orConditions.push(`(label = :l${idx} AND project = :p${idx})`);
          });

          const query = `SELECT label, project FROM codeatlas_concepts WHERE tenant_id = :tid AND (${orConditions.join(' OR ')})`;
          bindsForSelect.tid = authStorage.getStore()!.uid;
          logger.info(`[Consolidation] Concepts lookup: ${query.substring(0, 200)}...`);
          logger.info(`[Consolidation] Concepts binds: ${JSON.stringify(bindsForSelect).substring(0, 500)}`);
          const existingRows = await db.query<any>(query, bindsForSelect);

          if (existingRows) {
            for (const row of existingRows) {
              existingConcepts.add(`${this.getVal(row, 0, 'LABEL')}::${this.getVal(row, 1, 'PROJECT')}`); // label::project
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
              v_label: data.conceptLabel,
              v_proj: data.proj,
              v_desc: data.conceptDescription,
              v_tid: authStorage.getStore()!.uid,
            });
          } else {
            toInsert.push({
              v_id: `concept-${randomUUID().slice(0, 8)}`,
              v_label: data.conceptLabel,
              v_desc: data.conceptDescription,
              v_embedding: data.conceptEmbedding,
              v_proj: data.proj,
              v_sources: data.sources,
              v_tid: authStorage.getStore()!.uid,
            });
            conceptsCreated++;
          }
        }

        // Phase 4: Batch execute updates and inserts
        if (toUpdate.length > 0) {
          logger.info(`[Consolidation] Updating ${toUpdate.length} concepts`);
          await db.executeMany(
              `UPDATE codeatlas_concepts
             SET description = :v_desc,
                 evidence_count = evidence_count + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE label = :v_label AND project = :v_proj AND tenant_id = :v_tid`,
              toUpdate
            );
        }

        if (toInsert.length > 0) {
          await db.executeMany(
              `INSERT INTO codeatlas_concepts (id, label, description, category, embedding, project, confidence, source_ids, evidence_count, status, tenant_id)
             VALUES (:v_id, :v_label, :v_desc, 'lesson', :v_embedding, :v_proj, 0.50, :v_sources, 1, 'active', :v_tid)`,
              toInsert
            );
        }

      }


      report!.conceptsCreated = conceptsCreated;
      logger.info(`[Consolidation] Extracted ${conceptsCreated} concepts`);
  }

  /**
   * Lifecycle scoring for ai_dreaming_memory — same pattern as scoreRelevance for concepts.
   *
   * 1. Time decay: confidence *= 0.995 ^ days since last access (0.997 if never accessed)
   * 2. Evidence boost: +0.05 * log2(evidence_count + 1)
   * 3. Access bonus: +0.02 * log2(access_count + 1)
   * 4. Archive: confidence < 0.10 → status = 'archived'
   * 5. Supersession: near-duplicate active dreams → older lower-confidence one gets superseded
   */
  private async scoreDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    if (!OracleDreamingService._hasLifecycleColumns) {
      logger.info("[Consolidation] Lifecycle columns missing — skipping dream scoring");
      return;
    }
    const db = createDatabaseAdapter();

      const conditions: string[] = ['tenant_id = :v_tid'];
      const binds: Record<string, any> = { v_tid: authStorage.getStore()!.uid };
      if (project) { conditions.push("project = :project"); binds.project = project; }
      if (provider) { conditions.push("provider = :provider"); binds.provider = provider; }
      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      // 1. Base decay on confidence for active dreams
      const decayResult = await db.execute(
        `UPDATE ai_dreaming_memory
         SET confidence = GREATEST(0.05, confidence * CASE
           WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - last_accessed_at)))
           ELSE POWER(0.997, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - created_at)))
         END)
         WHERE status = 'active' AND ${conditions.join(" AND ")}`,
        binds
);
      logger.info(`[Consolidation] Dream decay applied, rows affected: ${decayResult.rowsAffected ?? 0}`);

      // 2. Evidence boost
      await db.execute(
        `UPDATE ai_dreaming_memory
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.05 * LOG(2, evidence_count + 1)
         ))
         WHERE status = 'active' AND evidence_count > 1 AND ${conditions.join(" AND ")}`,
        binds
);

      // 3. Access bonus
      await db.execute(
        `UPDATE ai_dreaming_memory
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.02 * LOG(2, access_count + 1)
         ))
         WHERE status = 'active' AND access_count > 0 AND ${conditions.join(" AND ")}`,
        binds
);

      // 4. Archive very low confidence dreams
      const archiveResult = await db.execute(
        `UPDATE ai_dreaming_memory
         SET status = 'archived'
         WHERE status = 'active' AND confidence < 0.10 AND ${conditions.join(" AND ")}`,
        binds
);
      report!.dreamsArchived = archiveResult.rowsAffected ?? 0;

      // 5. Supersession: within same project+type, if newer dream has higher confidence and
      //    similar semantic content, mark the older one as superseded.
      //    Uses embedding vectors via cosine similarity.
      const supBinds: Record<string, any> = { ...binds };
      if (provider) { supBinds.provider = provider; }
      const supWhere = conditions.slice();
      if (provider) supWhere.push("provider = :provider");
      // Get all active dreams with embeddings, ordered by project, memory_type, created_at
      const rows = await db.query<any>(
        `SELECT id, project, memory_type, embedding, confidence, created_at
         FROM ai_dreaming_memory
         WHERE status = 'active' AND embedding IS NOT NULL AND ${supWhere.join(" AND ")}
         ORDER BY project, memory_type, created_at ASC`,
        supBinds
      );
      let supersededCount = 0;

      if (rows.length > 1) {
        // Group by project+memory_type and find pairs where newer dominates older
        const groups = new Map<string, any[]>();
        for (const row of rows) {
          const key = `${this.getVal(row, SCORE_IDX.PROJECT, 'PROJECT') }:${this.getVal(row, SCORE_IDX.MEMORY_TYPE, 'MEMORY_TYPE') }`; // project:memory_type
          // Extract embeddings before grouping
          if (!this.validateRowEmbedding(row, SCORE_IDX.EMBEDDING, SCORE_IDX.ID, "Scoring")) {
            if (report) report.invalidEmbeddingsSkipped++;
            continue;
          }

          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(row);
        }

        const toSupersede = new Set<string>();
        for (const [, group] of groups) {
          if (group.length < 2) continue;
          for (let i = 0; i < group.length; i++) {
            if (toSupersede.has(String(this.getVal(group[i], SCORE_IDX.ID, 'ID') ))) continue;
            const older = group[i];
            // Embeddings validated above during preprocessing
            const embO = this.getVal(older, SCORE_IDX.EMBEDDING, 'EMBEDDING') ; // embedding

            let isSuperseded = false;
            for (let j = i + 1; j < group.length; j++) {
              if (toSupersede.has(String(this.getVal(group[j], SCORE_IDX.ID, 'ID') ))) continue;
              const newer = group[j];
              const embN = this.getVal(newer, SCORE_IDX.EMBEDDING, 'EMBEDDING') ;

              const similarity = this.cosineSimilarity(embO, embN);

              // If similarity is high and newer has higher confidence → supersede older
              if (similarity > CONSOLIDATION_SIMILARITY_THRESHOLD && Number(this.getVal(newer, SCORE_IDX.CONFIDENCE, 'CONFIDENCE') ) > Number(this.getVal(older, SCORE_IDX.CONFIDENCE, 'CONFIDENCE') )) {
                toSupersede.add(String(this.getVal(older, SCORE_IDX.ID, 'ID') ));  // older's id
                break;
              }
            }

          }
        }

        if (toSupersede.size > 0) {
          const batch = Array.from(toSupersede).map((id: string) => ({ sid: id, tid: authStorage.getStore()!.uid }));
          await db.executeMany(
              `UPDATE ai_dreaming_memory SET status = 'superseded' WHERE id = :sid AND tenant_id = :tid`,
              batch
            );
          supersededCount = toSupersede.size;
        }
      }

      report!.dreamsSuperseded = supersededCount;
      logger.info(
        `[Consolidation] Dream lifecycle: ${report!.dreamsArchived} archived, ${supersededCount} superseded`
      );
  }

  /**
   * Bayesian confidence scoring:
   * - Each evidence/access event updates confidence via Bayesian update
   * - Confidence decays exponentially with time (0.995 per day)
   * - Archived concepts get reduced confidence
   * - access_count and last_accessed_at are tracked externally (via concepts/search API)
   */
  private async scoreRelevance(report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();



      // 1. Base decay
      await db.execute(
        `UPDATE codeatlas_concepts
         SET confidence = confidence * CASE
           WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - last_accessed_at)))
           ELSE POWER(0.997, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - created_at)))
         END
         WHERE status = 'active' AND tenant_id = :v_tid`,
        { v_tid: authStorage.getStore()!.uid }
);

      // 2. Evidence boost
      await db.execute(
        `UPDATE codeatlas_concepts
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.05 * LOG(2, evidence_count + 1)
         ))
         WHERE status = 'active' AND evidence_count > 1 AND tenant_id = :v_tid`,
        { v_tid: authStorage.getStore()!.uid }
);

      // 3. Access bonus
      await db.execute(
        `UPDATE codeatlas_concepts
         SET confidence = LEAST(0.99, GREATEST(0.05,
           confidence + 0.02 * LOG(2, access_count + 1)
         ))
         WHERE status = 'active' AND access_count > 0 AND tenant_id = :v_tid`,
        { v_tid: authStorage.getStore()!.uid }
);

      // 4. Archive very low confidence concepts
      const archiveResult = await db.execute(
        `UPDATE codeatlas_concepts
         SET status = 'archived'
         WHERE confidence < 0.10 AND status = 'active' AND tenant_id = :v_tid`,
        { v_tid: authStorage.getStore()!.uid }
);

      logger.info(
        `[Consolidation] Score: decay applied, ${(archiveResult.rowsAffected || 0)} archived`
      );
  }

  /**
   * Validates a row's embedding column to ensure downstream processing runs on correctly typed arrays without O(N^2) checks later.
   * Returns true if valid, false otherwise.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validateRowEmbedding(row: any[], embIdx: number, idIdx: number, contextLabel: string): boolean {
    const rawEmb = row[embIdx];
    if (!rawEmb) {
      logger.debug(`[Consolidation] ${contextLabel} skipping missing embedding for ID ${row[idIdx]}`);
      return false;
    }

    let safeEmb: number[] | Float32Array;
    if (rawEmb instanceof Float32Array) {
      safeEmb = rawEmb;
    } else if (Array.isArray(rawEmb)) {
      safeEmb = rawEmb;
    } else {
      logger.debug(`[Consolidation] ${contextLabel} encountered unexpected embedding type for ID ${row[idIdx]}`);
      return false;
    }

    if (!Number.isFinite(safeEmb.length) || safeEmb.length === 0) {
      logger.debug(`[Consolidation] ${contextLabel} skipping empty embedding for ID ${row[idIdx]}`);
      return false;
    }

    return true;
  }

  /**
   * Cosine similarity between two vectors (either standard arrays or Float32Array).
   * Note: passing Float32Array arrays directly via Oracle DB driver enables peak V8 mathematical loop optimizations natively.
   */
  private cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
    // Defense in depth: Verify inputs are valid array structures before accessing lengths
    // (primarily safety for non-loop external callers who may bypass validateRowEmbedding)
    if (!Array.isArray(a) && !(a instanceof Float32Array)) return 0;
    if (!Array.isArray(b) && !(b instanceof Float32Array)) return 0;

    // Optimization: Cache array length
    const len = a.length;
    if (len !== b.length || len === 0) {
      // Use debug rather than warn to prevent O(N^2) log spam in production
      logger.debug(`[Consolidation] cosineSimilarity encountered dimension mismatch: ${len} vs ${b.length}`);
      return 0;
    }
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      // Optimization: Extract to local variables to avoid multiple array lookups
      const valA = a[i];
      const valB = b[i];
      dot += valA * valB;
      normA += valA * valA;
      normB += valB * valB;
    }
    // Math.sqrt applied separately to avoid floating point overflow on very large vectors
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
      const match = dreams.find((d) => this.getVal(d, R_IDX.MEMORY_TYPE, 'MEMORY_TYPE')  === type);
      if (match) {
        const content = String(this.getVal(match, R_IDX.CONTENT, 'CONTENT')  || "");
        return content.length > 80 ? content.slice(0, 80) : content;
      }
    }
    // Fallback: use first dream's content (id=0, content=1)
    const first = String(dreams[0]?.[R_IDX.CONTENT]  || (dreams[0]?.[1] ?? "Untitled Concept"));
    return first.length > 80 ? first.slice(0, 80) : first;
  }
}

export const consolidationEngine = new ConsolidationEngine();
