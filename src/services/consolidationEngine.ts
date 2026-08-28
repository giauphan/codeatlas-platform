/**
 * Consolidation Engine — AI Second Brain
 *
 * Deduplicates similar dreams, extracts concepts, updates knowledge base.
 * Designed to run both on-demand (API) and as a nightly cron job.
 *
 * NOTE: SQLite `query()` returns rows as objects keyed by column name.
 * Some helpers still accept positional indexes for backward compatibility.
 */

import { randomUUID } from "node:crypto";
import { createDatabaseAdapter } from "../database/factory.js";
import { generateEmbeddingsBatch } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import { DreamingService } from "./dreamingService.js";

// Row index helpers for concept/dream queries
const CONSOLIDATION_SIMILARITY_THRESHOLD = 0.85;

const R_IDX = Object.freeze({
  ID: 0, CONTENT: 1, EMBEDDING: 2, IMPORTANCE: 3,
  MEMORY_TYPE: 4, PROJECT: 5, LABEL: 6, DESCRIPTION: 7,
  CATEGORY: 8, CONFIDENCE: 9, EVIDENCE_COUNT: 10, STATUS: 11,
});

// Row index helpers for scoreDreams queries
// Query: SELECT id, project, memory_type, embedding, confidence, created_at FROM ai_dreaming_memory
const SCORE_IDX = Object.freeze({
  ID: 0, PROJECT: 1, MEMORY_TYPE: 2, EMBEDDING: 3, CONFIDENCE: 4, CREATED_AT: 5
});

export interface ConsolidationJob {
  project?: string;
  provider?: string;
  operations: ("dedup" | "extract_concepts" | "score" | "score_dreams")[];
}

export interface UpdateBinding {
  conf: number;
  id: string;
  tenantId: string;
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

  private readonly dbBatchChunkSize: number;
  private readonly dbUpdateMaxRetries: number;
  private readonly dbInitialBackoffMs: number;

  constructor() {
    this.dbBatchChunkSize = this.parseConfig("DB_BATCH_CHUNK_SIZE", 500, 1, 10000);
    this.dbUpdateMaxRetries = this.parseConfig("DB_UPDATE_MAX_RETRIES", 3, 1, 10);
    this.dbInitialBackoffMs = this.parseConfig("DB_INITIAL_BACKOFF_MS", 50, 10, 5000);
  }

  /**
   * Helper to clamp a numeric value within strict bounds.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private parseConfig(name: string, defaultValue: number, min: number, max: number): number {
    const value = process.env[name] || String(defaultValue);
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      logger.warn(`[Consolidation] Invalid value for ${name}: '${value}'. Falling back to default ${defaultValue}.`);
      return defaultValue;
    }
    return this.clamp(parsedValue, min, max);
  }

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
   * Returns the dialect-specific SQL string to get the current timestamp.
   */
  private getCurrentTimestampSql(dbType: string): string {
    if (dbType === "postgres") return "CURRENT_TIMESTAMP";
    if (dbType === "sqlite") return "datetime('now')";
    throw new Error(`[Consolidation] Unsupported dbType for timestamp mapping: ${dbType}`);
  }

  /**
   * Extracts and masks the tenant ID from an array of bindings for safe logging.
   */
  private getMaskedTenantId(bindings: Array<UpdateBinding>): string {
    const tId = bindings[0]?.tenantId || 'unknown';
    return tId.length > 4 ? tId.substring(0, 4) + '***' : '***';
  }

