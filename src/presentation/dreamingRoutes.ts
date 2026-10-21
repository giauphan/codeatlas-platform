import { SessionCheckpointService } from "../services/sessionCheckpointService.js";
import { registerCheckpointRoutes } from "./checkpointRoutes.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { checkAuth, logActivity } from "../services/authService.js";
import { DreamingService, DreamMemoryType } from "../services/dreamingService.js";
import { loadAnalysisAsync } from "../services/projectService.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "../middleware/auth.js";
import { rejectArrayParams } from "../middleware/validation.js";
import { DreamPipelineService } from "../services/dreamPipelineService.js";
import { DreamDiagnostics } from "../services/dreamDiagnostics.js";
import { DreamCaptureStore } from "../services/dreamCaptureStore.js";
import { MemoryIngestionService } from "../services/memoryIngestionService.js";
import rateLimit from "express-rate-limit";

const VALID_MEMORY_TYPES = ["MISTAKE", "PREFERENCE", "KNOWLEDGE", "PATTERN", "SESSION_SUMMARY"] as const;
const reconcileRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function executionAuth(tenantId: unknown) {
  const auth = authStorage.getStore()!;
  if (tenantId === undefined || tenantId === auth.uid) return auth;
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9._:@-]{1,255}$/.test(tenantId)) throw new Error('Invalid tenant scope');
  if (auth.uid !== 'admin' && auth.role !== 'admin' && auth.tier !== 'admin') return null;
  return { ...auth, uid: tenantId };
}

/** Extract auth from request headers — API key or Firebase Bearer token. */
function extractAuth(req: express.Request) {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const bearerMatch = (req.headers["authorization"] as string || "").match(/^Bearer (.+)$/);
  return { apiKey, bearerToken: bearerMatch?.[1] };
}

/** Resolve project name: if specified, try to load canonical name from analysis. */
async function resolveProjectName(project?: string): Promise<string> {
  if (!project) return "";
  try {
    const loaded = await loadAnalysisAsync(project);
    return loaded?.projectName ?? project;
  } catch (err: unknown) {
    logger.warn(`[Dreaming] Project lookup failed for "${project}", using as-is:`, err instanceof Error ? err.message : String(err));
    return project;
  }
}

/** Unified error handler for dreaming routes — auth errors get 401, everything else 500 + log. */
function handleError(res: express.Response, err: unknown, context: string) {
  const msg = err instanceof Error ? err.message : String(err);
  const isAuthFailure = msg.toLowerCase().includes("authentication") || msg.includes("API key");
  if (isAuthFailure) {
    res.status(401).json({ error: msg });
  } else {
    logger.error(`[Dreaming ${context}] Error:`, msg);
    res.status(500).json({ error: msg });
  }
}

