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
import { IDatabaseAdapter } from "../database/adapters/interface.js";
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

export interface ConceptConfidenceUpdate extends Record<string, unknown> {
  conf: number;
  id: string;
  tenantId: string;
}

const DEFAULTS = {
  BATCH_SIZE: 500,
  MAX_CHUNK_SIZE: 2000,
  MAX_UPDATE_RECORDS: 10000,
  MAX_UPDATE_LIMIT: 50000,
  BATCH_UPDATE_RETRIES: 3,
  MAX_RETRIES: 10,
  BACKOFF_MS: 500,
  DECAY_CONSTANT: 0.2,
  MAX_DECAY: 1.0,
  CONFIDENCE_CEILING: 0.99,
  ABORT_THRESHOLD: 5,
  MAX_ABORT_THRESHOLD: 50,
  ABORT_FRACTION: 0.5,
  MAX_ABORT_FRACTION: 1.0
};

interface EngineConfig {
   batchSize: number;
   maxUpdateRecords: number;
   abortThreshold: number;
   abortFraction: number;
   decayConstant: number;
   confidenceCeiling: number;
   maxRetries: number;
   backoffMs: number;
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
  failedScoringChunks?: ConceptConfidenceUpdate[][];
}

export enum EnvVarType {
  INT = 'int',
  FLOAT = 'float',
}

/**
 * Core processor for AI memory consolidation.
 * Handles deduplication, concept extraction, and confidence scoring.
 *
 * Includes robust retry limits, exponential backoff, and
 * configurable chunking mechanisms to safely execute mass operations
 * without blocking database connections or encountering latency spikes.
 */
export class ConsolidationEngine {

  private getVal(row: Record<string, unknown> | unknown[], index: number, keyStr: string): unknown {
    if (!row) return undefined;
    if (Array.isArray(row)) {
        if (row[index] !== undefined) return row[index];
        return undefined;
    }
    if (row[keyStr] !== undefined) return row[keyStr];
    const lowerKey = keyStr.toLowerCase();
    if (row[lowerKey] !== undefined) return row[lowerKey];
    return undefined;
  }

  /**
   * Helper to parse and validate environment variables with fallbacks
   */
  private _configCache = new Map<string, number>();
  private _engineConfig: EngineConfig | null = null;

  /**
   * Caches configuration globally to avoid redundant Env var checks per method
   */
  private initConfig(): EngineConfig {
    if (this._engineConfig) return this._engineConfig;

    this._engineConfig = {
       batchSize: this.getEnvVarNumber('CODEATLAS_DB_BATCH_SIZE', DEFAULTS.BATCH_SIZE, EnvVarType.INT, DEFAULTS.MAX_CHUNK_SIZE),
       maxUpdateRecords: this.getEnvVarNumber('CODEATLAS_MAX_UPDATE_RECORDS', DEFAULTS.MAX_UPDATE_RECORDS, EnvVarType.INT, DEFAULTS.MAX_UPDATE_LIMIT),
       abortThreshold: this.getEnvVarNumber('CODEATLAS_BATCH_ABORT_THRESHOLD', DEFAULTS.ABORT_THRESHOLD, EnvVarType.INT, DEFAULTS.MAX_ABORT_THRESHOLD),
       abortFraction: this.getEnvVarNumber('CODEATLAS_BATCH_ABORT_FRACTION', DEFAULTS.ABORT_FRACTION, EnvVarType.FLOAT, DEFAULTS.MAX_ABORT_FRACTION),
       decayConstant: this.getEnvVarNumber('CODEATLAS_CONFIDENCE_DECAY_CONSTANT', DEFAULTS.DECAY_CONSTANT, EnvVarType.FLOAT, DEFAULTS.MAX_DECAY),
       confidenceCeiling: this.getEnvVarNumber('CODEATLAS_CONFIDENCE_CEILING', DEFAULTS.CONFIDENCE_CEILING, EnvVarType.FLOAT, 1.0),
       maxRetries: this.getEnvVarNumber('CODEATLAS_BATCH_UPDATE_RETRIES', DEFAULTS.BATCH_UPDATE_RETRIES, EnvVarType.INT, DEFAULTS.MAX_RETRIES),
       backoffMs: this.getEnvVarNumber('CODEATLAS_BATCH_UPDATE_BACKOFF_MS', DEFAULTS.BACKOFF_MS)
    };
    return this._engineConfig;
  }

