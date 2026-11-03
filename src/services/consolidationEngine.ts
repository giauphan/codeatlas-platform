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
import { DreamingService, type DreamMemoryType } from "./dreamingService.js";
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
        await this.assertRunCurrent(); // NOSONAR
        switch (op) {
          case "dedup":
            await this.deduplicateDreams(job.project, job.projectId, job.provider, report); // NOSONAR
            break;
          case "extract_concepts":
            await this.extractConcepts(job.project, job.projectId, job.provider, report); // NOSONAR
            break;
          case "score":
            await this.scoreConcepts(job.project, job.projectId, report); // NOSONAR
            break;
          case "score_dreams":
            await this.scoreDreams(job.project, job.projectId, job.provider, report, runAt); // NOSONAR
            break;
        }
        await this.assertRunCurrent(); // NOSONAR
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
    const { conditions, binds } = this.scopeConditions(tenantId, project, projectId, provider);
    const rows = await db.query<unknown>(
      `SELECT id, content, embedding, importance, memory_type, project FROM ai_dreaming_memory
       WHERE ${conditions.join(' AND ')} AND (status IS NULL OR status = 'active')`, binds,
    );
    report!.dreamsProcessed += rows.length;
    if (rows.length < 2) {
      logger.info(`[Consolidation] Dedup: ${rows.length} dream(s) found, skipping`);
      return;
    }
    const groups = this.groupDedupRows(rows, report);
    const duplicateIds = this.findDuplicateDreamIds(groups);
    const merged = await this.markMergedDreams(db, duplicateIds, tenantId, project, projectId);
    report!.dreamsMerged = merged;
    logger.info(`[Consolidation] Dedup: marked ${merged} duplicate dreams merged`);
  }

  private scopeConditions(tenantId: string, project?: string, projectId?: string, provider?: string): { conditions: string[]; binds: Record<string, unknown> } {
    const conditions = ['tenant_id = :tenantId'];
    const binds: Record<string, unknown> = { tenantId };
    if (projectId) { conditions.push('project_id = :projectId'); binds.projectId = projectId; }
    else if (project) { conditions.push('project = :project'); binds.project = project; }
    if (provider) { conditions.push('provider = :provider'); binds.provider = provider; }
    return { conditions, binds };
  }

  private projectScope(project?: string, projectId?: string): { sql: string; binds: Record<string, string> } {
    if (projectId) return { sql: " AND project_id = :projectId", binds: { projectId } };
    if (project) return { sql: " AND project = :project", binds: { project } };
    return { sql: "", binds: {} };
  }

  private groupDedupRows(rows: unknown[], report?: ConsolidationReport): Map<string, { id: string; importance: number; embedding: Float32Array }[]> {
    const groups = new Map<string, { id: string; importance: number; embedding: Float32Array }[]>();
    for (const row of rows) {
      if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "Dedup")) {
        if (report) report.invalidEmbeddingsSkipped++;
        continue;
      }
      const id = String(this.getVal(row, R_IDX.ID, "ID"));
      const embedding = this.parseEmbedding(this.getVal(row, R_IDX.EMBEDDING, "EMBEDDING"));
      if (!embedding) continue;
      const projectName = String(this.getVal(row, R_IDX.PROJECT, "PROJECT") || "default");
      const group = groups.get(projectName) ?? [];
      group.push({ id, importance: Number(this.getVal(row, R_IDX.IMPORTANCE, "IMPORTANCE")), embedding: this.getNormalizedVector(embedding, id) });
      groups.set(projectName, group);
    }
    return groups;
  }

  private findDuplicateDreamIds(groups: Map<string, { id: string; importance: number; embedding: Float32Array }[]>): Set<string> {
    const duplicateIds = new Set<string>();
    for (const group of groups.values()) this.collectGroupDuplicates(group, duplicateIds);
    return duplicateIds;
  }

  private collectGroupDuplicates(group: { id: string; importance: number; embedding: Float32Array }[], duplicateIds: Set<string>): void {
    const removed = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      const left = group[i];
      if (removed.has(left.id)) continue;
      this.collectDuplicatesForDream(group, i, removed, duplicateIds);
    }
  }

  private collectDuplicatesForDream(
    group: { id: string; importance: number; embedding: Float32Array }[],
    index: number, removed: Set<string>, duplicateIds: Set<string>,
  ): void {
    const left = group[index];
    for (let j = index + 1; j < group.length; j++) {
      const right = group[j];
      if (removed.has(right.id)) continue;
      const similarity = this.cosineSimilarity(left.embedding, right.embedding);
      if (Number.isNaN(similarity) || similarity <= CONSOLIDATION_SIMILARITY_THRESHOLD) continue;
      const removeLeft = left.importance < right.importance;
      const duplicate = removeLeft ? left : right;
      removed.add(duplicate.id);
      duplicateIds.add(duplicate.id);
      if (removeLeft) break;
    }
  }

  private async markMergedDreams(
    db: ReturnType<typeof createDatabaseAdapter>, ids: Set<string>, tenantId: string, project?: string, projectId?: string,
  ): Promise<number> {
    let merged = 0;
    const values = Array.from(ids);
    for (let offset = 0; offset < values.length; offset += 900) {
      merged += await this.markMergedDreamChunk(db, values.slice(offset, offset + 900), offset, tenantId, project, projectId); // NOSONAR -- keep fenced database writes sequential.
    }
    return merged;
  }

  private async markMergedDreamChunk(
    db: ReturnType<typeof createDatabaseAdapter>, chunk: string[], offset: number, tenantId: string, project?: string, projectId?: string,
  ): Promise<number> {
    try {
      const { clause, binds } = buildInClause(chunk, { tenantId });
      const scope = this.projectScope(project, projectId);
      const result = await db.execute(
        `UPDATE ai_dreaming_memory SET status = 'merged', updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${clause}) AND tenant_id = :tenantId AND (status IS NULL OR status = 'active')${scope.sql} AND ${this.fencePredicate()}`,
        { ...(binds as Record<string, unknown>), ...scope.binds, ...this.fenceParameters() },
      );
      return result.rowsAffected || 0;
    } catch (error) {
      logger.warn("[Consolidation] Dedup: Failed to mark duplicate chunk merged", { chunkStart: offset, error: error instanceof Error ? error.message : String(error) });
      return 0;
    }
  }

  /**
   * Extract abstract concepts from dream clusters.
   * For each project, groups related dreams and generates concept entries.
   */
  private async extractConcepts(project?: string, projectId?: string, provider?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;
    const { conditions, binds } = this.scopeConditions(tenantId, project, projectId, provider);
    const rows = await db.query<unknown>(
      `SELECT id, content, embedding, importance, memory_type, project FROM ai_dreaming_memory
       WHERE ${conditions.join(' AND ')} AND (status IS NULL OR status = 'active')`, binds,
    );
    if (rows.length < 3) {
      logger.info(`[Consolidation] Extract Concepts: ${rows.length} dreams found (min 3 required), skipping`);
      return;
    }
    const clusters = this.groupConceptRows(rows, report);
    const concepts = this.buildConceptCandidates(clusters, tenantId, projectId);
    const created = await this.insertConceptCandidates(db, concepts);
    report!.conceptsCreated = created;
    logger.info(`[Consolidation] Extracted ${created} concept(s) from dream clusters`);
  }

  private groupConceptRows(rows: unknown[], report?: ConsolidationReport): Map<string, unknown[]> {
    const clusters = new Map<string, unknown[]>();
    for (const row of rows) {
      if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "ExtractConcepts")) {
        if (report) report.invalidEmbeddingsSkipped++;
        continue;
      }
      const key = `${String(this.getVal(row, R_IDX.PROJECT, "PROJECT") || "default")}:${String(this.getVal(row, R_IDX.MEMORY_TYPE, "MEMORY_TYPE") || "GENERAL")}`;
      const group = clusters.get(key) ?? [];
      group.push(row);
      clusters.set(key, group);
    }
    return clusters;
  }

  private buildConceptCandidates(
    clusters: Map<string, unknown[]>, tenantId: string, projectId?: string,
  ): Array<{ id: string; label: string; description: string; category: string; project: string; projectId?: string; sourceIds: string; evidenceCount: number; tenantId: string; embedText: string }> {
    const concepts: Array<{ id: string; label: string; description: string; category: string; project: string; projectId?: string; sourceIds: string; evidenceCount: number; tenantId: string; embedText: string }> = [];
    for (const [key, cluster] of clusters) {
      if (cluster.length < 2) continue;
      const [projectName, memoryType] = key.split(":");
      const ordered = [...cluster].sort((left, right) => String(this.getVal(left, R_IDX.ID, "ID")).localeCompare(String(this.getVal(right, R_IDX.ID, "ID"))));
      const content = ordered.map((row) => String(this.getVal(row, R_IDX.CONTENT, "CONTENT"))).slice(0, 5).join(" | ");
      const sourceIds = ordered.map((row) => String(this.getVal(row, R_IDX.ID, "ID")));
      const label = `Pattern: ${memoryType} in ${projectName}`;
      const idInput = projectId ? [tenantId, projectId, projectName, memoryType, sourceIds, content] : [tenantId, projectName, memoryType, sourceIds, content];
      concepts.push({
        id: createHash("sha256").update(JSON.stringify(idInput)).digest("hex"), label: label.slice(0, 255),
        description: content, category: memoryType, project: projectName, projectId,
        sourceIds: JSON.stringify(sourceIds), evidenceCount: cluster.length, tenantId, embedText: `${label}: ${content}`,
      });
    }
    return concepts;
  }

  private async insertConceptCandidates(
    db: ReturnType<typeof createDatabaseAdapter>, concepts: Array<{ id: string; label: string; description: string; category: string; project: string; projectId?: string; sourceIds: string; evidenceCount: number; tenantId: string; embedText: string }>,
  ): Promise<number> {
    if (!concepts.length) return 0;
    const embedTexts = concepts.map((concept) => concept.embedText);
    const embeddings = await generateEmbeddingsBatch(embedTexts, "passage");
    const inserts: Record<string, unknown>[] = [];
    concepts.forEach((concept, index) => {
      const embedding = embeddings?.length === embedTexts.length ? embeddings[index] : null;
      if (!embedding || embedding.length === 0) {
        logger.warn(`[Consolidation] Missing or invalid embedding for concept ${concept.id}. Skipping.`);
        return;
      }
      inserts.push({
        id: concept.id, label: concept.label, description: concept.description, category: concept.category,
        embedding: new Uint8Array(new Float32Array(embedding).buffer), project: concept.project, projectId: concept.projectId ?? null,
        confidence: 0.70, sourceIds: concept.sourceIds, evidenceCount: concept.evidenceCount, tenantId: concept.tenantId,
        ...this.fenceParameters(),
      });
    });
    if (!inserts.length) return 0;
    await db.executeMany(
      `INSERT INTO codeatlas_concepts (
        id, label, description, category, embedding, project, project_id, confidence, source_ids, evidence_count, tenant_id
      ) SELECT :id, :label, :description, :category, :embedding, :project, :projectId, :confidence, :sourceIds, :evidenceCount, :tenantId
      WHERE ${this.fencePredicate()} ON CONFLICT(id) DO NOTHING`,
      inserts,
    );
    return inserts.length;
  }

  /**
   * Score concepts based on evidence, recency, and access frequency.
   */
  private async scoreConcepts(project?: string, projectId?: string, report?: ConsolidationReport): Promise<void> {
    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;
    const { conditions, binds } = this.scopeConditions(tenantId, project, projectId);
    const rows = await db.query<unknown>(
      `SELECT id, label, description, category, confidence, evidence_count, status FROM codeatlas_concepts WHERE ${conditions.join(" AND ")}`,
      binds,
    );
    const batchBinds = this.scoreConceptRows(rows, tenantId, project, projectId);
    if (batchBinds.length) await this.writeConceptScores(db, batchBinds, project, projectId);
    logger.info(`[Consolidation] Scored ${rows.length} concepts, updated ${batchBinds.length}`);
  }

  private scoreConceptRows(rows: unknown[], tenantId: string, project?: string, projectId?: string): Record<string, unknown>[] {
    const updates: Record<string, unknown>[] = [];
    const scope = this.projectScope(project, projectId);
    for (const row of rows) {
      const id = String(this.getVal(row, R_IDX.ID, "ID"));
      const evidenceCount = Number(this.getVal(row, 5, "EVIDENCE_COUNT") || 1);
      const confidence = Math.min(0.99, 0.5 + 0.49 * (1 - Math.exp(-0.2 * evidenceCount)));
      const current = Number(this.getVal(row, R_IDX.CONFIDENCE, "CONFIDENCE") || 0.5);
      if (Math.abs(confidence - current) > 0.000001) {
        updates.push({ conf: confidence, id, tenantId, ...scope.binds });
      }
    }
    return updates;
  }

  private async writeConceptScores(
    db: ReturnType<typeof createDatabaseAdapter>, updates: Record<string, unknown>[], project?: string, projectId?: string,
  ): Promise<void> {
    const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
    const scope = this.projectScope(project, projectId);
    await db.executeMany(
      `UPDATE codeatlas_concepts SET confidence = :conf, updated_at = ${dbType === "postgres" ? "CURRENT_TIMESTAMP" : "datetime('now')"}
       WHERE id = :id AND tenant_id = :tenantId${scope.sql} AND ${this.fencePredicate()}`,
      updates.map((bind) => ({ ...bind, ...this.fenceParameters() })),
    );
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
    const { conditions, binds } = this.scopeConditions(tenantId, project, projectId, provider);
    const scopedBinds: Record<string, unknown> = { ...binds, v_tid: tenantId };
    delete scopedBinds.tenantId;
    const whereCond = conditions.map((condition) => condition.replace(":tenantId", ":v_tid")).join(" AND ");
    const scoreRows = await db.query<unknown>(
      `SELECT id, memory_type, importance, confidence, created_at, last_accessed_at, evidence_count, access_count
       FROM ai_dreaming_memory WHERE status = 'active' AND ${whereCond}`,
      scopedBinds,
    );
    const lifecycle = this.calculateLifecycleUpdates(scoreRows, tenantId, project, projectId, runAt);
    await this.writeLifecycleScores(db, lifecycle.updates, project, projectId);
    if (report) report.dreamsArchived = lifecycle.archived;
    const rows = await db.query<unknown>(
      `SELECT id, project, memory_type, embedding, confidence, created_at FROM ai_dreaming_memory
       WHERE status = 'active' AND embedding IS NOT NULL AND ${whereCond}
       ORDER BY project, memory_type, created_at ASC`, scopedBinds,
    );
    const groups = this.groupScoringRows(rows, report);
    const toSupersede = this.findSupersededIds(groups);
    const supersededCount = await this.markSupersededDreams(db, toSupersede, tenantId, project, projectId);
    report!.dreamsSuperseded = supersededCount;
    logger.info(
      `[Consolidation] Dream lifecycle: ${report!.dreamsArchived} archived, ${supersededCount} superseded`
    );
  }

  private calculateLifecycleUpdates(
    rows: unknown[], tenantId: string, project?: string, projectId?: string, runAt = new Date().toISOString(),
  ): { updates: Record<string, unknown>[]; archived: number } {
    const updates: Record<string, unknown>[] = [];
    let archived = 0;
    const scope = this.projectScope(project, projectId);
    for (const row of rows) {
      const score = this.calculateDreamLifecycleScore(row, runAt);
      if (score.status === "archived") archived++;
      if (Math.abs(score.confidence - score.current) > 0.000001 || score.status === "archived") {
        updates.push({ id: score.id, tenantId, confidence: score.confidence, status: score.status, ...scope.binds });
      }
    }
    return { updates, archived };
  }

  private calculateDreamLifecycleScore(row: unknown, runAt: string): { id: string; current: number; confidence: number; status: string } {
    const id = String(this.getVal(row, 0, "ID"));
    const memoryType = String(this.getVal(row, 1, "MEMORY_TYPE") || "KNOWLEDGE");
    const importance = Number(this.getVal(row, 2, "IMPORTANCE") || 5);
    const current = Number(this.getVal(row, 3, "CONFIDENCE") || 0.5);
    const createdAt = String(this.getVal(row, 4, "CREATED_AT") || runAt);
    const lastAccessedAt = this.getVal(row, 5, "LAST_ACCESSED_AT");
    const evidenceCount = Math.max(0, Number(this.getVal(row, 6, "EVIDENCE_COUNT") || 0));
    const accessCount = Math.max(0, Number(this.getVal(row, 7, "ACCESS_COUNT") || 0));
    const referenceAt = parseSqlDate(lastAccessedAt ? String(lastAccessedAt) : createdAt);
    const ageDays = Number.isFinite(referenceAt) && Number.isFinite(Date.parse(runAt))
      ? Math.max(0, Math.floor((Date.parse(runAt) - referenceAt) / 86_400_000)) : 0;
    const decay = Math.pow(lastAccessedAt ? 0.995 : 0.997, ageDays);
    const baseConfidence = typeof DreamingService.calcInitialConfidence === "function"
      ? DreamingService.calcInitialConfidence(memoryType as DreamMemoryType, importance)
      : current;
    const evidenceBoost = evidenceCount > 1 ? 0.05 * Math.log2(evidenceCount + 1) : 0;
    const accessBonus = accessCount > 0 ? 0.02 * Math.log2(accessCount + 1) : 0;
    const confidence = Math.min(0.99, Math.max(0.05, baseConfidence * decay + evidenceBoost + accessBonus));
    return { id, current, confidence, status: confidence < 0.10 ? "archived" : "active" };
  }

  private async writeLifecycleScores(
    db: ReturnType<typeof createDatabaseAdapter>, updates: Record<string, unknown>[], project?: string, projectId?: string,
  ): Promise<void> {
    if (!updates.length) return;
    const scope = this.projectScope(project, projectId);
    await db.executeMany(
      `UPDATE ai_dreaming_memory SET confidence = :confidence, status = :status
       WHERE id = :id AND tenant_id = :tenantId AND status = 'active'${scope.sql} AND ${this.fencePredicate()}`,
      updates.map((bind) => ({ ...bind, ...this.fenceParameters() })),
    );
  }

  private groupScoringRows(rows: unknown[], report?: ConsolidationReport): Map<string, { id: string; confidence: number; embedding: Float32Array }[]> {
    const groups = new Map<string, { id: string; confidence: number; embedding: Float32Array }[]>();
    for (const row of rows) {
      if (!this.validateRowEmbedding(row, SCORE_IDX.EMBEDDING, SCORE_IDX.ID, "Scoring")) {
        if (report) report.invalidEmbeddingsSkipped++;
        continue;
      }
      const id = String(this.getVal(row, SCORE_IDX.ID, "ID"));
      const embedding = this.parseEmbedding(this.getVal(row, SCORE_IDX.EMBEDDING, "EMBEDDING"));
      if (!embedding) continue;
      const key = `${String(this.getVal(row, SCORE_IDX.PROJECT, "PROJECT") || "default")}:${String(this.getVal(row, SCORE_IDX.MEMORY_TYPE, "MEMORY_TYPE") || "GENERAL")}`;
      const group = groups.get(key) ?? [];
      group.push({ id, confidence: Number(this.getVal(row, SCORE_IDX.CONFIDENCE, "CONFIDENCE") || 0.5), embedding: this.getNormalizedVector(embedding, id) });
      groups.set(key, group);
    }
    return groups;
  }

  private findSupersededIds(groups: Map<string, { id: string; confidence: number; embedding: Float32Array }[]>): Set<string> {
    const ids = new Set<string>();
    for (const group of groups.values()) if (group.length > 1) this.collectSupersededGroup(group, ids);
    return ids;
  }

  private collectSupersededGroup(group: { id: string; confidence: number; embedding: Float32Array }[], ids: Set<string>): void {
    for (let i = 0; i < group.length; i++) {
      const older = group[i];
      if (ids.has(older.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const newer = group[j];
        if (ids.has(newer.id)) continue;
        if (Number.isNaN(newer.confidence) || Number.isNaN(older.confidence) || newer.confidence <= older.confidence) continue;
        const similarity = this.cosineSimilarity(older.embedding, newer.embedding);
        if (Number.isNaN(similarity) || similarity <= CONSOLIDATION_SIMILARITY_THRESHOLD) continue;
        ids.add(older.id);
        break;
      }
    }
  }

  private async markSupersededDreams(
    db: ReturnType<typeof createDatabaseAdapter>, ids: Set<string>, tenantId: string, project?: string, projectId?: string,
  ): Promise<number> {
    let count = 0;
    const values = Array.from(ids);
    const scope = this.projectScope(project, projectId);
    for (let offset = 0; offset < values.length; offset += 900) {
      const chunk = values.slice(offset, offset + 900);
      const { clause, binds } = buildInClause(chunk, { tid: tenantId, ...scope.binds });
      const result = await db.execute( // NOSONAR
        `UPDATE ai_dreaming_memory SET status = 'superseded' WHERE id IN (${clause}) AND tenant_id = :tid${scope.sql} AND ${this.fencePredicate()}`,
        { ...(binds as Record<string, unknown>), ...this.fenceParameters() },
      );
      count += result.rowsAffected || 0;
    }
    return count;
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
      const heuristicNormSq = vecA[0] * vecA[0] + vecA[vecA.length - 1] * vecA[vecA.length - 1]; // NOSONAR
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
