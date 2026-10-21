import { createHash } from "node:crypto";
import { createDatabaseAdapter } from "../database/factory.js";
import { authStorage } from "../utils/context.js";
import { isSensitiveMemoryFieldName, redactMemoryText } from "./structuredMemoryExtractor.js";
import { DreamProjectIdentityService } from "./dreamProjectIdentityService.js";

const MAX_EVENT_CONTENT_BYTES = 16 * 1024;
const MAX_EVENT_ID_LENGTH = 255;

export type CaptureEventStatus = "stored" | "duplicate" | "filtered" | "rejected" | "error";

export interface CaptureEventInput {
  eventId: string;
  sessionId: string;
  actorRole?: "USER" | "ASSISTANT" | "TOOL";
  memoryTypeHint?: "MISTAKE" | "PREFERENCE" | "KNOWLEDGE" | "PATTERN" | "SESSION_SUMMARY";
  toolName?: string;
  project: string;
  projectId?: string;
  displayName?: string;
  workspacePath?: string;
  content: string;
  checkpoint?: unknown;
  occurredAt?: string;
  sourceSpans?: Array<{ start: number; end: number }>;
}

export interface CaptureEventAck {
  success: boolean;
  status: CaptureEventStatus;
  persisted: boolean;
  acknowledged: boolean;
  event_id: string;
  memory_ids: string[];
  source_persisted?: boolean;
  extraction_status?: "pending";
  reason_code?: string;
}