  /**
   * Generic retry mechanism for transient database operations with exponential backoff.
   */
  private async executeWithRetry<T>(
    taskFn: () => Promise<T>,
    errorContext: string,
    sampleIds: string,
    maskedTenant: string
  ): Promise<T> {
    const MAX_DELAY_MS = 5000;
    for (let attempt = 1; attempt <= this.dbUpdateMaxRetries; attempt++) {
      try {
        return await taskFn();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt === this.dbUpdateMaxRetries) {
          logger.error(`[Consolidation] ${errorContext} failed for tenant ${maskedTenant} after ${this.dbUpdateMaxRetries} attempts (masked sample ids: ${sampleIds}). Error: ${msg}`);
          throw error;
        } else {
          logger.warn(`[Consolidation] ${errorContext} retry ${attempt}/${this.dbUpdateMaxRetries} for tenant ${maskedTenant}... Error: ${msg}`);
          const baseDelay = this.dbInitialBackoffMs * Math.pow(2, attempt - 1);
          const jitter = baseDelay * 0.2 * (Math.random() - 0.5); // +/- 10% jitter
          const delay = this.clamp(baseDelay + jitter, 0, MAX_DELAY_MS);
          await new Promise(res => setTimeout(res, delay));
        }
      }
    }
    throw new Error(`[Consolidation] Task ${errorContext} failed after ${this.dbUpdateMaxRetries} attempts. Sample IDs: ${sampleIds}`);
  }

  /**
   * Fallback method to individually execute updates if a batch chunk completely fails.
   */
  private async executeIndividualUpdatesFallback(
    db: any,
    updateSql: string,
    bindings: Array<UpdateBinding>,
    maskedTenant: string
  ): Promise<{ successful: number, failed: number }> {
    let successfulCount = 0;
    let failedCount = 0;
    const failedIds: string[] = [];
    logger.warn(`[Consolidation] Falling back to individual updates for ${bindings.length} rows (tenant: ${maskedTenant}).`);
    for (const binding of bindings) {
      try {
        const indRes = await this.executeWithRetry<{ rowsAffected?: number }>(
          () => db.execute(updateSql, binding),
          `Individual update fallback`,
          binding.id.substring(0, 4) + '***',
          maskedTenant
        );
        successfulCount += (indRes.rowsAffected || 1);
      } catch (e) {
        failedCount++;
        failedIds.push(binding.id.substring(0, 4) + '***');
      }
    }

    if (failedCount > 0) {
      logger.error(`[Consolidation] Individual fallback failed for ${failedCount} rows (tenant: ${maskedTenant}). Masked IDs: ${failedIds.join(', ')}`);
    }

    return { successful: successfulCount, failed: failedCount };
  }

  /**
   * Helper to perform batched updates for concept confidence scores safely.
   * Batching significantly reduces the number of database round-trips compared
   * to updating rows one-by-one, which minimizes connection pool exhaustion
   * and mitigates N+1 query bottlenecks on large datasets.
   */
  private async updateConfidenceBatch(
    db: any,
    updateBindings: Array<UpdateBinding>,
    dbType: string
  ): Promise<{ successful: number, failed: number }> {
    if (!updateBindings || updateBindings.length === 0) return { successful: 0, failed: 0 };

    const updateSql = `
      UPDATE codeatlas_concepts
      SET confidence = :conf, updated_at = ${this.getCurrentTimestampSql(dbType)}
      WHERE id = :id AND tenant_id = :tenantId
    `;
    let successfulCount = 0;
    let failedCount = 0;

    if (updateBindings.length <= this.dbBatchChunkSize) {
      // Fast path for small payloads to avoid loop overhead
      const maskedTenant = this.getMaskedTenantId(updateBindings);
      const sampleIds = updateBindings.slice(0, 3).map(c => c.id.substring(0, 4) + '***').join(', ');

      try {
        const res = await this.executeWithRetry<{ rowsAffected?: number }>(
          () => db.executeMany(updateSql, updateBindings as unknown as Record<string, unknown>[]),
          'Batch update',
          sampleIds,
          maskedTenant
        );
        successfulCount += (res.rowsAffected || updateBindings.length);
      } catch (error) {
        const fallbackRes = await this.executeIndividualUpdatesFallback(db, updateSql, updateBindings, maskedTenant);
        successfulCount += fallbackRes.successful;
        failedCount += fallbackRes.failed;
      }
      return { successful: successfulCount, failed: failedCount };
    }

    for (let i = 0; i < updateBindings.length; i += this.dbBatchChunkSize) {
      const chunk = updateBindings.slice(i, i + this.dbBatchChunkSize);
      const maskedTenant = this.getMaskedTenantId(chunk);
      const sampleIds = chunk.slice(0, 3).map(c => c.id.substring(0, 4) + '***').join(', ');

      try {
        const res = await this.executeWithRetry<{ rowsAffected?: number }>(
          () => db.executeMany(updateSql, chunk as unknown as Record<string, unknown>[]),
          `Batch update chunk starting at index ${i}`,
          sampleIds,
          maskedTenant
        );
        successfulCount += (res.rowsAffected || chunk.length);
      } catch (error) {
        const fallbackRes = await this.executeIndividualUpdatesFallback(db, updateSql, chunk, maskedTenant);
        successfulCount += fallbackRes.successful;
        failedCount += fallbackRes.failed;
      }
    }

    return { successful: successfulCount, failed: failedCount };
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
   * Deep copies and pre-normalizes a vector.
   * If the vector norm is 0, it logs a debug message and returns the unmodified (copied) vector.
   */
  private getNormalizedVector(embedding: Float32Array, id: string): Float32Array {
    const vec = embedding.slice();
    let norm = 0;
    const len = vec.length;
    for (let k = 0; k < len; k++) {
      norm += vec[k] * vec[k];
    }
    if (norm > 0) {
      const denom = Math.sqrt(norm);
      for (let k = 0; k < len; k++) {
        vec[k] /= denom;
      }
    } else {
      logger.debug(`[Consolidation] Vector normalization: norm is 0 for id ${id}. Using raw vector.`);
    }
    return vec;
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
        let embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;

        // ⚡ Bolt: Deep copy and pre-normalize vector during O(N) extraction to avoid
        // expensive O(N^2) magnitude calculations inside the cosine similarity loop.
        embedding = this.getNormalizedVector(embedding, id);

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
            embedding: new Uint8Array(new Float32Array(embedding).buffer),
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
      const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
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

      let toBeUpdated = 0;
      const updateBindings: Array<UpdateBinding> = [];

      // Iterate over the concepts and determine if their confidence score requires an update.
      for (const row of rows) {
        const id = String(this.getVal(row, R_IDX.ID, 'ID'));
        const evidenceCount = Number(this.getVal(row, 5, 'EVIDENCE_COUNT') || 1);
        const currentConf = Number(this.getVal(row, R_IDX.CONFIDENCE, 'CONFIDENCE') || 0.5);

        // Bayesian confidence update: each piece of evidence increases confidence.
        // We cap the maximum confidence at 0.99 to allow for future fluctuation.
        const newConf = Math.min(0.99, currentConf + (1 - currentConf) * (1 - Math.exp(-0.2 * evidenceCount)));

        // Only queue an update if the calculated confidence delta is statistically significant.
        if (Math.abs(newConf - currentConf) > 0.01) {
          updateBindings.push({ conf: newConf, id, tenantId });
          toBeUpdated++;
        }
      }

      let successful = 0;
      let failed = 0;
      if (updateBindings.length > 0) {
        const result = await this.updateConfidenceBatch(db, updateBindings, dbType);
        successful = result.successful;
        failed = result.failed;

        if (failed === updateBindings.length && failed > 0) {
          logger.error(`[Consolidation] All ${failed} batch updates failed for tenant ${tenantId}. Manual intervention may be required.`);
        }
      }

      logger.info(`[Consolidation] Processed ${rows.length} concepts, prepared ${updateBindings.length} updates. Successfully applied: ${successful}, Failed: ${failed}`);
  }

  /**
   * Score and govern dreaming memories:
   * - Phase 4: Archival of stale/low-importance dreams
   * - Phase 4: Supersession when a newer high-confidence dream overlaps an old one
   */
  private async scoreDreams(project?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    if (!DreamingService._hasLifecycleColumns) {
      logger.info("[Consolidation] Lifecycle columns missing — skipping dream scoring");
      return;
    }
    const db = createDatabaseAdapter();
    const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
    const tenantId = authStorage.getStore()!.uid;

    const conditions: string[] = ['tenant_id = :v_tid'];
    const binds: Record<string, unknown> = { v_tid: tenantId };
    if (project) { conditions.push('project = :project'); binds.project = project; }
    if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }

    const whereCond = conditions.join(' AND ');

    // 1. Time decay
    const decayExpr = dbType === "postgres"
      ? `CASE
          WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_accessed_at)) / 86400)
          ELSE POWER(0.997, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) / 86400)
         END`
      : `CASE
          WHEN last_accessed_at IS NOT NULL THEN POWER(0.995, CAST(julianday('now') - julianday(last_accessed_at) AS INTEGER))
          ELSE POWER(0.997, CAST(julianday('now') - julianday(created_at) AS INTEGER))
         END`;

    const decaySql = `
      UPDATE ai_dreaming_memory
      SET confidence = GREATEST(0.05, confidence * ${decayExpr})
      WHERE status = 'active' AND ${whereCond}
    `;
    await db.execute(decaySql, binds);

    // POWER/LOG are available in SQLite builds with the math extension enabled;
    // Postgres provides both natively.
    const logExpr = "LOG(2, evidence_count + 1)";
    const logExprAccess = "LOG(2, access_count + 1)";

    // 2. Evidence boost
    const boostSql = `
      UPDATE ai_dreaming_memory
      SET confidence = LEAST(0.99, GREATEST(0.05,
        confidence + 0.05 * ${logExpr}
      ))
      WHERE status = 'active' AND evidence_count > 1 AND ${whereCond}
    `;
    await db.execute(boostSql, binds);

    // 3. Access bonus
    const accessSql = `
      UPDATE ai_dreaming_memory
      SET confidence = LEAST(0.99, GREATEST(0.05,
        confidence + 0.02 * ${logExprAccess}
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
        let embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;

        // ⚡ Bolt: Deep copy and pre-normalize vector during O(N) extraction to avoid
        // expensive O(N^2) magnitude calculations inside the cosine similarity loop.
        embedding = this.getNormalizedVector(embedding, id);

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

    // ⚡ Bolt: Both vectors are pre-normalized during extraction, so cosine similarity
    // reduces to a simple dot product, eliminating expensive O(N^2) Math.sqrt/division.
    if (process.env.NODE_ENV !== 'production' && vecA.length > 0) {
      // Cheap debug-only heuristic to warn if vectors somehow bypassed normalization
      const heuristicNormSq = vecA[0] * vecA[0] + vecA[vecA.length - 1] * vecA[vecA.length - 1];
      const HEURISTIC_UNNORMALIZED_THRESHOLD = 1.01;
      if (heuristicNormSq > HEURISTIC_UNNORMALIZED_THRESHOLD) {
         logger.warn(`[Consolidation] Un-normalized vector detected in cosineSimilarity! Optimization may yield incorrect results.`);
      }
    }

    let dot = 0;
    const len = vecA.length;
    for (let i = 0; i < len; i++) {
      dot += vecA[i] * vecB[i];
    }
    return dot;
  }
}

export const consolidationEngine = new ConsolidationEngine();
