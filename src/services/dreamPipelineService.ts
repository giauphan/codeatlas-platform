/**
 * Dream Pipeline Service — AI Second Brain Pipeline Orchestrator
 *
 * Encapsulates pipeline lifecycle management, execution timing, concurrency/overlap protection,
 * transcript summarization, and daily consolidation orchestration.
 */

import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import { createHash } from "node:crypto";
import { DreamingService, type DreamMemoryType, type DreamSaveStatus } from "./dreamingService.js";
import { summarizeConversationForDreams } from "./llmService.js";
import { ConsolidationEngine, type ConsolidationReport } from "./consolidationEngine.js";
import { GenomeService } from "./genomeService.js";
import { WikiService, type LLMProviderType } from "./wikiService.js";
import { DreamCaptureStore, type PendingCaptureEvent } from "./dreamCaptureStore.js";
import { MemoryIngestionService, type ReconciliationOptions, type ReconciliationResult } from "./memoryIngestionService.js";
import { createDatabaseAdapter } from "../database/factory.js";

function normalizeWikiProvider(provider: string): LLMProviderType | undefined {
  if (provider === "anthropic" || provider === "openai" || provider === "openai-compatible" || provider === "template") {
    return provider;
  }
  return undefined;
}

export interface DailyPipelineOptions {
  project?: string;
  projectId?: string;
  provider?: string;
  runId?: string;
  runAt?: string;
  runFence?: { jobKey: string; ownerToken: string; fencingToken: number };
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
  genesSaved: number;
  wikiUpdated: boolean;
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
  id?: string;
  status: DreamSaveStatus;
  persisted: boolean;
  reason_code?: string;
  memory_type: DreamMemoryType;
  project: string;
  durationMs: number;
}

export class DreamPipelineService {
  private static isRunning = false;
  private static lastRunDate: string | null = null;
  private static lastDurationMs: number | null = null;

