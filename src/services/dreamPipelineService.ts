/**
 * Dream Pipeline Service — AI Second Brain Pipeline Orchestrator
 *
 * Encapsulates pipeline lifecycle management, execution timing, concurrency/overlap protection,
 * transcript summarization, and daily consolidation orchestration.
 */

import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import { DreamingService, type DreamMemoryType } from "./dreamingService.js";
import { summarizeConversationForDreams } from "./llmService.js";
import { ConsolidationEngine, type ConsolidationReport } from "./consolidationEngine.js";

export interface DailyPipelineOptions {
  project?: string;
  provider?: string;
}

export interface DailyPipelineResult {
  success: boolean;
  project: string;
  provider: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  consolidation?: ConsolidationReport | null;
  error?: string;
}

export interface SessionIngestionOptions {
  content: string;
  sessionId?: string;
  project?: string;
  provider?: string;
}

export interface SessionIngestionResult {
  success: boolean;
  sessionId: string;
  session_id: string;
  project: string;
  provider: string;
  dreamsExtracted: number;
  noiseBlocked: number;
  dreams: Array<{ id: string; memory_type: string; content: string }>;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface DreamSaveOptions {
  memory_type: DreamMemoryType;
  content: string;
  importance?: number;
  session_id?: string;
  project?: string;
  provider?: string;
  scope?: string;
  tags?: string[];
  related_ids?: string[];
}

export interface DreamSaveResult {
  success: boolean;
  id: string;
  memory_type: DreamMemoryType;
  project: string;
  durationMs: number;
}

export class DreamPipelineService {
  private static isRunning = false;
  private static lastRunDate: string | null = null;
  private static lastDurationMs: number | null = null;

  /**
   * Get current pipeline execution status and metrics
   */
  public static getPipelineStatus(): {
    isRunning: boolean;
    lastRunDate: string | null;
    lastDurationMs: number | null;
  } {
    return {
      isRunning: this.isRunning,
      lastRunDate: this.lastRunDate,
      lastDurationMs: this.lastDurationMs,
    };
  }

  /**
   * Execute the Daily Dream Consolidation Pipeline.
   * Protects against concurrent/overlapping runs and records execution duration.
   */
  public static async runDailyPipeline(options: DailyPipelineOptions = {}): Promise<DailyPipelineResult> {
    const pipelineStartTime = Date.now();
    const startedAt = new Date(pipelineStartTime).toISOString();
    const project = options.project || "all";
    const provider = options.provider || "all";

    if (this.isRunning) {
      logger.warn(`[Dreaming Pipeline] [${startedAt}] Pipeline already RUNNING. Skipping overlapping execution for project="${project}" provider="${provider}".`);
      return {
        success: false,
        project,
        provider,
        startedAt,
        durationMs: 0,
        error: "Pipeline is already running",
      };
    }

    this.isRunning = true;
    logger.info(`[Dreaming Pipeline] [${startedAt}] Daily dream generation pipeline RUNNING for project="${project}" provider="${provider}"`);

    let consolidationResult: ConsolidationReport | null = null;
    let pipelineError: string | undefined;

    try {
      const engine = new ConsolidationEngine();
      consolidationResult = await engine.run({
        project: options.project && options.project !== "all" ? options.project : undefined,
        operations: ["dedup", "extract_concepts", "score", "score_dreams"],
        provider: options.provider && options.provider !== "all" ? options.provider : undefined,
      });
      logger.info(`[Dreaming Pipeline] Daily consolidation completed for project="${project}" provider="${provider}"`);
    } catch (err: unknown) {
      pipelineError = err instanceof Error ? err.message : String(err);
      logger.error(`[Dreaming Pipeline] Daily consolidation failed for project="${project}": ${pipelineError}`);
    } finally {
      this.isRunning = false;
    }

    const durationMs = Date.now() - pipelineStartTime;
    const completedAt = new Date().toISOString();
    this.lastDurationMs = durationMs;
    this.lastRunDate = completedAt.split("T")[0];

    logger.info(`[Dreaming Pipeline] [${completedAt}] Daily dream generation pipeline COMPLETED in ${durationMs}ms (status: ${pipelineError ? "error" : "success"}, merged: ${consolidationResult?.dreamsMerged ?? 0}, concepts: ${consolidationResult?.conceptsCreated ?? 0})`);

    return {
      success: !pipelineError,
      project,
      provider,
      startedAt,
      completedAt,
      durationMs,
      consolidation: consolidationResult,
      error: pipelineError,
    };
  }

