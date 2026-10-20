/**
 * Consolidation Engine — AI Second Brain
 *
 * Deduplicates similar dreams, extracts concepts, updates knowledge base.
 * Designed to run both on-demand (API) and as a nightly cron job.
 *
 * NOTE: SQLite `query()` returns rows as objects keyed by column name.
 * Some helpers still accept positional indexes for backward compatibility.
 */

import { createHash, randomUUID } from "node:crypto";
import { createDatabaseAdapter } from "../database/factory.js";
import { generateEmbeddingsBatch } from "./embeddingService.js";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import { DreamingService } from "./dreamingService.js";
import { buildInClause } from "../database/utils.js";

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

function parseSqlDate(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(normalized);
}

export interface ConsolidationJob {
  project?: string;
  projectId?: string;
  provider?: string;
  operations: ("dedup" | "extract_concepts" | "score" | "score_dreams")[];
  runId?: string;
  runAt?: string;
  runFence?: {
    jobKey: string;
    ownerToken: string;
    fencingToken: number;
  };
}

export interface ConsolidationReport {
  id: string;
  jobType: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  dreamsProcessed: number;
  dreamsMerged: number;
  conceptsCreated: number;
  dreamsArchived: number;
  dreamsSuperseded: number;
  invalidEmbeddingsSkipped: number;
  errors: string[];
}

export class ConsolidationEngine {

  private runFence: ConsolidationJob["runFence"];

  private fenceParameters(): Record<string, unknown> {
    if (!this.runFence) return {};
    return {
      fenceJobKey: this.runFence.jobKey,
      fenceOwnerToken: this.runFence.ownerToken,
      fenceVersion: this.runFence.fencingToken,
      fenceNow: new Date().toISOString(),
    };
  }

  private fencePredicate(): string {
    if (!this.runFence) return "1 = 1";
    const databaseNow = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase() === "postgres"
      ? "CURRENT_TIMESTAMP"
      : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    return `EXISTS (
      SELECT 1 FROM dream_job_runs fence
      WHERE fence.job_key = :fenceJobKey AND fence.owner_token = :fenceOwnerToken
        AND fence.fencing_token = :fenceVersion AND fence.state = 'running'
        AND fence.lease_until > ${databaseNow}
    )`;
  }