export interface PendingCaptureEvent extends CaptureEventInput {
  tenantId: string;
  captureSequence: number;
  createdAt: string;
  status: "pending";
  payloadRedacted: true;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactAndNormalize(content: string): string {
  return redactMemoryText(content)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .trim();
}

function sanitizeCheckpoint(value: unknown, depth = 0, key = ""): unknown {
  if (depth > 5) throw new Error("checkpoint_too_deep");
  if (isSensitiveMemoryFieldName(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_checkpoint");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 2000) throw new Error("checkpoint_too_large");
    return redactAndNormalize(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new Error("checkpoint_too_large");
    return value.map((item) => sanitizeCheckpoint(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 50) throw new Error("checkpoint_too_large");
    return Object.fromEntries(entries.map(([entryKey, item]) => [entryKey.slice(0, 100), sanitizeCheckpoint(item, depth + 1, entryKey)]));
  }
  throw new Error("invalid_checkpoint");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function rejected(eventId: string, reasonCode: string): CaptureEventAck {
  return { success: false, status: "rejected", persisted: false, acknowledged: false, event_id: eventId, memory_ids: [], reason_code: reasonCode };
}

export class DreamCaptureStore {
  static async accept(input: CaptureEventInput): Promise<CaptureEventAck> {
    const eventId = typeof input.eventId === "string" ? input.eventId : "";
    if (!eventId.trim() || eventId.length > MAX_EVENT_ID_LENGTH) return rejected(eventId, "invalid_event_id");
    if (typeof input.content !== "string" || !input.content.trim()) return rejected(eventId, "invalid_content");
    if (!input.sessionId || !input.project) return rejected(eventId, "missing_scope");
    if (input.displayName !== undefined && (input.displayName.length > 512 || /[\r\n\0]/.test(input.displayName))) return rejected(eventId, "invalid_display_name");
    if (input.workspacePath !== undefined && (input.workspacePath.length > 2048 || /[\r\n\0]/.test(input.workspacePath))) return rejected(eventId, "invalid_workspace_path");
    if (input.actorRole !== undefined && input.actorRole !== "USER" && input.actorRole !== "ASSISTANT" && input.actorRole !== "TOOL") return rejected(eventId, "invalid_actor_role");
    if (input.memoryTypeHint !== undefined && !["MISTAKE", "PREFERENCE", "KNOWLEDGE", "PATTERN", "SESSION_SUMMARY"].includes(input.memoryTypeHint)) return rejected(eventId, "invalid_memory_type_hint");
    if (input.toolName !== undefined && (input.toolName.length > 128 || /[\r\n\0]/.test(input.toolName))) return rejected(eventId, "invalid_tool_name");

    if (input.sourceSpans && (input.sourceSpans.length > 100 || input.sourceSpans.some(({ start, end }) =>
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start))) {
      return rejected(eventId, "invalid_source_spans");
    }

    const content = redactAndNormalize(input.content);
    if (!content) return rejected(eventId, "empty_after_normalization");
    if (Buffer.byteLength(content, "utf8") > MAX_EVENT_CONTENT_BYTES) return rejected(eventId, "event_too_large");

    const tenantId = authStorage.getStore()?.uid;
    if (!tenantId) return { success: false, status: "error", persisted: false, acknowledged: false, event_id: eventId, memory_ids: [], reason_code: "auth_context_missing" };

    let checkpointJson: string | null;
    try {
      checkpointJson = input.checkpoint === undefined ? null : JSON.stringify(sanitizeCheckpoint(input.checkpoint));
      if (checkpointJson && Buffer.byteLength(checkpointJson, "utf8") > 8 * 1024) return rejected(eventId, "checkpoint_too_large");
    } catch (error) {
      return rejected(eventId, error instanceof Error ? error.message : "invalid_checkpoint");
    }

    const projectId = input.projectId?.trim() || input.project;
    const canonicalPayload = stableJson({
      content,
      sessionId: input.sessionId,
      actorRole: input.actorRole ?? null,
      memoryTypeHint: input.memoryTypeHint ?? null,
      toolName: input.toolName ?? null,
      project: input.project,
      projectId,
      displayName: input.displayName ?? null,
      workspacePath: input.workspacePath ?? null,
      checkpoint: checkpointJson ? JSON.parse(checkpointJson) : null,
      occurredAt: input.occurredAt ?? null,
      sourceSpans: input.sourceSpans ?? null,
    });
    const requestHash = hash(canonicalPayload);
    const db = createDatabaseAdapter();

    try {
      if (input.projectId) await DreamProjectIdentityService.register({ projectId, displayName: input.displayName ?? input.project, workspacePath: input.workspacePath, aliases: [input.project] });
      const prior = await db.query<{ request_hash: string; status: string; memory_ids_json: string }>(
        `SELECT request_hash, status, memory_ids_json FROM dream_capture_events
         WHERE tenant_id = :tenantId AND project_id = :projectId AND event_id = :eventId LIMIT 1`,
        { tenantId, projectId, eventId },
      );
      if (prior.length) {
        if (prior[0].request_hash !== requestHash) return rejected(eventId, "event_id_reused");
        const status = prior[0].status === "filtered" ? "filtered" : "duplicate";
        return {
          success: true,
          status,
          persisted: status !== "filtered",
          acknowledged: true,
          event_id: eventId,
          memory_ids: JSON.parse(prior[0].memory_ids_json || "[]"),
          source_persisted: true,
          ...(prior[0].status === "pending" ? { extraction_status: "pending" as const } : {}),
        };
      }

      const insertion = await db.execute(
        `INSERT INTO dream_capture_events
          (tenant_id, project_id, project, display_name, workspace_path, event_id, session_id, actor_role, memory_type_hint, tool_name, request_hash, content_redacted, checkpoint_json, occurred_at, source_spans_json, status, acknowledged_at, created_at)
         VALUES
          (:tenantId, :projectId, :project, :displayName, :workspacePath, :eventId, :sessionId, :actorRole, :memoryTypeHint, :toolName, :requestHash, :content, :checkpointJson, :occurredAt, :sourceSpansJson, 'pending', :createdAt, :createdAt)
         ON CONFLICT DO NOTHING`,
        {
          tenantId,
          projectId,
          project: input.project,
          displayName: input.displayName ?? null,
          workspacePath: input.workspacePath ?? null,
          eventId,
          sessionId: input.sessionId,
          actorRole: input.actorRole ?? null,
          memoryTypeHint: input.memoryTypeHint ?? null,
          toolName: input.toolName ?? null,
          requestHash,
          content,
          checkpointJson,
          occurredAt: input.occurredAt ?? null,
          sourceSpansJson: input.sourceSpans === undefined ? null : JSON.stringify(input.sourceSpans),
          createdAt: new Date().toISOString(),
        },
      );

      // Re-read after insert so a concurrent delivery only acknowledges the committed canonical event.
      const saved = await db.query<{ request_hash: string; status: string; memory_ids_json: string }>(
        `SELECT request_hash, status, memory_ids_json FROM dream_capture_events
         WHERE tenant_id = :tenantId AND project_id = :projectId AND event_id = :eventId LIMIT 1`,
        { tenantId, projectId, eventId },
      );
      if (!saved.length) return { success: false, status: "error", persisted: false, acknowledged: false, event_id: eventId, memory_ids: [], reason_code: "receipt_missing" };
      if (saved[0].request_hash !== requestHash) return rejected(eventId, "event_id_reused");
      const isNew = insertion.rowsAffected > 0;
      const status = !isNew && saved[0].status === "filtered" ? "filtered" : isNew ? "stored" : "duplicate";
      return {
        success: true,
        status,
        persisted: status !== "filtered",
        acknowledged: true,
        event_id: eventId,
        memory_ids: JSON.parse(saved[0].memory_ids_json || "[]"),
        source_persisted: true,
        ...((isNew || saved[0].status === "pending") ? { extraction_status: "pending" as const } : {}),
      };
    } catch {
      return { success: false, status: "error", persisted: false, acknowledged: false, event_id: eventId, memory_ids: [], reason_code: "ingest_failed" };
    }
  }

  static async reconcilePending(options: { tenantId?: string; projectId?: string; eventId?: string; limit?: number } = {}): Promise<PendingCaptureEvent[]> {
    const auth = authStorage.getStore();
    if (!auth) throw new Error("Auth context required to reconcile captures");
    if (options.tenantId && options.tenantId !== auth.uid && auth.uid !== "admin" && auth.role !== "admin" && auth.tier !== "admin") {
      throw new Error("Tenant scope override requires admin access");
    }
    const tenantId = options.tenantId ?? auth?.uid;
    if (!tenantId) throw new Error("Auth context required to reconcile captures");
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const clauses = ["tenant_id = :tenantId", "status = 'pending'"];
    const binds: Record<string, unknown> = { tenantId, limit };
    if (options.projectId) {
      clauses.push("project_id = :projectId");
      binds.projectId = options.projectId;
    }
    if (options.eventId) { clauses.push("event_id = :eventId"); binds.eventId = options.eventId; }
    const rows = await createDatabaseAdapter().query<Record<string, unknown>>(
      `SELECT tenant_id, project_id, project, display_name, workspace_path, event_id, session_id, actor_role, memory_type_hint, tool_name, content_redacted, checkpoint_json, occurred_at, source_spans_json, capture_sequence, created_at
       FROM dream_capture_events WHERE ${clauses.join(" AND ")} ORDER BY capture_sequence ASC, event_id ASC LIMIT :limit`,
      binds,
    );
    return rows.map((row) => ({
      tenantId: String(row.tenant_id),
      captureSequence: Number(row.capture_sequence),
      createdAt: String(row.created_at),
      projectId: String(row.project_id),
      project: String(row.project),
      displayName: row.display_name == null ? undefined : String(row.display_name),
      workspacePath: row.workspace_path == null ? undefined : String(row.workspace_path),
      eventId: String(row.event_id),
      sessionId: String(row.session_id),
      actorRole: row.actor_role === "USER" || row.actor_role === "ASSISTANT" || row.actor_role === "TOOL" ? row.actor_role : undefined,
      memoryTypeHint: ["MISTAKE", "PREFERENCE", "KNOWLEDGE", "PATTERN", "SESSION_SUMMARY"].includes(String(row.memory_type_hint)) ? row.memory_type_hint as PendingCaptureEvent["memoryTypeHint"] : undefined,
      toolName: row.tool_name == null ? undefined : String(row.tool_name),
      content: String(row.content_redacted),
      checkpoint: row.checkpoint_json ? JSON.parse(String(row.checkpoint_json)) : undefined,
      occurredAt: row.occurred_at == null ? undefined : String(row.occurred_at),
      sourceSpans: row.source_spans_json ? JSON.parse(String(row.source_spans_json)) : undefined,
      status: "pending" as const,
      payloadRedacted: true as const,
    }));
  }
}
