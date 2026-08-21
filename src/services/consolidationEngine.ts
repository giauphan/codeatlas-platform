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
   * Helper to parse BLOB, Float32Array, number[], or JSON-string embedding into Float32Array.
   */
  private parseEmbedding(rawEmb: any): Float32Array | null {
    if (!rawEmb) return null;

    if (rawEmb instanceof Float32Array) {
      return rawEmb;
    }

    if (Array.isArray(rawEmb)) {
      return new Float32Array(rawEmb);
    }

    if (rawEmb instanceof Uint8Array || rawEmb instanceof Buffer) {
      // Int8Array/Uint8Array containing Float32 raw bytes
      if (rawEmb.byteLength % 4 === 0) {
        return new Float32Array(rawEmb.buffer, rawEmb.byteOffset, rawEmb.byteLength / 4);
      }
    }

    if (typeof rawEmb === "string") {
      try {
        const parsed = JSON.parse(rawEmb);
        if (Array.isArray(parsed)) {
          return new Float32Array(parsed);
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Validates embedding on a row before mathematical processing.
   */
  private validateRowEmbedding(row: any, embeddingIdx: number, idIdx: number, stepName: string): boolean {
    const rawEmb = this.getVal(row, embeddingIdx, 'EMBEDDING');
    const parsed = this.parseEmbedding(rawEmb);
    if (!parsed || parsed.length === 0) {
      const idVal = this.getVal(row, idIdx, 'ID');
      logger.warn(`[Consolidation] ${stepName}: Skipping row ${idVal} due to missing or invalid embedding format.`);
      return false;
    }
    return true;
  }

  /**
   * Alias for runJob to maintain backward compatibility with consolidationEngine.run(...)
   */
  async run(job: ConsolidationJob): Promise<ConsolidationReport> {
    return this.runJob(job);
  }

  /**
   * Main entry point to run a consolidation job.
   */
  async runJob(job: ConsolidationJob): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      id: randomUUID(),
      jobType: job.operations.join("+"),
      dreamsProcessed: 0,
      dreamsMerged: 0,
      conceptsCreated: 0,
      dreamsArchived: 0,
      dreamsSuperseded: 0,
      invalidEmbeddingsSkipped: 0,
      errors: [],
    };

    logger.info(`[Consolidation] Starting job ${report.id} (ops: ${report.jobType})`);

    for (const op of job.operations) {
      try {
        switch (op) {
          case "dedup":
            await this.deduplicateDreams(job.project, job.provider, report);
            break;
          case "extract_concepts":
            await this.extractConcepts(job.project, job.provider, report);
            break;
          case "score":
            await this.scoreConcepts(job.project, report);
            break;
          case "score_dreams":
            await this.scoreDreams(job.project, job.provider, report);
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`${op}: ${msg}`);
        logger.error(`[Consolidation] Step '${op}' failed: ${msg}`);
      }
    }

    logger.info(`[Consolidation] Job ${report.id} completed. Merged: ${report.dreamsMerged}, Concepts: ${report.conceptsCreated}`);
    return report;
  }

  /**
   * Find similar dreams within the same project and merge them.
   */
  private async deduplicateDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, unknown> = { tenantId };
      if (project) { conditions.push('project = :project'); binds.project = project; }
      if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }

      const sql = `
        SELECT id, content, embedding, importance, memory_type, project
        FROM ai_dreaming_memory
        WHERE ${conditions.join(' AND ')}
      `;

      const rows = await db.query<any[]>(sql, binds);
      report!.dreamsProcessed += rows.length;

      if (rows.length < 2) {
        logger.info(`[Consolidation] Dedup: ${rows.length} dream(s) found, skipping`);
        return;
      }

      // Group by project to avoid cross-project false positives
      const byProject = new Map<string, { id: string, importance: number, embedding: Float32Array }[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, R_IDX.PROJECT, 'PROJECT') || "default");

        if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "Dedup")) {
          if (report) report.invalidEmbeddingsSkipped++;
          continue;
        }

        const id = String(this.getVal(row, R_IDX.ID, 'ID'));
        const importance = Number(this.getVal(row, R_IDX.IMPORTANCE, 'IMPORTANCE'));
        const rawEmb = this.getVal(row, R_IDX.EMBEDDING, 'EMBEDDING');
        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;

        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push({ id, importance, embedding });
      }

      let merged = 0;
      for (const [, group] of byProject) {
        const toRemove = new Set<string>();

        for (let i = 0; i < group.length; i++) {
          const itemI = group[i];
          if (toRemove.has(itemI.id)) continue;

          for (let j = i + 1; j < group.length; j++) {
            const itemJ = group[j];
            if (toRemove.has(itemJ.id)) continue;

            const similarity = this.cosineSimilarity(itemI.embedding, itemJ.embedding);

            if (similarity > CONSOLIDATION_SIMILARITY_THRESHOLD) {
              // Merge: keep the one with higher importance
              const keepIdx = itemI.importance >= itemJ.importance ? i : j;
              const removeIdx = keepIdx === i ? j : i;
              const idToRemove = keepIdx === i ? itemJ.id : itemI.id;
              toRemove.add(idToRemove);

              // If the outer element 'i' is removed, break the inner loop early.
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
      const binds: Record<string, unknown> = { tenantId };
      if (project) { conditions.push('project = :project'); binds.project = project; }
      if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }

      const sql = `
        SELECT id, content, embedding, importance, memory_type, project
        FROM ai_dreaming_memory
        WHERE ${conditions.join(' AND ')}
      `;

      const rows = await db.query<any[]>(sql, binds);

      if (rows.length < 3) {
        logger.info(`[Consolidation] Extract Concepts: ${rows.length} dreams found (min 3 required), skipping`);
        return;
      }

      // Group dreams by project & type
      const clusters = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, R_IDX.PROJECT, 'PROJECT') || "default");
        const mtype = String(this.getVal(row, R_IDX.MEMORY_TYPE, 'MEMORY_TYPE') || "GENERAL");

        if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "ExtractConcepts")) {
          if (report) report.invalidEmbeddingsSkipped++;
          continue;
        }

        const key = `${proj}:${mtype}`;
        if (!clusters.has(key)) clusters.set(key, []);
        clusters.get(key)!.push(row);
      }

      let created = 0;
      for (const [key, dreamCluster] of clusters) {
        if (dreamCluster.length < 2) continue; // need at least 2 to form a concept

        const [proj, mtype] = key.split(':');

        // Extract concept title & description from cluster contents
        const contents = dreamCluster.map(r => String(this.getVal(r, R_IDX.CONTENT, 'CONTENT')));
        const conceptLabel = `Pattern: ${mtype} in ${proj}`;
        const conceptDesc = contents.slice(0, 5).join(' | '); // concatenate sample evidence
        const sourceIds = JSON.stringify(dreamCluster.map(r => String(this.getVal(r, R_IDX.ID, 'ID'))));

        // Generate embedding for the concept
        const embeddings = await generateEmbeddingsBatch([conceptLabel + ': ' + conceptDesc], 'passage');
        const embedding = embeddings && embeddings[0] ? embeddings[0] : null;

        const conceptId = randomUUID();

        if (embedding && embedding.length > 0) {
          const insertSql = `
            INSERT INTO codeatlas_concepts (
              id, label, description, category, embedding,
              project, confidence, source_ids, evidence_count, tenant_id
            ) VALUES (
              :id, :label, :description, :category, :embedding,
              :project, :confidence, :sourceIds, :evidenceCount, :tenantId
            )
          `;
          await db.execute(insertSql, {
            id: conceptId,
            label: conceptLabel.slice(0, 255),
            description: conceptDesc,
            category: mtype,
            embedding: new Float32Array(embedding),
            project: proj,
            confidence: 0.70,
            sourceIds,
            evidenceCount: dreamCluster.length,
            tenantId,
          });
          created++;
        }
      }

      report!.conceptsCreated = created;
      logger.info(`[Consolidation] Extracted ${created} concept(s) from dream clusters`);
  }

  /**
   * Score concepts based on evidence, recency, and access frequency.
   */
  private async scoreConcepts(project?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, unknown> = { tenantId };
      if (project) { conditions.push('project = :project'); binds.project = project; }

      const sql = `
        SELECT id, label, description, category, confidence, evidence_count, status
        FROM codeatlas_concepts
        WHERE ${conditions.join(' AND ')}
      `;

      const rows = await db.query<any[]>(sql, binds);

      let updated = 0;
      for (const row of rows) {
        const id = String(this.getVal(row, R_IDX.ID, 'ID'));
        const evidenceCount = Number(this.getVal(row, 5, 'EVIDENCE_COUNT') || 1);
        const currentConf = Number(this.getVal(row, R_IDX.CONFIDENCE, 'CONFIDENCE') || 0.5);

        // Bayesian confidence update: each piece of evidence increases confidence
        const newConf = Math.min(0.99, currentConf + (1 - currentConf) * (1 - Math.exp(-0.2 * evidenceCount)));

        if (Math.abs(newConf - currentConf) > 0.01) {
          const updateSql = `
            UPDATE codeatlas_concepts
            SET confidence = :conf, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND tenant_id = :tenantId
          `;
          await db.execute(updateSql, { conf: newConf, id, tenantId });
          updated++;
        }
      }

      logger.info(`[Consolidation] Scored ${rows.length} concepts, updated ${updated}`);
  }

  /**
   * Score and govern dreaming memories:
   * - Phase 4: Archival of stale/low-importance dreams
   * - Phase 4: Supersession when a newer high-confidence dream overlaps an old one
   */
  private async scoreDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    if (!OracleDreamingService._hasLifecycleColumns) {
      logger.info("[Consolidation] Lifecycle columns missing — skipping dream scoring");
      return;
    }
    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;

    const conditions: string[] = ['tenant_id = :v_tid'];
    const binds: Record<string, unknown> = { v_tid: tenantId };
    if (project) { conditions.push('project = :project'); binds.project = project; }
    if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }

    const whereCond = conditions.join(' AND ');

    // 1. Time decay
    const decaySql = `
      UPDATE ai_dreaming_memory
      SET confidence = GREATEST(0.05, confidence * CASE
        WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - last_accessed_at)))
        ELSE POWER(0.997, EXTRACT(DAY FROM (CURRENT_TIMESTAMP - created_at)))
      END)
      WHERE status = 'active' AND ${whereCond}
    `;
    await db.execute(decaySql, binds);

    // 2. Evidence boost
    const boostSql = `
      UPDATE ai_dreaming_memory
      SET confidence = LEAST(0.99, GREATEST(0.05,
        confidence + 0.05 * LOG(2, evidence_count + 1)
      ))
      WHERE status = 'active' AND evidence_count > 1 AND ${whereCond}
    `;
    await db.execute(boostSql, binds);

    // 3. Access bonus
    const accessSql = `
      UPDATE ai_dreaming_memory
      SET confidence = LEAST(0.99, GREATEST(0.05,
        confidence + 0.02 * LOG(2, access_count + 1)
      ))
      WHERE status = 'active' AND access_count > 0 AND ${whereCond}
    `;
    await db.execute(accessSql, binds);

    // 4. Archival of low confidence dreams
    const archiveSql = `
      UPDATE ai_dreaming_memory
      SET status = 'archived'
      WHERE status = 'active' AND confidence < 0.10 AND ${whereCond}
    `;
    const archiveRes = await db.execute(archiveSql, binds);
    if (report) report.dreamsArchived = archiveRes.rowsAffected ?? 0;

    // 5. Supersession: within same project+type, if newer dream has higher confidence and
    //    similar semantic content, mark the older one as superseded.
    const fetchSql = `
      SELECT id, project, memory_type, embedding, confidence, created_at
      FROM ai_dreaming_memory
      WHERE status = 'active' AND embedding IS NOT NULL AND ${whereCond}
      ORDER BY project, memory_type, created_at ASC
    `;

    const rows = await db.query<any[]>(fetchSql, binds);
    let supersededCount = 0;

    if (rows.length > 1) {
      const groups = new Map<string, { id: string, confidence: number, embedding: Float32Array }[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, SCORE_IDX.PROJECT, 'PROJECT') || "default");
        const mtype = String(this.getVal(row, SCORE_IDX.MEMORY_TYPE, 'MEMORY_TYPE') || "GENERAL");
        const key = `${proj}:${mtype}`;

        if (!this.validateRowEmbedding(row, SCORE_IDX.EMBEDDING, SCORE_IDX.ID, "Scoring")) {
          if (report) report.invalidEmbeddingsSkipped++;
          continue;
        }

        const id = String(this.getVal(row, SCORE_IDX.ID, 'ID'));
        const confidence = Number(this.getVal(row, SCORE_IDX.CONFIDENCE, 'CONFIDENCE') || 0.5);
        const rawEmb = this.getVal(row, SCORE_IDX.EMBEDDING, 'EMBEDDING');
        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;

        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ id, confidence, embedding });
      }

      const toSupersede = new Set<string>();
      for (const [, group] of groups) {
        if (group.length < 2) continue;
        for (let i = 0; i < group.length; i++) {
          const older = group[i];
          if (toSupersede.has(older.id)) continue;

          for (let j = i + 1; j < group.length; j++) {
            const newer = group[j];
            if (toSupersede.has(newer.id)) continue;

            const similarity = this.cosineSimilarity(older.embedding, newer.embedding);

            if (similarity > CONSOLIDATION_SIMILARITY_THRESHOLD && newer.confidence > older.confidence) {
              toSupersede.add(older.id);
              break;
            }
          }
        }
      }

      if (toSupersede.size > 0) {
        const batch = Array.from(toSupersede).map((id: string) => ({ sid: id, tid: authStorage.getStore()!.uid }));
        await db.executeMany(
          `UPDATE ai_dreaming_memory SET status = 'superseded' WHERE id = :sid AND tenant_id = :tid`,
          batch as any
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
   */
  private cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    const len = vecA.length;
    for (let i = 0; i < len; i++) {
      const a = vecA[i];
      const b = vecB[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;

    return dot / denom;
  }
}

export const consolidationEngine = new ConsolidationEngine();