export function registerDreamingRoutes(app: express.Application): void {
  registerCheckpointRoutes(app);

  app.get("/api/admin/dreams/diagnostics", authMiddleware, async (_req, res) => {
    const auth = authStorage.getStore();
    if (!auth || (auth.uid !== "admin" && auth.role !== "admin" && auth.tier !== "admin")) {
      return res.status(403).json({ error: "Admin access required" });
    }
    res.json({ counters: DreamDiagnostics.snapshot() });
  });

  app.delete("/api/dreams/delete", rejectArrayParams("id"), async (req, res) => {
    try {
      const { apiKey, bearerToken } = extractAuth(req);
      const auth = await checkAuth(apiKey, bearerToken);
      const id = req.query.id as string | undefined;
      if (!id?.trim()) return res.status(400).json({ error: "Missing or invalid id parameter" });

      await logActivity(auth, "delete_dream_memory", { id });
      const deleted = await authStorage.run(auth, () => DreamingService.deleteDreamMemory(id));
      deleted
        ? res.json({ success: true, id, message: "Dream memory deleted" })
        : res.status(404).json({ error: "Dream memory not found", id });
    } catch (err) {
      handleError(res, err, "Delete");
    }
  });

  app.post("/api/dreams/save", async (req, res) => {
    const providedRequestId = req.header("X-Request-ID") || "";
    const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(providedRequestId) ? providedRequestId : randomUUID();
    const requestStartedAt = Date.now();
    res.setHeader("X-Request-ID", requestId);
    const requestedType = typeof req.body?.memory_type === "string" ? req.body.memory_type : undefined;
    const sendSaveAck = (result: {
      status: "stored" | "duplicate" | "filtered" | "rejected" | "error";
      persisted: boolean;
      id?: string;
      reason_code?: string;
    }, statusCode?: number) => {
      const accepted = result.status === "stored" || result.status === "duplicate" || result.status === "filtered";
      const payload = {
        ...result,
        success: accepted,
        memory_type: requestedType,
        durationMs: Date.now() - requestStartedAt,
        request_id: requestId,
        ...(result.id ? { memory_id: result.id } : {}),
      };
      res.status(statusCode ?? (result.status === "rejected" ? 409 : result.status === "error" ? 500 : 200)).json(payload);
    };
    try {
      const { apiKey, bearerToken } = extractAuth(req);
      const auth = await checkAuth(apiKey, bearerToken);
      const { memory_type, content, importance, session_id, project, provider, scope, tags, related_ids } = req.body as {
        memory_type: typeof VALID_MEMORY_TYPES[number];
        content: string;
        importance?: number;
        session_id?: string;
        project?: string;
        provider?: string;
        scope?: string;
        tags?: string[];
        related_ids?: string[];
        idempotency_key?: string;
        project_id?: string;
        display_name?: string;
        workspace_path?: string;
      };
      const bodyIdempotencyKey = (req.body as { idempotency_key?: unknown }).idempotency_key;
      const headerIdempotencyKey = req.header("Idempotency-Key");
      if (bodyIdempotencyKey !== undefined && typeof bodyIdempotencyKey !== "string") {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_idempotency_key" }, 400);
      }
      if (headerIdempotencyKey && bodyIdempotencyKey && headerIdempotencyKey !== bodyIdempotencyKey) {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "idempotency_key_mismatch" }, 400);
      }
      const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey as string | undefined;

      if (!VALID_MEMORY_TYPES.includes(memory_type)) {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_memory_type" }, 400);
      }
      if (!content || typeof content !== "string") {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_content" }, 400);
      }

      // Validate scope format: alphanumeric + slash, max 500 chars
      if (scope && !/^[a-z0-9][a-z0-9/-]{0,499}$/.test(scope)) {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_scope" }, 400);
      }

      // Validate tags and related_ids: arrays of strings, max 100 items, max 100 chars per item
      if (tags && (!Array.isArray(tags) || tags.some(t => typeof t !== "string" || t.length > 100) || tags.length > 100)) {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_tags" }, 400);
      }
      if (related_ids && (!Array.isArray(related_ids) || related_ids.some(id => typeof id !== "string" || id.length > 100) || related_ids.length > 100)) {
        return sendSaveAck({ status: "rejected", persisted: false, reason_code: "invalid_related_ids" }, 400);
      }

      const importanceVal = typeof importance === "number" ? Math.min(9, Math.max(1, importance)) : 5;
      const projectId = typeof req.body?.project_id === "string" ? req.body.project_id : undefined;
      const displayName = typeof req.body?.display_name === "string" ? req.body.display_name : undefined;
      const workspacePath = typeof req.body?.workspace_path === "string" ? req.body.workspace_path : undefined;
      const projectName = await resolveProjectName(project || displayName || projectId || "global");

      await logActivity(auth, "save_dream_memory", {
        request_id: requestId,
        content_length: content.length,
        tags_count: tags?.length ?? 0,
        related_ids_count: related_ids?.length ?? 0,
      });
      const result = await authStorage.run(auth, () =>
        DreamingService.saveDreamMemoryWithAck({
          project: projectName,
          projectId,
          projectAliases: [project, displayName, workspacePath].filter((alias): alias is string => typeof alias === "string"),
          sessionId: session_id || "unknown",
          memoryType: memory_type,
          content,
          importance: importanceVal,
          aiModel: provider,
          scope,
          tags,
          relatedIds: related_ids,
          idempotencyKey,
        })
      );
      logger.info(`[Dreaming Pipeline] Dream save outcome [${result.status}] for project="${projectName}"`);
      sendSaveAck(result);
    } catch (err) {
      DreamDiagnostics.recordSave("error");
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthFailure = msg.toLowerCase().includes("authentication") || msg.includes("API key");
      if (isAuthFailure) {
        return sendSaveAck({ status: "error", persisted: false, reason_code: "authentication_failed" }, 401);
      }
      logger.error("[Dreaming Save] Request failed");
      return sendSaveAck({ status: "error", persisted: false, reason_code: "save_failed" }, 500);
    }
  });

  // GET /api/dreams/query — authenticated, tenant-isolated
  // rejectArrayParams: prevents HPP injection on all expected query parameters
  app.get("/api/dreams/query", authMiddleware, rejectArrayParams("query", "project", "project_id", "display_name", "workspace_path", "limit", "offset", "memory_type", "provider", "start_date", "end_date", "scope", "tags"), async (req, res) => {
    const providedRequestId = req.header("X-Request-ID") || "";
    const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(providedRequestId) ? providedRequestId : randomUUID();
    res.setHeader("X-Request-ID", requestId);
    try {
      const auth = authStorage.getStore()!;
      const queryText = (req.query.query as string)?.trim() || "";
      const project = req.query.project as string | undefined;
      const projectId = req.query.project_id as string | undefined;
      const limitRaw = req.query.limit as string | undefined;
      const offsetRaw = req.query.offset as string | undefined;
      const memoryType = req.query.memory_type as string | undefined;
      const provider = req.query.provider as string | undefined;
      const startDateRaw = req.query.start_date as string | undefined;
      const endDateRaw = req.query.end_date as string | undefined;

      // Parse and validate date filters — accept ISO 8601 or YYYY-MM-DD
      const parseDate = (d?: string): Date | undefined => {
        if (!d) return undefined;
        const parsed = new Date(d);
        if (isNaN(parsed.getTime())) return undefined;
        return parsed;
      };
      const startDate = parseDate(startDateRaw);
      const endDate = parseDate(endDateRaw);

      const scope = req.query.scope as string | undefined;
      let tags: string[] | undefined;
      const tagsRaw = req.query.tags as string | undefined;
      if (tagsRaw) {
        try {
          // Allow comma-separated string or JSON array
          if (tagsRaw.startsWith('[')) tags = JSON.parse(tagsRaw);
          else tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
        } catch {}
      }

      const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: "limit must be a number between 1 and 100" });
      }
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({ error: "offset must be a non-negative number" });
      }

      const projectName = await resolveProjectName(project);
      await logActivity(auth, "query_dream_memories", {
        request_id: requestId,
        query_length: queryText.length,
        result_limit: limit,
      });

      const retrieval = await authStorage.run(
        auth,
        () => DreamingService.queryDreamMemoriesWithStatus(projectName, queryText, limit, offset, memoryType, provider, startDate, endDate, scope, tags, projectId, req.query.display_name as string | undefined, req.query.workspace_path as string | undefined)
      );
      const rows = retrieval.memories;

      const rawMemories = (rows ?? []) as unknown as Array<Record<string, unknown>>;
      const memories = rawMemories.map((r: Record<string, unknown>) => {
        const get = (upper: string, lower: string) => r[upper] ?? r[lower];
        let tags: string[] | undefined;
        let relatedIds: string[] | undefined;
        const tagsRaw = get('TAGS', 'tags');
        const relatedIdsRaw = get('RELATED_IDS', 'related_ids');
        try { if (typeof tagsRaw === 'string') tags = JSON.parse(tagsRaw); } catch {}
        try { if (typeof relatedIdsRaw === 'string') relatedIds = JSON.parse(relatedIdsRaw); } catch {}

        return {
          id: get('ID', 'id'),
          session_id: get('SESSION_ID', 'session_id'),
          project: get('PROJECT', 'project'),
          provider: get('PROVIDER', 'provider'),
          memory_type: get('MEMORY_TYPE', 'memory_type'),
          content: get('CONTENT', 'content'),
          importance: get('IMPORTANCE', 'importance'),
          created_at: get('CREATED_AT', 'created_at'),
          scope: get('SCOPE', 'scope'),
          tags,
          related_ids: relatedIds,
        };
      });

      DreamDiagnostics.recordRetrieval(retrieval.retrieval_status, memories.length);
      res.json({
        memories,
        count: memories.length,
        retrieval_status: retrieval.retrieval_status,
        retrieval_counts: { candidates: retrieval.candidate_count, returned: retrieval.returned_count },
      });
    } catch (err) {
      DreamDiagnostics.recordFailure();
      DreamDiagnostics.recordRetrieval('backend_error', 0);
      const msg = err instanceof Error ? err.message : String(err);
      const authFailure = msg.toLowerCase().includes("authentication") || msg.toLowerCase().includes("api key");
      logger.error("[Dreaming Query] Request failed");
      res.status(authFailure ? 401 : 500).json({
        error: authFailure ? "Authentication failed" : "Query failed",
        retrieval_status: authFailure ? "auth_error" : "backend_error",
        retrieval_counts: { candidates: 0, returned: 0 },
        request_id: requestId,
      });
    }
  });

  // GET /api/dreams/pipeline/status — inspect running pipeline metrics
  app.get("/api/dreams/pipeline/status", authMiddleware, async (_req, res) => {
    try {
      const status = DreamPipelineService.getPipelineStatus();
      res.json({ success: true, ...status });
    } catch (err) {
      handleError(res, err, "PipelineStatus");
    }
  });

  // POST /api/dreams/ingest-session — process conversation transcript, extract dreams, save
  app.post("/api/dreams/ingest-session", authMiddleware, async (req, res) => {
    const providedRequestId = req.header("X-Request-ID") || "";
    const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(providedRequestId) ? providedRequestId : randomUUID();
    res.setHeader("X-Request-ID", requestId);
    let isEventCapture = false;
    try {
      const auth = authStorage.getStore()!;
      const { content, session_id, project, provider } = req.body as {
        content: string;
        session_id?: string;
        project?: string;
        provider?: string;
        event_id?: unknown;
        project_id?: unknown;
        checkpoint?: unknown;
        occurred_at?: unknown;
        source_spans?: unknown;
      };

      // Event-based capture is durable and idempotent. The legacy transcript
      // flow remains available when callers do not provide event_id.
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "event_id")) {
        isEventCapture = true;
        DreamDiagnostics.recordCaptureReceived();
        const body = req.body as Record<string, unknown>;
        const eventId = body.event_id;
        const sessionId = body.session_id;
        const actorRole = body.actor_role;
        const memoryTypeHint = body.memory_type_hint ?? body.memory_type;
        const toolName = body.tool_name;
        const projectId = body.project_id;
        const displayProject = body.project ?? body.display_name ?? projectId;
        const sourceSpans = body.source_spans;
        if (typeof eventId !== "string" || typeof sessionId !== "string" ||
            typeof displayProject !== "string" ||
            (actorRole !== undefined && actorRole !== "USER" && actorRole !== "ASSISTANT" && actorRole !== "TOOL") ||
            (memoryTypeHint !== undefined && typeof memoryTypeHint !== "string") ||
            (toolName !== undefined && typeof toolName !== "string") ||
            (projectId !== undefined && typeof projectId !== "string") ||
            (body.occurred_at !== undefined && typeof body.occurred_at !== "string") ||
            (sourceSpans !== undefined && (!Array.isArray(sourceSpans) || sourceSpans.some((span) =>
              !span || typeof span !== "object" || typeof (span as Record<string, unknown>).start !== "number" || typeof (span as Record<string, unknown>).end !== "number")))) {
          DreamDiagnostics.recordCapture('rejected');
          const invalid = {
            success: false,
            status: "rejected",
            persisted: false,
            acknowledged: false,
            event_id: typeof eventId === "string" ? eventId : "",
            memory_ids: [],
            reason_code: "invalid_event",
            request_id: requestId,
          };
          return res.status(400).json(invalid);
        }
        const result = await authStorage.run(auth, () => DreamCaptureStore.accept({
          eventId,
          sessionId,
          actorRole: actorRole as "USER" | "ASSISTANT" | "TOOL" | undefined,
          memoryTypeHint: memoryTypeHint as "MISTAKE" | "PREFERENCE" | "KNOWLEDGE" | "PATTERN" | "SESSION_SUMMARY" | undefined,
          toolName: toolName as string | undefined,
          project: String(displayProject),
          projectId: typeof projectId === "string" ? projectId : undefined,
          displayName: typeof body.display_name === 'string' ? body.display_name : undefined,
          workspacePath: typeof body.workspace_path === 'string' ? body.workspace_path : undefined,
          content,
          checkpoint: body.checkpoint,
          occurredAt: typeof body.occurred_at === "string" ? body.occurred_at : undefined,
          sourceSpans: sourceSpans as Array<{ start: number; end: number }> | undefined,
        }));
        if (result.acknowledged && body.checkpoint !== undefined) {
          // Materialize progress before source evidence can be reconciled or expire.
          await authStorage.run(auth, () => SessionCheckpointService.latest(typeof projectId === "string" ? projectId : String(displayProject)));
        }
        let extractionStatus: 'pending' | 'processed' | 'filtered' | undefined = result.extraction_status;
        // Checkpoint batches are reconciled by the model-capable worker. The
        // hook ACK only promises durable source storage; deterministic startup
        // progress was materialized above and is immediately available.
        if (result.acknowledged && body.checkpoint === undefined && result.extraction_status === 'pending' && process.env.CODEATLAS_MEMORY_PROCESSING_ENABLED !== 'false') {
          const extraction = await authStorage.run(auth, () => MemoryIngestionService.processPending({
            projectId: typeof projectId === 'string' ? projectId : String(displayProject), eventId, useModel: false,
          }));
          if (extraction.success) {
            result.memory_ids = extraction.memory_ids;
            extractionStatus = result.memory_ids.length ? 'processed' : 'filtered';
          }
        }
        await logActivity(auth, "ingest_capture_event", {
          request_id: requestId,
          content_length: typeof content === "string" ? content.length : 0,
          status: result.status,
        });
        DreamDiagnostics.recordCapture(result.status);
        const httpStatus = result.status === "rejected" ? 400 : result.status === "error" ? 500 : 200;
        return res.status(httpStatus).json({ ...result, ...(extractionStatus ? { extraction_status: extractionStatus } : {}), request_id: requestId });
      }

      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Missing or invalid content (must be a non-empty string)" });
      }
      const sessId = session_id || `session_${Date.now()}`;
      const projectName = await resolveProjectName(project || "global");
      const prov = provider || "generic";

      await logActivity(auth, "ingest_session", { session_id: sessId, project: projectName, provider: prov });

      const result = await DreamPipelineService.runSessionIngestion({
        content,
        sessionId: sessId,
        project: projectName,
        provider: prov,
      });

      res.json(result);
    } catch (err) {
      if (isEventCapture) DreamDiagnostics.recordCapture('error');
      else DreamDiagnostics.recordFailure();
      handleError(res, err, "IngestSession");
    }
  });

  app.post('/api/dreams/reconcile-pending', reconcileRateLimiter, authMiddleware, async (req, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const auth = executionAuth(body.tenant_id);
      if (!auth) return res.status(403).json({ success: false, error: 'Tenant scope override requires admin access' });
      const projectId = body.project_id ?? body.project;
      if ((projectId !== undefined && typeof projectId !== 'string') ||
          (body.event_id !== undefined && (typeof body.event_id !== 'string' || !body.event_id.trim() || body.event_id.length > 255)) ||
          (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 500))) {
        return res.status(400).json({ success: false, error: 'Invalid reconciliation scope or limit' });
      }
      const hasFence = body.job_key !== undefined || body.owner_token !== undefined || body.fencing_token !== undefined;
      const runFence = !hasFence ? undefined : typeof body.job_key === 'string' && /^[a-f0-9]{64}$/.test(body.job_key) &&
        typeof body.owner_token === 'string' && /^[a-f0-9-]{36}$/.test(body.owner_token) && Number.isSafeInteger(body.fencing_token) && Number(body.fencing_token) > 0
        ? { jobKey: body.job_key, ownerToken: body.owner_token, fencingToken: Number(body.fencing_token) } : null;
      if (runFence === null) return res.status(400).json({ success: false, error: 'Invalid scheduler lease fence' });
      const result = await authStorage.run(auth, () => DreamPipelineService.reconcilePendingIngests({
        projectId: typeof projectId === 'string' && projectId ? projectId : undefined,
        eventId: typeof body.event_id === 'string' ? body.event_id : undefined,
        limit: Number(body.limit || 100), runFence, useModel: true,
      }));
      const days = Number(process.env.CODEATLAS_MEMORY_SOURCE_RETENTION_DAYS || 7);
      const before = new Date(Date.now() - Math.max(1, Math.min(30, Number.isFinite(days) ? days : 7)) * 86_400_000).toISOString();
      const retention = result.success ? await authStorage.run(auth, () => MemoryIngestionService.expireProcessedSources({ before, projectId: typeof projectId === 'string' ? projectId : undefined })) : { expired: 0 };
      res.json({ ...result, sources_expired: retention.expired });
    } catch (err) { handleError(res, err, 'ReconcilePending'); }
  });

  // POST /api/dreams/generate-daily-dreams — trigger daily dream generation from all recent sessions
  app.post("/api/dreams/generate-daily-dreams", authMiddleware, async (req, res) => {
    try {
      const auth = executionAuth(req.body?.tenant_id);
      if (!auth) return res.status(403).json({ success: false, error: 'Tenant scope override requires admin access' });
      const { project, project_id, provider, run_id, scheduled_for, job_key, owner_token, fencing_token } = req.body as {
        project?: string;
        project_id?: string;
        provider?: string;
        run_id?: string;
        scheduled_for?: string;
        job_key?: string;
        owner_token?: string;
        fencing_token?: number;
      };
      if (project_id !== undefined && (typeof project_id !== "string" || !project_id.trim() || project_id.length > 512)) {
        return res.status(400).json({ success: false, error: "Invalid canonical project scope" });
      }

      const hasFence = job_key !== undefined || owner_token !== undefined || fencing_token !== undefined;
      const runFence = !hasFence
        ? undefined
        : typeof job_key === "string" && /^[a-f0-9]{64}$/.test(job_key)
          && typeof owner_token === "string" && /^[a-f0-9-]{36}$/.test(owner_token)
          && Number.isSafeInteger(fencing_token) && (fencing_token as number) > 0
          ? { jobKey: job_key, ownerToken: owner_token, fencingToken: fencing_token as number }
          : null;
      if (runFence === null) return res.status(400).json({ success: false, error: "Invalid scheduler lease fence" });

      await logActivity(auth, "generate_daily_dreams", { project, provider });

      const projectName = await authStorage.run(auth, () => resolveProjectName(project || ""));
      const result = await authStorage.run(auth, () => DreamPipelineService.runDailyPipeline({
        project: projectName || undefined,
        projectId: project_id?.trim(),
        provider: provider || undefined,
        runId: typeof run_id === "string" && run_id.trim() ? run_id.trim() : undefined,
        runAt: typeof scheduled_for === "string" && scheduled_for.trim() ? scheduled_for.trim() : undefined,
        runFence,
      }));

      res.json(result);
    } catch (err) {
      handleError(res, err, "GenerateDailyDreams");
    }
  });
}