  private async assertRunCurrent(): Promise<void> {
    if (!this.runFence) return;
    const db = createDatabaseAdapter();
    const rows = await db.query<{ current: number }>(
      `SELECT 1 AS current FROM dream_job_runs
       WHERE job_key = :fenceJobKey AND owner_token = :fenceOwnerToken
         AND fencing_token = :fenceVersion AND state = 'running' AND lease_until > :fenceNow`,
      this.fenceParameters(),
    );
    if (rows.length !== 1) throw new Error("scheduled consolidation lease is no longer current");
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
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    const runId = typeof job.runId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(job.runId)
      ? job.runId
      : randomUUID();
    const runAt = typeof job.runAt === "string" && Number.isFinite(Date.parse(job.runAt))
      ? new Date(job.runAt).toISOString()
      : startedAt;
    this.runFence = job.runFence;
    const report: ConsolidationReport = {
      id: runId,
      jobType: job.operations.join("+"),
      status: "running",
      startedAt,
      dreamsProcessed: 0,
      dreamsMerged: 0,
      conceptsCreated: 0,
      dreamsArchived: 0,
      dreamsSuperseded: 0,
      invalidEmbeddingsSkipped: 0,
      errors: [],
    };

    logger.info(`[Consolidation Pipeline] [${startedAt}] Job ${report.id} RUNNING (ops: ${report.jobType}, project: ${job.project || "all"}, provider: ${job.provider || "all"})`);

    for (const op of job.operations) {
      const stepStart = Date.now();
      try {
        await this.assertRunCurrent();
        switch (op) {
          case "dedup":
            await this.deduplicateDreams(job.project, job.projectId, job.provider, report);
            break;
          case "extract_concepts":
            await this.extractConcepts(job.project, job.projectId, job.provider, report);
            break;
          case "score":
            await this.scoreConcepts(job.project, job.projectId, report);
            break;
          case "score_dreams":
            await this.scoreDreams(job.project, job.projectId, job.provider, report, runAt);
            break;
        }
        await this.assertRunCurrent();
        logger.info(`[Consolidation Pipeline] Step '${op}' completed in ${Date.now() - stepStart}ms (processed: ${report.dreamsProcessed}, merged: ${report.dreamsMerged}, concepts: ${report.conceptsCreated})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`${op}: ${msg}`);
        logger.error(`[Consolidation Pipeline] Step '${op}' failed after ${Date.now() - stepStart}ms: ${msg}`);
      }
    }

    const endTime = Date.now();
    report.completedAt = new Date(endTime).toISOString();
    report.durationMs = endTime - startTime;
    report.status = report.errors.length > 0 ? "failed" : "completed";

    logger.info(`[Consolidation Pipeline] [${report.completedAt}] Job ${report.id} ${report.status.toUpperCase()} in ${report.durationMs}ms. Merged: ${report.dreamsMerged}, Concepts: ${report.conceptsCreated}, Errors: ${report.errors.length}`);
    this.runFence = undefined;
    return report;
  }

  /**
   * Find similar dreams within the same project and merge them.
   */
  private async deduplicateDreams(project?: string, projectId?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, unknown> = { tenantId };
      if (projectId) { conditions.push('project_id = :projectId'); binds.projectId = projectId; }
      else if (project) { conditions.push('project = :project'); binds.project = project; }
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
      const allToRemove = new Set<string>();

      for (const [, group] of byProject) {
        // Track deletions within the project group to skip processed items
        const groupToRemove = new Set<string>();

        for (let i = 0; i < group.length; i++) {
          const itemI = group[i];
          if (groupToRemove.has(itemI.id)) continue;

          for (let j = i + 1; j < group.length; j++) {
            const itemJ = group[j];
            if (groupToRemove.has(itemJ.id)) continue;

            const similarity = this.cosineSimilarity(itemI.embedding, itemJ.embedding);

            if (similarity > CONSOLIDATION_SIMILARITY_THRESHOLD) {
              // Merge: keep the one with higher importance
              const keepIdx = itemI.importance >= itemJ.importance ? i : j;
              const removeIdx = keepIdx === i ? j : i;
              const idToRemove = keepIdx === i ? itemJ.id : itemI.id;
              groupToRemove.add(idToRemove);
              allToRemove.add(idToRemove);

              // If the outer element 'i' is removed, break the inner loop early.
              if (removeIdx === i) break;
            }
          }
        }
      }

      // Share bounded deletes across projects while keeping similarity comparisons isolated.
      if (allToRemove.size > 0) {
        const ids = Array.from(allToRemove);
        const BATCH_DELETE_CHUNK_SIZE = 900;
        for (let k = 0; k < ids.length; k += BATCH_DELETE_CHUNK_SIZE) {
          try {
            const chunk = ids.slice(k, k + BATCH_DELETE_CHUNK_SIZE);
            const { clause, binds } = buildInClause(chunk, { tenantId });
            const result = await db.execute(
              `DELETE FROM ai_dreaming_memory WHERE id IN (${clause}) AND tenant_id = :tenantId${projectId ? ' AND project_id = :projectId' : project ? ' AND project = :project' : ''} AND ${this.fencePredicate()}`,
              { ...(binds as Record<string, unknown>), ...(projectId ? { projectId } : project ? { project } : {}), ...this.fenceParameters() }
            );
            merged += result.rowsAffected || 0;
          } catch (err) {
            logger.warn(`[Consolidation] Dedup: Failed to delete chunk`, { chunkStart: k, error: err instanceof Error ? err.message : String(err) });
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
  private async extractConcepts(project?: string, projectId?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, unknown> = { tenantId };
      if (projectId) { conditions.push('project_id = :projectId'); binds.projectId = projectId; }
      else if (project) { conditions.push('project = :project'); binds.project = project; }
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
      const newConcepts: { id: string; label: string; description: string; category: string; project: string; projectId?: string; sourceIds: string; evidenceCount: number; tenantId: string; embedText: string }[] = [];

      for (const [key, dreamCluster] of clusters) {
        if (dreamCluster.length < 2) continue; // need at least 2 to form a concept

        const [proj, mtype] = key.split(':');

        // Extract concept title & description from cluster contents
        const orderedDreams = [...dreamCluster].sort((a, b) =>
          String(this.getVal(a, R_IDX.ID, 'ID')).localeCompare(String(this.getVal(b, R_IDX.ID, 'ID'))),
        );
        const contents = orderedDreams.map(r => String(this.getVal(r, R_IDX.CONTENT, 'CONTENT')));
        const conceptLabel = `Pattern: ${mtype} in ${proj}`;
        const conceptDesc = contents.slice(0, 5).join(' | ');
        const canonicalSourceIds = orderedDreams.map(r => String(this.getVal(r, R_IDX.ID, 'ID')));
        const sourceIds = JSON.stringify(canonicalSourceIds);
        const conceptId = createHash('sha256')
          .update(JSON.stringify(projectId
            ? [tenantId, projectId, proj, mtype, canonicalSourceIds, conceptDesc]
            : [tenantId, proj, mtype, canonicalSourceIds, conceptDesc]))
          .digest('hex');
        newConcepts.push({
          id: conceptId,
          label: conceptLabel.slice(0, 255),
          description: conceptDesc,
          category: mtype,
          project: proj,
          projectId,
          sourceIds,
          evidenceCount: dreamCluster.length,
          tenantId,
          embedText: conceptLabel + ': ' + conceptDesc
        });
      }

      if (newConcepts.length > 0) {
        // Generate embeddings in batch for all new concepts
        const embedTexts = newConcepts.map(c => c.embedText);
        const embeddings = await generateEmbeddingsBatch(embedTexts, 'passage');

        const insertBinds = [];
        for (let i = 0; i < newConcepts.length; i++) {
          const concept = newConcepts[i];
          const embedding = embeddings && embeddings[i] ? embeddings[i] : null;

          if (embeddings && embeddings.length === embedTexts.length && embedding && embedding.length > 0) {
            insertBinds.push({
              id: concept.id,
              label: concept.label,
              description: concept.description,
              category: concept.category,
              embedding: new Uint8Array(new Float32Array(embedding).buffer),
              project: concept.project,
              projectId: concept.projectId ?? null,
              confidence: 0.70,
              sourceIds: concept.sourceIds,
              evidenceCount: concept.evidenceCount,
              tenantId: concept.tenantId,
              ...this.fenceParameters(),
            });
          } else {
             logger.warn(`[Consolidation] Missing or invalid embedding for concept ${concept.id}. Skipping.`);
          }
        }

        if (insertBinds.length > 0) {
          const insertSql = `
            INSERT INTO codeatlas_concepts (
              id, label, description, category, embedding,
              project, project_id, confidence, source_ids, evidence_count, tenant_id
            ) SELECT
              :id, :label, :description, :category, :embedding,
              :project, :projectId, :confidence, :sourceIds, :evidenceCount, :tenantId
            WHERE ${this.fencePredicate()}
            ON CONFLICT(id) DO NOTHING
          `;
          // Consolidation Engine Optimization: Batch update concepts using executeMany instead of
          // executing individual INSERT queries in a loop to prevent N+1 bottleneck.
          await db.executeMany(insertSql, insertBinds);
          created += insertBinds.length;
        }
      }

      report!.conceptsCreated = created;
      logger.info(`[Consolidation] Extracted ${created} concept(s) from dream clusters`);
  }

  /**
   * Score concepts based on evidence, recency, and access frequency.
   */
  private async scoreConcepts(project?: string, projectId?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
      const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
      const tenantId = authStorage.getStore()!.uid;

      const conditions: string[] = ['tenant_id = :tenantId'];
      const binds: Record<string, unknown> = { tenantId };
      if (projectId) { conditions.push('project_id = :projectId'); binds.projectId = projectId; }
      else if (project) { conditions.push('project = :project'); binds.project = project; }

      const sql = `
        SELECT id, label, description, category, confidence, evidence_count, status
        FROM codeatlas_concepts
        WHERE ${conditions.join(' AND ')}
      `;

      const rows = await db.query<any[]>(sql, binds);

      const batchBinds: Record<string, unknown>[] = [];
      for (const row of rows) {
        const id = String(this.getVal(row, R_IDX.ID, 'ID'));
        const evidenceCount = Number(this.getVal(row, 5, 'EVIDENCE_COUNT') || 1);
        const newConf = Math.min(0.99, 0.5 + 0.49 * (1 - Math.exp(-0.2 * evidenceCount)));

        const currentConf = Number(this.getVal(row, R_IDX.CONFIDENCE, 'CONFIDENCE') || 0.5);
        if (Math.abs(newConf - currentConf) > 0.000001) {
          batchBinds.push({ conf: newConf, id, tenantId, ...(projectId ? { projectId } : project ? { project } : {}) });
        }
      }

      if (batchBinds.length > 0) {
        // Bolt Optimization: Batch update concepts using executeMany instead of
        // executing individual UPDATE queries in a loop to prevent N+1 bottleneck.
        const updateSql = `
          UPDATE codeatlas_concepts
          SET confidence = :conf, updated_at = ${dbType === "postgres" ? "CURRENT_TIMESTAMP" : "datetime('now')"}
          WHERE id = :id AND tenant_id = :tenantId${projectId ? ' AND project_id = :projectId' : project ? ' AND project = :project' : ''} AND ${this.fencePredicate()}
        `;
        await db.executeMany(updateSql, batchBinds.map((bind) => ({ ...bind, ...this.fenceParameters() })));
      }

      logger.info(`[Consolidation] Scored ${rows.length} concepts, updated ${batchBinds.length}`);
  }

  /**
   * Score and govern dreaming memories:
   * - Phase 4: Archival of stale/low-importance dreams
   * - Phase 4: Supersession when a newer high-confidence dream overlaps an old one
   */
  private async scoreDreams(project?: string, projectId?: string, provider?: string, report?: ConsolidationReport, runAt = new Date().toISOString()): Promise<void> {
    if (!DreamingService._hasLifecycleColumns) {
      logger.info("[Consolidation] Lifecycle columns missing — skipping dream scoring");
      return;
    }
    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;

    const conditions: string[] = ['tenant_id = :v_tid'];
    const binds: Record<string, unknown> = { v_tid: tenantId };
    if (projectId) { conditions.push('project_id = :projectId'); binds.projectId = projectId; }
    else if (project) { conditions.push('project = :project'); binds.project = project; }
    if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }

    const whereCond = conditions.join(' AND ');

    // Confidence is recomputed from stable source values and the schedule instant.
    // That makes a retry after the score write but before run completion idempotent.
    const scoreRows = await db.query<any[]>(
      `SELECT id, memory_type, importance, confidence, created_at, last_accessed_at, evidence_count, access_count
       FROM ai_dreaming_memory WHERE status = 'active' AND ${whereCond}`,
      binds,
    );
    const scoringTime = Date.parse(runAt);
    const updates: Array<Record<string, unknown>> = [];
    let archived = 0;
    for (const row of scoreRows) {
      const id = String(this.getVal(row, 0, 'ID'));
      const memoryType = String(this.getVal(row, 1, 'MEMORY_TYPE') || 'KNOWLEDGE');
      const importance = Number(this.getVal(row, 2, 'IMPORTANCE') || 5);
      const current = Number(this.getVal(row, 3, 'CONFIDENCE') || 0.5);
      const createdAt = String(this.getVal(row, 4, 'CREATED_AT') || runAt);
      const lastAccessedAt = this.getVal(row, 5, 'LAST_ACCESSED_AT');
      const evidenceCount = Math.max(0, Number(this.getVal(row, 6, 'EVIDENCE_COUNT') || 0));
      const accessCount = Math.max(0, Number(this.getVal(row, 7, 'ACCESS_COUNT') || 0));
      const referenceAt = parseSqlDate(lastAccessedAt ? String(lastAccessedAt) : createdAt);
      const ageDays = Number.isFinite(referenceAt) && Number.isFinite(scoringTime)
        ? Math.max(0, Math.floor((scoringTime - referenceAt) / 86_400_000))
        : 0;
      const decay = Math.pow(lastAccessedAt ? 0.995 : 0.997, ageDays);
      const baseConfidence = typeof DreamingService.calcInitialConfidence === 'function'
        ? DreamingService.calcInitialConfidence(memoryType as any, importance)
        : current;
      const evidenceBoost = evidenceCount > 1 ? 0.05 * Math.log2(evidenceCount + 1) : 0;
      const accessBonus = accessCount > 0 ? 0.02 * Math.log2(accessCount + 1) : 0;
      const confidence = Math.min(0.99, Math.max(0.05, baseConfidence * decay + evidenceBoost + accessBonus));
      const status = confidence < 0.10 ? 'archived' : 'active';
      if (status === 'archived') archived++;
      if (Math.abs(confidence - current) > 0.000001 || status === 'archived') {
        updates.push({ id, tenantId, confidence, status, ...(projectId ? { projectId } : project ? { project } : {}) });
      }
    }
    if (updates.length) {
      await db.executeMany(
        `UPDATE ai_dreaming_memory SET confidence = :confidence, status = :status
         WHERE id = :id AND tenant_id = :tenantId AND status = 'active'${projectId ? ' AND project_id = :projectId' : project ? ' AND project = :project' : ''} AND ${this.fencePredicate()}`,
        updates.map((bind) => ({ ...bind, ...this.fenceParameters() })),
      );
    }
    if (report) report.dreamsArchived = archived;

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
        const ids = Array.from(toSupersede);
        const BATCH_DELETE_CHUNK_SIZE = 900;
        for (let k = 0; k < ids.length; k += BATCH_DELETE_CHUNK_SIZE) {
          const chunk = ids.slice(k, k + BATCH_DELETE_CHUNK_SIZE);
          const { clause, binds } = buildInClause(chunk, { tid: authStorage.getStore()!.uid, ...(projectId ? { projectId } : project ? { project } : {}) });
          const result = await db.execute(
            `UPDATE ai_dreaming_memory SET status = 'superseded' WHERE id IN (${clause}) AND tenant_id = :tid${projectId ? ' AND project_id = :projectId' : project ? ' AND project = :project' : ''} AND ${this.fencePredicate()}`,
            { ...(binds as Record<string, unknown>), ...this.fenceParameters() }
          );
          supersededCount += result.rowsAffected || 0;
        }
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