  private getEnvVarNumber(name: string, defaultVal: number, type: EnvVarType = EnvVarType.INT, maxLimit?: number): number {
    if (this._configCache.has(name)) {
       return this._configCache.get(name)!;
    }
    let result = defaultVal;
    if (defaultVal === undefined || defaultVal === null) {
      throw new Error(`[Consolidation] Developer Error: defaultVal must be provided for getEnvVarNumber('${name}')`);
    }

    const rawValue = process.env[name];
    if (rawValue === undefined || rawValue === '') return defaultVal;

    let parsed = type === EnvVarType.FLOAT ? Number.parseFloat(rawValue.trim()) : Number.parseInt(rawValue.trim(), 10);

    if (Number.isNaN(parsed)) {
      logger.warn(`[Consolidation] Environment variable ${name} is set to non-numeric value '${rawValue}'. Ignoring and using default ${defaultVal}.`);
      return defaultVal;
    }

    if (!Number.isFinite(parsed) || parsed < 0) {
      logger.error(`[Consolidation] Invalid configuration for ${name}: ${rawValue}. Must be a finite non-negative number. Falling back to default ${defaultVal}.`);
      return defaultVal;
    }
    if (parsed === 0 && name === 'CODEATLAS_CONFIDENCE_DECAY_CONSTANT') {
        throw new Error(`[Consolidation] Environment variable ${name} cannot be 0. Decay is required for consistent scoring.`);
    }

    if (maxLimit !== undefined && parsed > maxLimit) {
      logger.error(`[Consolidation] Configuration for ${name} exceeds maximum limit of ${maxLimit}. Clamping value to ${maxLimit}.`);
      result = maxLimit;
    } else {
      result = parsed;
    }

    this._configCache.set(name, result);
    return result;
  }