  /**
   * Return durable source events that still need extraction/reconciliation.
   * Event rows remain pending until the Phase5 extraction worker records their
   * outcomes; merely reading them never advances an ACK or discards evidence.
   */
  public static async reconcilePendingIngests(options: ReconciliationOptions = {}): Promise<ReconciliationResult> {
    return MemoryIngestionService.processPending(options);
  }

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
        projectId: options.projectId,
        operations: ["dedup", "extract_concepts", "score", "score_dreams"],
        provider: options.provider && options.provider !== "all" ? options.provider : undefined,
        runId: options.runId,
        runAt: options.runAt,
        runFence: options.runFence,
      });
      if (consolidationResult.status !== "completed" || consolidationResult.errors.length > 0) {
        pipelineError = "consolidation operations failed";
        logger.error(`[Dreaming Pipeline] Daily consolidation failed for project="${project}" provider="${provider}" (status=${consolidationResult.status}, errors=${consolidationResult.errors.length})`);
      } else {
        logger.info(`[Dreaming Pipeline] Daily consolidation completed for project="${project}" provider="${provider}"`);
      }
    } catch (err: unknown) {
      pipelineError = err instanceof Error ? err.message : String(err);
      logger.error(`[Dreaming Pipeline] Daily consolidation failed for project="${project}": ${pipelineError}`);
    } finally {
      this.isRunning = false;
    }

    const durationMs = Date.now() - pipelineStartTime;
    const completedAt = new Date().toISOString();
    this.lastDurationMs = durationMs;
    if (!pipelineError) this.lastRunDate = completedAt.split("T")[0];

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
        genesSaved: 0,
        wikiUpdated: false,
        dreams: [],
        startedAt,
        completedAt,
        durationMs: totalMs,
      };
    }

    const savedDreams: Array<{ id: string; memory_type: string; content: string }> = [];
    const skipped: string[] = [];

    // Structured extraction retains source events and evidence on the legacy
    // transcript endpoint too. Unstructured legacy candidates keep the direct
    // save compatibility path.
    const structured = candidateDreams.every(dream => Array.isArray(dream.evidence) && dream.evidence.length > 0);
    if (structured) {
      const segments = options.content.split(/\n\n---\n\n/);
      const eventIds: string[] = [];
      for (const segment of segments) {
        const match = segment.match(/^\[(USER|ASSISTANT|TOOL)\]\n([\s\S]*)$/);
        if (!match) continue;
        const actorRole = match[1] as PendingCaptureEvent['actorRole'];
        const content = match[2].trim();
        const eventId = `legacy_${createHash('sha256').update(JSON.stringify([auth.uid, project, sessId, actorRole, content])).digest('hex')}`;
        const ack = await DreamCaptureStore.accept({ eventId, sessionId: sessId, project, actorRole, content });
        if (!ack.acknowledged) throw new Error('Transcript source persistence failed');
        eventIds.push(eventId);
      }

      for (const eventId of eventIds) {
        const result = await MemoryIngestionService.processPending({ projectId: project, eventId, limit: 1 });
        if (!result.success) throw new Error('Transcript extraction remains pending for retry');
        for (const id of result.memory_ids) {
          const rows = await createDatabaseAdapter().query<{ id: string; memory_type: string; content: string }>(
            'SELECT id, memory_type, content FROM ai_dreaming_memory WHERE tenant_id = :tenantId AND id = :id', { tenantId: auth.uid, id });
          savedDreams.push(...rows);
        }
        for (let i = 0; i < result.events_filtered; i++) skipped.push('filtered');
      }
    }

    for (const dream of structured ? [] : candidateDreams) {
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

    const geneResults = await Promise.allSettled(
      savedDreams.map((savedDream) =>
        authStorage.run(auth, () =>
          GenomeService.extractGene({
            sourceType: "dream",
            sourceId: savedDream.id,
            project,
            autoExtract: true,
          })
        )
      )
    );
    const genesSaved = geneResults.filter((r) => r.status === "fulfilled").length;

    let wikiUpdated = false;
    if (savedDreams.length > 0 && project !== "global") {
      try {
        const wikiService = WikiService.getInstance();
        const context = savedDreams
          .map((dream) => `[${dream.memory_type}] ${dream.content}`)
          .join("\n\n");
        const wikiTree = await wikiService.updateProjectWiki(project, context, {
          tenantId: auth.uid,
          provider: normalizeWikiProvider(provider),
        });
        wikiUpdated = wikiTree.totalPages > 0;
      } catch (err) {
        logger.warn(`[Dreaming Pipeline] Wiki auto-update failed for project="${project}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const totalMs = Date.now() - ingestStartTime;
    const completedAt = new Date().toISOString();
    logger.info(`[Dreaming Pipeline] [${completedAt}] Session="${sessId}" ingestion COMPLETED in ${totalMs}ms: saved=${savedDreams.length}, noise_blocked=${skipped.length}, genes_saved=${genesSaved} for project="${project}" provider="${provider}"`);

    return {
      success: true,
      sessionId: sessId,
      session_id: sessId,
      project,
      provider,
      dreamsExtracted: savedDreams.length,
      noiseBlocked: skipped.length,
      genesSaved,
      wikiUpdated,
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

    const acknowledgement = await authStorage.run(auth, () => DreamingService.saveDreamMemoryWithAck({
      project,
      sessionId: options.session_id || "unknown",
      memoryType: options.memory_type,
      content: options.content,
      importance: importanceVal,
      aiModel: options.provider,
      scope: options.scope,
      tags: options.tags,
      relatedIds: options.related_ids,
    }));

    const durationMs = Date.now() - startTime;
    const persisted = (acknowledgement.status === "stored" || acknowledgement.status === "duplicate") &&
      acknowledgement.persisted && typeof acknowledgement.id === "string" && acknowledgement.id.length > 0;
    const success = persisted || acknowledgement.status === "filtered";
    logger.info(`[Dreaming Pipeline] Dream memory ${acknowledgement.status} [${options.memory_type}] in ${durationMs}ms for project="${project}"`);

    return {
      success,
      ...(persisted ? { id: acknowledgement.id } : {}),
      status: acknowledgement.status,
      persisted,
      ...(acknowledgement.reason_code ? { reason_code: acknowledgement.reason_code } : {}),
      memory_type: options.memory_type,
      project,
      durationMs,
    };
  }
}