  /**
   * Execute Session Ingestion Pipeline.
   * Summarizes transcript into dream candidates, filters noise, and persists records.
   */
  public static async runSessionIngestion(options: SessionIngestionOptions): Promise<SessionIngestionResult> {
    const ingestStartTime = Date.now();
    const startedAt = new Date(ingestStartTime).toISOString();
    const sessId = options.sessionId || `session_${ingestStartTime}`;
    const project = options.project || "global";
    const provider = options.provider || "generic";
    const auth = authStorage.getStore()!;

    logger.info(`[Dreaming Pipeline] [${startedAt}] Session ingestion RUNNING for session="${sessId}" project="${project}" provider="${provider}" (content length: ${options.content.length} chars)`);

    const summarizeStart = Date.now();
    const candidateDreams = await summarizeConversationForDreams(options.content, provider, project, sessId);
    logger.info(`[Dreaming Pipeline] Summarization for session="${sessId}" completed in ${Date.now() - summarizeStart}ms (candidates: ${candidateDreams?.length ?? 0})`);

    if (!candidateDreams || candidateDreams.length === 0) {
      const totalMs = Date.now() - ingestStartTime;
      const completedAt = new Date().toISOString();
      logger.info(`[Dreaming Pipeline] Session="${sessId}" ingestion completed in ${totalMs}ms with 0 dreams extracted`);
      return {
        success: true,
        sessionId: sessId,
        session_id: sessId,
        project,
        provider,
        dreamsExtracted: 0,
        noiseBlocked: 0,
        dreams: [],
        startedAt,
        completedAt,
        durationMs: totalMs,
      };
    }

    const savedDreams: Array<{ id: string; memory_type: string; content: string }> = [];
    const skipped: string[] = [];

    for (const dream of candidateDreams) {
      const memId = await authStorage.run(auth, () =>
        DreamingService.saveDreamMemory(
          project,
          sessId,
          dream.memoryType as DreamMemoryType,
          dream.content,
          dream.importance,
          provider
        )
      );
      if (memId === "__noise_blocked__") {
        skipped.push(dream.content.slice(0, 60));
      } else {
        savedDreams.push({ id: memId, memory_type: dream.memoryType, content: dream.content });
      }
    }

    const totalMs = Date.now() - ingestStartTime;
    const completedAt = new Date().toISOString();
    logger.info(`[Dreaming Pipeline] [${completedAt}] Session="${sessId}" ingestion COMPLETED in ${totalMs}ms: saved=${savedDreams.length}, noise_blocked=${skipped.length} for project="${project}" provider="${provider}"`);

    return {
      success: true,
      sessionId: sessId,
      session_id: sessId,
      project,
      provider,
      dreamsExtracted: savedDreams.length,
      noiseBlocked: skipped.length,
      dreams: savedDreams,
      startedAt,
      completedAt,
      durationMs: totalMs,
    };
  }

  /**
   * Save a single dream memory with metrics and audit logging.
   */
  public static async saveDreamWithMetrics(options: DreamSaveOptions): Promise<DreamSaveResult> {
    const startTime = Date.now();
    const auth = authStorage.getStore()!;
    const project = options.project || "global";
    const importanceVal = typeof options.importance === "number" ? Math.min(9, Math.max(1, options.importance)) : 5;

    const memId = await authStorage.run(auth, () =>
      DreamingService.saveDreamMemory(
        project,
        options.session_id || "unknown",
        options.memory_type,
        options.content,
        importanceVal,
        options.provider,
        options.scope,
        options.tags,
        options.related_ids
      )
    );

    const durationMs = Date.now() - startTime;
    logger.info(`[Dreaming Pipeline] Saved dream memory [${options.memory_type}] (${memId}) in ${durationMs}ms for project="${project}"`);

    return {
      success: true,
      id: memId,
      memory_type: options.memory_type,
      project,
      durationMs,
    };
  }
}