  /**
   * Helper to parse BLOB, Float32Array, number[], or JSON-string embedding into Float32Array.
   */
  private parseEmbedding(rawEmb: unknown): Float32Array | null {
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
  private validateRowEmbedding(row: Record<string, unknown> | unknown[], embeddingIdx: number, idIdx: number, stepName: string): boolean {
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
   * Helper to encapsulate batch logging and reduce redundancy.
   */
  private logBatchDetails(level: 'debug' | 'info' | 'warn' | 'error', action: string, message: string, meta?: Record<string, unknown>): void {
    const txId = meta?.txId || 'no-tx';
    const msg = `[Consolidation] [Batch:${action}] [TxID:${txId}] ${message}`;

    // Toggle verbose debug logs based on configuration to avoid I/O overhead.
    const isVerbose = this.getEnvVarNumber('CODEATLAS_BATCH_VERBOSE_LOGGING', 0, EnvVarType.INT, 1) === 1;
    if (level === 'debug' && !isVerbose) return;

    if (meta) {
      // clone meta to prevent mutation, but omit noisy fields
      const logMeta = { ...meta };
      delete logMeta.txId;
      if (Object.keys(logMeta).length > 0) {
          logger[level](msg, logMeta);
      } else {
          logger[level](msg);
      }
    } else {
      logger[level](msg);
    }
  }

  /**
   * Execute row-by-row fallback logic, isolated for testability and clarity.
   */
  private async executeRowFallback(db: IDatabaseAdapter, updateSql: string, chunk: ConceptConfidenceUpdate[] | Record<string, unknown>[], batchId: string, fallbackState: { logCount: number }): Promise<boolean> {
    if (!Array.isArray(chunk)) {
      this.logBatchDetails('error', 'Fallback', `Chunk is not an array, cannot execute row fallback.`, { txId: batchId });
      return false;
    }
    this.logBatchDetails('warn', 'Fallback', `Chunk failed all retries. Falling back to row-by-row execution to salvage valid rows.`, { txId: batchId });
    let successCount = 0;

    // Configurable log suppression limit
    const suppressLimit = this.getEnvVarNumber('CODEATLAS_FALLBACK_LOG_LIMIT', 50, EnvVarType.INT, 1000);

    for (const row of chunk) {
      try {
        await db.execute(updateSql, row);
        successCount++;
      } catch (rowErr) {
        const rowMsg = rowErr instanceof Error ? rowErr.message : String(rowErr);

        // We aggregate errors to avoid excessive I/O overhead on high-failure jobs
        fallbackState.logCount++;

        // Sample errors to prevent log spam
        if (fallbackState.logCount % Math.max(1, Math.floor(suppressLimit / 10)) === 0) {
             this.logBatchDetails('warn', 'FallbackError', `Sampled fallback error (${fallbackState.logCount} failures so far): ${rowMsg}`, { txId: batchId });
        }

        // Safety abort for runaway errors in large batches
        if (fallbackState.logCount > suppressLimit * 2) {
            this.logBatchDetails('error', 'FallbackAbort', `Row fallback error count (${fallbackState.logCount}) exceeded maximum allowed threshold. Aborting remaining row execution for chunk to preserve system stability.`, { txId: batchId });
            break;
        }
      }
    }
    if (successCount > 0) {
      if (fallbackState.logCount > 0) {
         this.logBatchDetails('warn', 'FallbackSummary', `Fallback execution encountered ${fallbackState.logCount} total row-level errors.`, { txId: batchId });
      }
      this.logBatchDetails('info', 'FallbackResult', `Row-by-row fallback succeeded for ${successCount}/${chunk.length} rows.`, { txId: batchId });
      return successCount === chunk.length;
    }
    if (fallbackState.logCount > 0) {
       this.logBatchDetails('warn', 'FallbackSummary', `Fallback execution encountered ${fallbackState.logCount} total row-level errors.`, { txId: batchId });
    }
    const sampleIds = chunk.slice(0, 3).map((c: any) => c.id).join(', ');
    this.logBatchDetails('error', 'Failure', `All row-by-row attempts failed for chunk resulting in complete serialization failure. Sample failed IDs: ${sampleIds}`, { txId: batchId });
    return false;
  }

  /**
   * Deep copies and pre-normalizes a vector.
   * If the vector norm is 0, it logs a debug message and returns the unmodified (copied) vector.
   */
  private async attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState = { logCount: 0 }, maxRetries = this.initConfig().maxRetries }: { db: IDatabaseAdapter; updateSql: string; chunk: ConceptConfidenceUpdate[] | Record<string, unknown>[]; batchId: string; fallbackState?: { logCount: number }; maxRetries?: number }): Promise<boolean> {
    if (!Array.isArray(chunk)) {
      this.logBatchDetails('error', 'Attempt', `Chunk is not an array, cannot attempt batch update.`, { txId: batchId });
      return false;
    }
    const backoffBaseMs = this.initConfig().backoffMs;
    const MAX_CUMULATIVE_RETRY_MS = this.getEnvVarNumber('CODEATLAS_MAX_CUMULATIVE_RETRY_MS', 600000, EnvVarType.INT, 1800000); // Default 10 mins, Max 30 mins
    let cumulativeRetryTime = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await db.executeMany(updateSql, chunk);
        return true;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logBatchDetails('warn', 'Attempt', `Retrying update #${attempt} of ${maxRetries} for failed chunk... (${errorMessage})`, { error: err, txId: batchId });
        if (attempt === maxRetries) {
          return await this.executeRowFallback(db, updateSql, chunk, batchId, fallbackState);
        } else {
          // Check global time cap before applying next retry backoff
          if (cumulativeRetryTime >= MAX_CUMULATIVE_RETRY_MS) {
            this.logBatchDetails('error', 'Timeout', `Cumulative retry time (${cumulativeRetryTime}ms) exceeded maximum allowed limit (${MAX_CUMULATIVE_RETRY_MS}ms). Aborting retries and falling back.`, { txId: batchId });
            return await this.executeRowFallback(db, updateSql, chunk, batchId, fallbackState);
          }

          // Exponential backoff with jitter
          cumulativeRetryTime += await this.applyExponentialBackoff(attempt, backoffBaseMs);
        }
      }
    }
    return false;
  }

  private getBatchChunkSize(): number {
    const chunkSize = this.initConfig().batchSize;
    if (this._configCache.get('_chunkSizeLogged') !== 1 && this.getEnvVarNumber('CODEATLAS_BATCH_VERBOSE_LOGGING', 0, EnvVarType.INT, 1) === 1) {
      logger.info(`[Consolidation] Using batch chunk size of ${chunkSize}`);
      this._configCache.set('_chunkSizeLogged', 1);
    }
    return chunkSize;
  }

  private computeConfidence(currentConf: number, evidenceCount: number, customDecay?: number): number {
    if (evidenceCount === 0) {
      return currentConf; // No change in confidence for 0 evidence
    }

    if (customDecay !== undefined) {
        if (Number.isNaN(customDecay) || typeof customDecay !== 'number') {
            logger.warn(`[Consolidation] Invalid decay value passed (${customDecay}). Ignoring custom override.`);
            customDecay = undefined;
        } else if (customDecay === 0) {
            throw new Error(`[Consolidation] customDecay cannot be 0. Decay is required for consistent scoring.`);
        }
    }
    const config = this.initConfig();
    let decayConstant = customDecay !== undefined ? customDecay : config.decayConstant;

    if (currentConf < 0 || evidenceCount < 0 || decayConstant < 0) {
       logger.warn(`[Consolidation] Invalid negative values in confidence computation. (conf: ${currentConf}, evidence: ${evidenceCount}, decay: ${decayConstant}). Clamping values.`);
       currentConf = Math.max(0, currentConf);
       evidenceCount = Math.max(0, evidenceCount);
       decayConstant = Math.max(0, decayConstant);
    }

    const ceiling = this.initConfig().confidenceCeiling;
    return Math.min(ceiling, currentConf + (1 - currentConf) * (1 - Math.exp(-decayConstant * evidenceCount)));
  }

  private isValidConfidenceUpdate(idStr: unknown, confStr: unknown): boolean {
    if (idStr === undefined || confStr === undefined) {
      logger.error("[Consolidation] Missing required fields in database row. Skipping.");
      return false;
    }
    return true;
  }

  private sanitizeIdForUpdate(idStr: unknown): string {
    const id = String(idStr).trim();
    const idRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!idRegex.test(id)) {
      throw new Error(`Invalid UUID format detected: ${id}`);
    }

    if (idRegex.test(id)) {
        return id;
    }

    // Non-UUID IDs are sometimes valid in CodeAtlas depending on the provider,
    // but for strict ID sanitation we will ensure no SQL injection characters
    const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, '');

    if (sanitized.length === 0) {
        throw new Error(`[Consolidation] Invalid sanitized ID: "${id}". Possible injection attempt or malformed input.`);
    }

    if (id !== sanitized) {
       logger.debug(`[Consolidation] Sanitized non-UUID ID from "${id}" to "${sanitized}"`);
    }
    return sanitized;
  }

  private async applyExponentialBackoff(attempt: number, baseMs: number): Promise<number> {
    const MAX_BACKOFF_CAP_MS = 10000; // 10 seconds max wait
    const maxJitter = Math.min(100, baseMs);
    const jitter = Math.random() * maxJitter;
    // Cap exponential growth to prevent uncontrolled stalling
    const waitTime = Math.min((2 ** attempt) * baseMs + jitter, MAX_BACKOFF_CAP_MS);
    await new Promise(res => setTimeout(res, waitTime));
    return waitTime;
  }

  private shouldAbortBatchProcessing(consecutiveFailures: number, abortThreshold: number, totalFailed: number, totalChunks: number, abortFraction: number): boolean {
    return consecutiveFailures >= abortThreshold || (totalChunks >= 10 && totalFailed / totalChunks > abortFraction);
  }

  private prepareConfidenceUpdates(rows: Record<string, unknown>[], tenantId: string): ConceptConfidenceUpdate[] {
    const results: ConceptConfidenceUpdate[] = [];
    const maxLimit = this.initConfig().maxUpdateRecords;

    for (const row of rows) {
      if (results.length >= maxLimit) {
        logger.warn(`[Consolidation] Reached max update records limit (${maxLimit}). Terminating prepareConfidenceUpdates early.`);
        break;
      }

      const idStr = this.getVal(row, R_IDX.ID, 'ID');
      const confStr = this.getVal(row, R_IDX.CONFIDENCE, 'CONFIDENCE');

      if (!this.isValidConfidenceUpdate(idStr, confStr)) {
        continue;
      }

      const id = this.sanitizeIdForUpdate(idStr);
      const evidenceCountRaw = this.getVal(row, 5, 'EVIDENCE_COUNT');

      // Enforce robust type conversions to prevent NaN propagation
      const evidenceCount = evidenceCountRaw !== undefined && evidenceCountRaw !== null ? Number(evidenceCountRaw) : 1;
      const currentConf = Number(confStr);

      if (Number.isNaN(evidenceCount) || Number.isNaN(currentConf)) {
         logger.warn(`[Consolidation] Row (${id}) skipped due to NaN properties.`);
         continue;
      }

      // Bayesian confidence update: each piece of evidence increases confidence
      const newConf = this.computeConfidence(currentConf, evidenceCount);

      if (Math.abs(newConf - currentConf) > 0.01) {
        results.push({ conf: newConf, id, tenantId });
      }
    }
    return results;
  }

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

      const rows = await db.query<Record<string, unknown>>(sql, binds);
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
              binds as unknown as Record<string, unknown>[]
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

      const rows = await db.query<Record<string, unknown>>(sql, binds);

      if (rows.length < 3) {
        logger.info(`[Consolidation] Extract Concepts: ${rows.length} dreams found (min 3 required), skipping`);
        return;
      }

      // Group dreams by project & type
      const clusters = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const proj = String(this.getVal(row, R_IDX.PROJECT, 'PROJECT') || "default");
        const mtype = String(this.getVal(row, R_IDX.MEMORY_TYPE, 'MEMORY_TYPE') || "GENERAL");

        if (!this.validateRowEmbedding(row, R_IDX.EMBEDDING, R_IDX.ID, "ExtractConcepts")) {
          if (report) report.invalidEmbeddingsSkipped++;
          continue;
        }

        const key = `${proj}:${mtype}`;
        if (!clusters.has(key)) clusters.set(key, []);
        clusters.get(key)!.push(row as unknown as Record<string, unknown>);
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

      const rows = await db.query<Record<string, unknown>>(sql, binds);

      const updateRecords = this.prepareConfidenceUpdates(rows, tenantId);

      let updated = 0;
      if (updateRecords.length > 0) {
        // ⚡ Bolt: Batch database operations using executeMany to avoid N+1 query problem
        // Generate a single timestamp for all retries in this batch to maintain consistent metadata
        const timestampVal = dbType === "postgres" ? "CURRENT_TIMESTAMP" : "datetime('now')";
        const updateSql = `
          UPDATE codeatlas_concepts
          SET confidence = :conf, updated_at = ${timestampVal}
          WHERE id = :id AND tenant_id = :tenantId
        `;

        // Chunk batches to prevent very large batches from hitting database size limits or latency spikes.
        const DEFAULT_CHUNK_SIZE = 500;
        const MAX_CHUNK_LIMIT = 2000;
        const chunkSize = this.getBatchChunkSize();

        const failedChunks: ConceptConfidenceUpdate[][] = [];
        let totalConsecutiveFailures = 0;
        const abortThreshold = this.initConfig().abortThreshold;
        const abortFraction = this.initConfig().abortFraction;
        const totalRunCount = Math.ceil(updateRecords.length / chunkSize);

        const MAX_HARD_ABORT = 100;
        const fallbackState = { logCount: 0 };
        for (let i = 0; i < updateRecords.length; i += chunkSize) {
          if (this.shouldAbortBatchProcessing(totalConsecutiveFailures, abortThreshold, failedChunks.length, totalRunCount, abortFraction) || failedChunks.length >= MAX_HARD_ABORT) {
            this.logBatchDetails('error', 'Execution', `Too many chunks failed (${failedChunks.length}/${totalRunCount}). Aborting batch processing.`);
            break;
          }

          const chunk = updateRecords.slice(i, i + chunkSize) as ConceptConfidenceUpdate[];
          const batchId = randomUUID();

          const tStart = Date.now();
          this.logBatchDetails('debug', 'Execution', `Executing batch update for ${chunk.length} rows.`, { txId: batchId });
          try {
            let success = false;

            // Wrap the batch chunk attempt in a transaction to prevent partial execution inconsistencies.
            // Some database adapters (like SQLite) may not support manual .transaction methods in this interface,
            // so we fall back to raw query execution for BEGIN/COMMIT if necessary, or just run it.
            try {
               // SQLite specifically supports db.execute('BEGIN') but many native Postgres/Oracle adapters require explicit tx APIs
               if (typeof (db as any).transaction === 'function') {
                   // Prefer native transaction wrappers if the adapter implements them
                   await (db as any).transaction(async (txAdapter: IDatabaseAdapter) => {
                       success = await this.attemptBatchUpdate({ db: txAdapter, updateSql, chunk, batchId, fallbackState });
                       if (!success) throw new Error('Batch update chunk failed');
                   });
                   success = true;
               } else {
                   const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
                   if (dbType === 'sqlite' || dbType === 'postgres') {
                     this.logBatchDetails('debug', 'Transaction', `Adapter does not support native db.transaction(); falling back to explicit BEGIN/COMMIT statements`, { txId: batchId });
                     await db.execute('BEGIN TRANSACTION', {});
                     success = await this.attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState });
                     if (success) {
                        await db.execute('COMMIT', {});
                     } else {
                        try { await db.execute('ROLLBACK', {}); } catch (e) { this.logBatchDetails('error', 'Transaction', 'ROLLBACK failed', { txId: batchId, error: e }); }
                     }
                   } else {
                     this.logBatchDetails('debug', 'Transaction', `Adapter does not support native db.transaction(); running directly without explicit transaction wrapping`, { txId: batchId });
                     success = await this.attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState });
                   }
               }
            } catch (txErr) {
               // If transaction commands fail (e.g., unsupported by adapter), just run directly
               success = await this.attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState });
            }
            const duration = Date.now() - tStart;
            this.logBatchDetails('debug', 'Performance', `Batch executed in ${duration}ms`, { txId: batchId, durationMs: duration, rows: chunk.length });

            if (success) {
               updated += chunk.length;
               totalConsecutiveFailures = 0;
            } else {
              failedChunks.push(chunk);
              totalConsecutiveFailures++;
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.logBatchDetails('error', 'Execution', `Unhandled error during batch processing: ${errorMessage}`);
            failedChunks.push(chunk);
            totalConsecutiveFailures++;
          }
        }

        if (failedChunks.length > 0) {
          const totalFailedRows = failedChunks.reduce((acc, c) => acc + c.length, 0);
          this.logBatchDetails('error', 'Summary', `${failedChunks.length} chunks failed during concept scoring. Total rows failed: ${totalFailedRows}`);
          if (report) {
            report.failedScoringChunks = failedChunks;
          }
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

    const rows = await db.query<Record<string, unknown>>(fetchSql, binds);
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
          batch as unknown as Record<string, unknown>[]
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
