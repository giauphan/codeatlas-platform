import crypto from "node:crypto";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { generateEmbedding } from "./embeddingService.js";
import { createDatabaseAdapter } from "../database/factory.js";
import { buildInClause } from "../database/utils.js";
import { checkNoiseBlocklist } from "./noiseBlocklist.js";
import { countMatching } from "../utils/array.js";
import { DreamDiagnostics } from "./dreamDiagnostics.js";
import { DreamProjectIdentityService } from "./dreamProjectIdentityService.js";
import { redactMemoryText, validateGroundedCandidates, type StructuredMemory, type ExtractionSourceEvent } from "./structuredMemoryExtractor.js";

async function writeSaveReceipt(
  db: ReturnType<typeof createDatabaseAdapter>,
  tenantId: string,
  project: string,
  idempotencyKey: string,
  requestHash: string,
  status: "stored" | "duplicate" | "filtered",
  memoryId?: string,
): Promise<DreamSaveAcknowledgement> {
  await db.execute(
    `INSERT INTO dream_save_receipts (tenant_id, project, idempotency_key, request_hash, status, memory_id)
     VALUES (:tenantId, :project, :idempotencyKey, :requestHash, :status, :memoryId)
     ON CONFLICT DO NOTHING`,
    { tenantId, project, idempotencyKey, requestHash, status, memoryId: memoryId ?? null },
  );
  const rows = await db.query<{ request_hash: string; status: string; memory_id: string | null }>(
    `SELECT request_hash, status, memory_id FROM dream_save_receipts
     WHERE tenant_id = :tenantId AND project = :project AND idempotency_key = :idempotencyKey LIMIT 1`,
    { tenantId, project, idempotencyKey },
  );
  if (!rows.length) return { status: "error", persisted: false, reason_code: "receipt_missing" };
  if (rows[0].request_hash !== requestHash) return { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
  const storedStatus = rows[0].status;
  if (storedStatus === "filtered") return { status: "filtered", persisted: false, reason_code: "noise_blocked" };
  return {
    status: status === "stored" && storedStatus === "stored" ? "stored" : "duplicate",
    persisted: Boolean(rows[0].memory_id),
    ...(rows[0].memory_id ? { id: rows[0].memory_id } : {}),
  };
}

/**
 * Stop words for noise gate — English + Vietnamese.
 * used by checkNoise() to filter low-information-content dreams.
 */
const STOP_WORDS = new Set([
  'a','an','the','is','it','was','are','been','being','have','has','had',
  'do','does','did','will','would','can','could','should','may','might',
  'shall','to','of','in','for','on','with','at','by','from','as','into',
  'through','during','before','after','above','below','between','out',
  'off','over','under','again','further','then','once','here','there',
  'when','where','why','how','all','each','every','both','few','more',
  'most','other','some','such','no','nor','not','only','own','same',
  'so','than','too','very','just','about','up','and','but','or','if',
  'because','until','while','of','that','this','these','those','i',
  'me','my','myself','we','our','ours','you','your','yours','he','him',
  'his','she','her','hers','it','its','they','them','their','theirs',
  'what','which','who','whom','this','that','these','those','am',
  'are','is','was','were','be','been','being','have','has','had',
  'having','do','does','did','doing','would','could','should','might',
  'must','shall','can','need','dare','ought','used',
  // Vietnamese stop words
  'của','và','có','là','trong','với','không','các','được','người',
  'nhưng','hoặc','như','đã','sẽ','đang','này','khi','từ','nếu',
  'vì','nên','mà','để','cho','vào','ra','lên','xuống','cùng',
  'tôi','bạn','anh','chị','em','nó','họ','chúng','ấy','đó',
  'những','một','nhiều','ít','rất','hơn','kém','quá','lắm','nữa',
  'mới','cũ','vẫn','chưa','phải','bị','đều','hay','thì','vậy',
]);

/**
 * Memory types for dreaming memories
 */
export type DreamMemoryType = 'MISTAKE' | 'PREFERENCE' | 'KNOWLEDGE' | 'PATTERN' | 'A2A_SHARED_CONTEXT' | 'FEEDBACK' | 'SESSION_SUMMARY';

export interface DreamMemory {
  id: string;
  sessionId: string;
  project: string;
  projectId?: string;
  provider?: string;
  memoryType: DreamMemoryType;
  content: string;
  importance: number;
  createdAt: string;
  tenantId: string;
  scope?: string;
  tags?: string[];
  relatedIds?: string[];
  /** Lifecycle fields — set on save, updated on retrieval/consolidation */
  confidence?: number;
  status?: string;
  supersededBy?: string;
  evidenceCount?: number;
  accessCount?: number;
  lastAccessedAt?: string;
  version?: number;
}

export type DreamSaveStatus = "stored" | "duplicate" | "filtered" | "rejected" | "error";

export interface DreamSaveAcknowledgement {
  status: DreamSaveStatus;
  persisted: boolean;
  id?: string;
  reason_code?: string;
}

export interface DreamSaveInput {
  project: string;
  projectId?: string;
  displayName?: string;
  workspacePath?: string;
  projectAliases?: string[];
  sessionId: string;
  memoryType: DreamMemoryType;
  content: string;
  importance: number;
  aiModel?: string;
  scope?: string;
  tags?: string[];
  relatedIds?: string[];
  idempotencyKey?: string;
  /** Internal evidence-validated extraction path; never copied from API input. */
  structuredEvidence?: { memory: StructuredMemory; events: ExtractionSourceEvent[] };
}

/**
 * Service to manage Dreaming Memories in SQLite with sqlite-vec.
 * Dreaming memories let CodeAtlas store learned patterns, mistakes,
 * preferences, and knowledge discovered during code analysis — surfaced
 * as "dreams" that guide future suggestions.
 */
export class DreamingService {
  /** Track pending fire-and-forget database writes for graceful shutdown */
  static readonly activeBackgroundTasks = new Set<Promise<unknown>>();

  /**
   * Waits for pending background tasks to settle, up to a specified timeout.
   * Logs a warning if any tasks are still pending after the timeout.
   */
  static async waitForBackgroundTasks(timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (DreamingService.activeBackgroundTasks.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break; // Timeout triggered

      logger.info(`Waiting for ${DreamingService.activeBackgroundTasks.size} pending database writes to complete...`);

      let settled = false;
      const settlePromise = Promise.allSettled(Array.from(DreamingService.activeBackgroundTasks)).then(() => { settled = true; });

      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise(resolve => {
        timeoutId = setTimeout(resolve, remainingMs);
      });

      await Promise.race([settlePromise, timeoutPromise]);
      clearTimeout(timeoutId!); // Ensure event loop isn't held open if settle wins

      if (!settled) {
        break; // Timeout triggered
      }
      // If we finished successfully but new tasks were added, the while loop will re-check
    }

    if (DreamingService.activeBackgroundTasks.size > 0) {
      logger.warn(`${DreamingService.activeBackgroundTasks.size} background database writes were dropped during graceful shutdown due to timeout.`);
    }
  }


  /** Cache of detected columns so we only check once per process lifetime */
  static _hasLifecycleColumns: boolean | null = null;
  static _hasContentHashColumn: boolean | null = null;

  /** Initializes the SQLite schema and caches available dream-memory columns. */
  static async initialize(): Promise<void> {
    const db = createDatabaseAdapter();
    await db.connect();
    await db.initializeSchema();
    DreamingService._hasContentHashColumn = await db.checkColumnExists("ai_dreaming_memory", "content_hash");
    DreamingService._hasLifecycleColumns = await db.checkColumnExists("ai_dreaming_memory", "status");
    logger.info("[Dreaming] SQLite schema initialized");
  }

  /**
   * Calculates initial confidence for a dream based on memory type and importance.
   * MISTAKE/Critical = higher base, KNOWLEDGE/Random = lower base.
   * Used by saveDreamMemory and the noise gate.
   */
  static calcInitialConfidence(memoryType: DreamMemoryType, importance: number): number {
    // Base confidence by type
    const typeBase: Record<string, number> = {
      MISTAKE: 0.65,
      PREFERENCE: 0.55,
      KNOWLEDGE: 0.50,
      PATTERN: 0.60,
      FEEDBACK: 0.45,
      A2A_SHARED_CONTEXT: 0.40,
    };
    const base = typeBase[memoryType] ?? 0.50;
    // Importance boosts: imp 1-3 → -0.15, 4-6 → 0, 7-8 → +0.15, 9-10 → +0.25
    const impBoost = importance >= 9 ? 0.25 : importance >= 7 ? 0.15 : importance <= 3 ? -0.15 : 0;
    return Math.min(0.99, Math.max(0.05, base + impBoost));
  }

  /**
   * Relevance floor for vector-scored dream retrieval. Reads
   * CODEATLAS_DREAM_MIN_SCORE (0 disables). Dreams whose blended finalScore
   * falls below this are dropped before injection, so weak/off-topic memories
   * (e.g. historical notes surfaced by a broad query) never reach the prompt.
   */
  static dreamMinScore(): number {
    const raw = process.env.CODEATLAS_DREAM_MIN_SCORE;
    if (!raw) return 0;
    const val = Number(raw);
    return Number.isFinite(val) && val > 0 ? val : 0;
  }

  /**
   * Noise gate: reject low-value dreams before saving.
   * Checks content quality, minimum importance thresholds, and stop-word ratio.
   * Returns { isNoise, reason } for logging.
   */
  static checkNoise(
    memoryType: DreamMemoryType,
    content: string,
    importance: number
  ): { isNoise: boolean; reason: string | null } {
    // Empty or too-short content
    const trimmed = (content || '').trim();
    if (!trimmed) return { isNoise: true, reason: 'empty content' };

    let minLength = 40;
    let maxLength = 2000;
    if (memoryType === 'SESSION_SUMMARY') {
      minLength = 100;
      maxLength = 5000;
    }

    if (trimmed.length < minLength) return { isNoise: true, reason: `too short (${trimmed.length} chars, min ${minLength})` };
    if (trimmed.length > maxLength) return { isNoise: true, reason: `too long (${trimmed.length} chars, max ${maxLength})` };

    // Minimum importance thresholds by type
    const minImportance: Record<string, number> = {
      KNOWLEDGE: 3,
      PREFERENCE: 2,
      PATTERN: 3,
      MISTAKE: 3,
      FEEDBACK: 1,
      A2A_SHARED_CONTEXT: 1,
      SESSION_SUMMARY: 3,
    };
    const minImp = minImportance[memoryType] ?? 2;
    if (importance < minImp) return { isNoise: true, reason: `importance ${importance} < minimum ${minImp} for ${memoryType}` };

    // Content quality: check information density via stop-word ratio
    // Use Unicode-aware regex to preserve Vietnamese letters (e.g., 'của', 'là')
    const words = trimmed.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, ''));
    const wordsLen = words.length;
    const stopWordCount = countMatching(words, w => STOP_WORDS.has(w.toLowerCase()));
    const stopRatio = wordsLen > 0 ? stopWordCount / wordsLen : 1;

    // If >80% stop words, it's noise (e.g., "Sẵn sàng. Cần tôi làm gì?")
    if (stopRatio > 0.80 && words.length > 0) {
      return { isNoise: true, reason: `stop-word ratio ${stopRatio.toFixed(2)} > 0.80` };
    }

    // Save-gate: reject known junk themes (English-study scraps, shopping
    // lists, weather/lifestyle notes, scheduler retries) that pass the
    // length/importance/stop-ratio checks.
    const blocklist = checkNoiseBlocklist(trimmed);
    if (blocklist.isNoise) {
      return { isNoise: true, reason: blocklist.reason };
    }

    return { isNoise: false, reason: null };
  }

  /**
   * Inject-gate: strips blocklisted dreams from query results so junk already
   * stored (or that slipped past save-gate) never reaches context injection.
   * Handles both column-named rows and positional array rows
   * where content is column index 5.
   */
  private static filterNoiseRows(rows: any[]): any[] {
    return rows.filter((row: any) => {
      const content = row && typeof row === 'object'
        ? String(row['content'] ?? row['CONTENT'] ?? row[5] ?? '')
        : '';
      return !checkNoiseBlocklist(content).isNoise;
    });
  }

  /**
   * Saves a dreaming memory.
   * Generates an embedding vector from content, then inserts the record.
   */
  static async saveDreamMemory(
    project: string,
    sessionId: string,
    memoryType: DreamMemoryType,
    content: string,
    importance: number,
    aiModel?: string,
    scope?: string,
    tags?: string[],
    relatedIds?: string[],
    idempotencyKey?: string
  ): Promise<string> {
    const result = await DreamingService.saveDreamMemoryWithAck({
      project,
      sessionId,
      memoryType,
      content,
      importance,
      aiModel,
      scope,
      tags,
      relatedIds,
      idempotencyKey,
    });
    if (result.id) return result.id;
    if (result.status === "filtered") return "__noise_blocked__";
    throw new Error(result.reason_code || "Dream memory save failed");
  }

  static async saveDreamMemoryWithAck(input: DreamSaveInput): Promise<DreamSaveAcknowledgement> {
    // Enforce the privacy boundary for direct API/MCP callers as well as hooks.
    // The embedding provider never receives the original credential values.
    input = { ...input, content: redactMemoryText(input.content) };
    const tenantId = authStorage.getStore()!.uid;
    const projectId = input.projectId?.trim() || input.project;
    const contentHash = crypto.createHash("sha256").update(input.content).digest("hex");
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      projectId,
      sessionId: input.sessionId,
      memoryType: input.memoryType,
      content: input.content,
      importance: input.importance,
      aiModel: input.aiModel ?? null,
      scope: input.scope ?? null,
      tags: input.tags ?? null,
      relatedIds: input.relatedIds ?? null,
    })).digest("hex");
    const db = createDatabaseAdapter();
    let legacyProjectAliases: string[] = [];

    try {
      if (input.projectId) {
        const identity = await DreamProjectIdentityService.register({
          projectId,
          displayName: input.displayName ?? input.project,
          aliases: input.projectAliases,
          workspacePath: input.workspacePath ?? input.projectAliases?.find((alias) => alias.includes("/")),
        });
        legacyProjectAliases = identity.aliases;
      }
      if (input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255)) {
        const result: DreamSaveAcknowledgement = {
          status: "rejected",
          persisted: false,
          reason_code: "invalid_idempotency_key",
        };
        DreamDiagnostics.recordSave(result.status);
        return result;
      }

      if (input.idempotencyKey) {
        const existingReceipt = await db.query<{ request_hash: string; status: string; memory_id: string | null }>(
          `SELECT request_hash, status, memory_id FROM dream_save_receipts
           WHERE tenant_id = :tenantId AND project = :project AND idempotency_key = :idempotencyKey LIMIT 1`,
          { tenantId, project: projectId, idempotencyKey: input.idempotencyKey },
        );
        if (existingReceipt.length > 0) {
          const result: DreamSaveAcknowledgement = existingReceipt[0].request_hash !== requestHash
            ? { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" }
            : existingReceipt[0].status === "filtered"
              ? { status: "filtered", persisted: false, reason_code: "noise_blocked" }
              : { status: "duplicate", persisted: Boolean(existingReceipt[0].memory_id), ...(existingReceipt[0].memory_id ? { id: existingReceipt[0].memory_id } : {}) };
          DreamDiagnostics.recordSave(result.status);
          return result;
        }
        const existingByKey = await db.query<{ id: string; request_hash: string }>(
          `SELECT id, request_hash FROM ai_dreaming_memory
           WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
          { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
        );
        if (existingByKey.length > 0) {
          const samePayload = existingByKey[0].request_hash === requestHash;
          const result: DreamSaveAcknowledgement = samePayload
            ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "duplicate", existingByKey[0].id)
            : { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
          DreamDiagnostics.recordSave(result.status);
          return result;
        }
      }

      const structured = input.structuredEvidence;
      const grounded = structured && structured.memory.content === input.content && structured.memory.memoryType === input.memoryType &&
        validateGroundedCandidates([structured.memory], structured.events).length === 1;
      if (structured && !grounded) return { status: 'rejected', persisted: false, reason_code: 'unsupported_evidence' };
      // Structured records already passed semantic/evidence validation. Preserve
      // short task outcomes and long decision caveats; keep the legacy gate for
      // direct saves so compatibility does not weaken that boundary.
      const noiseCheck = grounded
        ? { isNoise: input.content.trim().length < 20 || input.content.length > 8000 || checkNoiseBlocklist(input.content).isNoise, reason: 'invalid_structured_memory' }
        : DreamingService.checkNoise(input.memoryType, input.content, input.importance);
      if (noiseCheck.isNoise) {
        logger.warn(`[Dreaming] Noise gate blocked dream: ${noiseCheck.reason} (type=${input.memoryType} imp=${input.importance})`);
        const result = input.idempotencyKey
          ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "filtered")
          : { status: "filtered" as const, persisted: false, reason_code: "noise_blocked" };
        DreamDiagnostics.recordSave(result.status);
        return result;
      }

      if (DreamingService._hasContentHashColumn) {
        const legacyAliasFilter = legacyProjectAliases.length > 0
          ? ` OR (project_id IS NULL AND project IN (${legacyProjectAliases.map((_, index) => `:legacyProject${index}`).join(", ")}))`
          : "";
        const contentBinds: Record<string, unknown> = { tenantId, projectId, project: input.project, memoryType: input.memoryType, contentHash };
        legacyProjectAliases.forEach((alias, index) => { contentBinds[`legacyProject${index}`] = alias; });
        const existingByContent = await db.query<{ id: string }>(
          `SELECT id FROM ai_dreaming_memory
           WHERE tenant_id = :tenantId AND memory_type = :memoryType AND content_hash = :contentHash
             AND (project_id = :projectId OR (project_id IS NULL AND project = :project)${legacyAliasFilter}) LIMIT 1`,
          contentBinds,
        );
        if (existingByContent.length > 0) {
          const result: DreamSaveAcknowledgement = input.idempotencyKey
            ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "duplicate", existingByContent[0].id)
            : { status: "duplicate", persisted: true, id: existingByContent[0].id };
          DreamDiagnostics.recordSave(result.status);
          return result;
        }
      }

      const { id: proposedId, inserted } = await DreamingService.persistDreamMemory(input, tenantId, contentHash, requestHash, projectId);
      if (!inserted && input.idempotencyKey) {
        const existingByKey = await db.query<{ id: string; request_hash: string }>(
          `SELECT id, request_hash FROM ai_dreaming_memory
           WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
          { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
        );
        if (existingByKey.length > 0) {
          const samePayload = existingByKey[0].request_hash === requestHash;
          const result: DreamSaveAcknowledgement = samePayload
            ? { status: "duplicate", persisted: true, id: existingByKey[0].id }
            : { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
          DreamDiagnostics.recordSave(result.status);
          return result;
        }
      }
      const savedRows = DreamingService._hasContentHashColumn
        ? await db.query<{ id: string }>(
          `SELECT id FROM ai_dreaming_memory
           WHERE tenant_id = :tenantId AND memory_type = :memoryType AND content_hash = :contentHash
             AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) LIMIT 1`,
          { tenantId, projectId, project: input.project, memoryType: input.memoryType, contentHash },
        )
        : input.idempotencyKey
          ? await db.query<{ id: string }>(
            `SELECT id FROM ai_dreaming_memory
             WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
            { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
          )
          : [];
      if (!inserted && savedRows.length === 0) {
        const result: DreamSaveAcknowledgement = { status: "error", persisted: false, reason_code: "save_conflict" };
        DreamDiagnostics.recordSave(result.status);
        return result;
      }
      const result: DreamSaveAcknowledgement = input.idempotencyKey
        ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, inserted ? "stored" : "duplicate", savedRows[0]?.id ?? proposedId)
        : { status: inserted ? "stored" : "duplicate", persisted: true, id: savedRows[0]?.id ?? proposedId };
      DreamDiagnostics.recordSave(result.status);
      return result;
    } catch {
      if (input.idempotencyKey) {
        try {
          const receipt = await db.query<{ request_hash: string; status: string; memory_id: string | null }>(
            `SELECT request_hash, status, memory_id FROM dream_save_receipts
             WHERE tenant_id = :tenantId AND project = :project AND idempotency_key = :idempotencyKey LIMIT 1`,
            { tenantId, project: projectId, idempotencyKey: input.idempotencyKey },
          );
          if (receipt.length > 0) {
            const result: DreamSaveAcknowledgement = receipt[0].request_hash !== requestHash
              ? { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" }
              : receipt[0].status === "filtered"
                ? { status: "filtered", persisted: false, reason_code: "noise_blocked" }
                : { status: "duplicate", persisted: Boolean(receipt[0].memory_id), ...(receipt[0].memory_id ? { id: receipt[0].memory_id } : {}) };
            DreamDiagnostics.recordSave(result.status);
            return result;
          }
          const existing = await db.query<{ id: string; request_hash: string }>(
          `SELECT id, request_hash FROM ai_dreaming_memory
             WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
            { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
          );
          if (existing.length > 0) {
            const samePayload = existing[0].request_hash === requestHash;
            const result: DreamSaveAcknowledgement = samePayload
              ? { status: "duplicate", persisted: true, id: existing[0].id }
              : { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
            DreamDiagnostics.recordSave(result.status);
            return result;
          }
        } catch {
          // The generic error outcome below is intentionally content-free.
        }
      }
      logger.error("[Dreaming] Error saving dream memory");
      const result: DreamSaveAcknowledgement = { status: "error", persisted: false, reason_code: "save_failed" };
      DreamDiagnostics.recordSave(result.status);
      return result;
    }
  }

  private static async persistDreamMemory(input: DreamSaveInput, tenantId: string, contentHash: string, requestHash: string, projectId: string): Promise<{ id: string; inserted: boolean }> {
    // Generate embedding before the write path acquires a database connection.
    const embeddingVector = await generateEmbedding(input.content, 'passage');

    const db = createDatabaseAdapter();
    const id = `${input.project}_${input.memoryType}_${input.sessionId}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const initialConfidence = DreamingService.calcInitialConfidence(input.memoryType, input.importance);
    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
    const relatedIdsJson = input.relatedIds ? JSON.stringify(input.relatedIds) : null;
    try {
      if (DreamingService._hasContentHashColumn && DreamingService._hasLifecycleColumns) {
          const sql = `
            INSERT INTO ai_dreaming_memory (
              id, session_id, project, project_id, provider, memory_type, content, embedding, importance, content_hash, idempotency_key, request_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids
            ) VALUES (
              :id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :contentHash, :idempotencyKey, :requestHash, :initialConfidence, 'active', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson
            )
            ON CONFLICT DO NOTHING
          `;

          const inserted = await db.execute(sql, {
            id,
            sessionId: input.sessionId,
            project: input.project,
            projectId,
            provider: input.aiModel ?? null,
            memoryType: input.memoryType,
            content: input.content,
            contentHash,
            idempotencyKey: input.idempotencyKey ?? null,
            requestHash,
            embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null,
            importance: input.importance,
            initialConfidence,
            tenantId,
            scope: input.scope ?? null,
            tagsJson,
            relatedIdsJson
          });
          return { id, inserted: inserted.rowsAffected > 0 };
      } else {
        // Fallback: simple INSERT when content_hash column is missing
        const cols = DreamingService._hasLifecycleColumns
          ? 'id, session_id, project, project_id, provider, memory_type, content, embedding, importance, idempotency_key, request_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids'
          : 'id, session_id, project, project_id, provider, memory_type, content, embedding, importance, idempotency_key, request_hash, tenant_id, scope, tags, related_ids';
        const vals = DreamingService._hasLifecycleColumns
          ? ':id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :idempotencyKey, :requestHash, :initialConfidence, \'active\', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson'
          : ':id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :idempotencyKey, :requestHash, :tenantId, :scope, :tagsJson, :relatedIdsJson';
        const binds = DreamingService._hasLifecycleColumns
          ? { id, sessionId: input.sessionId, project: input.project, projectId, provider: input.aiModel ?? null, memoryType: input.memoryType, content: input.content, embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null, importance: input.importance, idempotencyKey: input.idempotencyKey ?? null, requestHash, initialConfidence, tenantId, scope: input.scope ?? null, tagsJson, relatedIdsJson }
          : { id, sessionId: input.sessionId, project: input.project, projectId, provider: input.aiModel ?? null, memoryType: input.memoryType, content: input.content, embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null, importance: input.importance, idempotencyKey: input.idempotencyKey ?? null, requestHash, tenantId, scope: input.scope ?? null, tagsJson, relatedIdsJson };

        const inserted = await db.execute(
          `INSERT INTO ai_dreaming_memory (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
          binds
        );
        return { id, inserted: inserted.rowsAffected > 0 };
      }

    } catch (err) {
      logger.error("[Dreaming] Error saving dream memory");
      throw err;
    }
  }

  /**
   * Queries dreaming memories using vector similarity search.
   * Generates an embedding from queryText, then performs cosine similarity search
   * against stored embeddings, returning the top relevant memories.
   */
  static async queryDreamMemories(
    project: string = '',
    queryText: string,
    limit: number = 10,
    offset: number = 0,
    memoryType?: string,
    provider?: string,
    startDate?: Date,
    endDate?: Date,
    scope?: string,
    tags?: string[],
    projectId?: string,
  ) {
    return (await DreamingService.queryDreamMemoriesWithStatus(
      project, queryText, limit, offset, memoryType, provider, startDate, endDate, scope, tags, projectId,
    )).memories;
  }

  static async queryDreamMemoriesWithStatus(
    project: string = '',
    queryText: string,
    limit: number = 10,
    offset: number = 0,
    memoryType?: string,
    provider?: string,
    startDate?: Date,
    endDate?: Date,
    scope?: string,
    tags?: string[],
    projectId?: string,
    displayName?: string,
    workspacePath?: string,
  ) {
    let queryVector: number[] | null = null;
    queryText = redactMemoryText(queryText);
    try {
      queryVector = await generateEmbedding(queryText, 'query');
    } catch {
      logger.warn("[Dreaming] Query embedding unavailable; using lexical fallback");
    }

    const tenantId = authStorage.getStore()!.uid;
    const db = createDatabaseAdapter();
    let projectAliases: string[] = [];
    if (projectId) {
      // A read cannot claim caller-supplied aliases. Only mappings registered
      // during an authenticated write or explicit migration authorize dual read.
      projectAliases = await DreamProjectIdentityService.getAliases(projectId);
    }
    let vectorSearchIds: string[] = [];
    let vectorScores: Record<string, number> = {};
      const filters: string[] = [];
      const binds: Record<string, unknown> = { tenantId };
      if (projectId) {
        const aliases = projectAliases.map((_, index) => `:projectAlias${index}`);
        filters.push(`(project_id = :projectId OR (project_id IS NULL AND project IN (${aliases.length ? aliases.join(", ") : ":projectId"})))`);
        binds.projectId = projectId;
        projectAliases.forEach((alias, index) => { binds[`projectAlias${index}`] = alias; });
      } else if (project) {
        filters.push("project = :project");
        binds.project = project;
      }
      if (provider) { filters.push("provider = :provider"); binds.provider = provider; }
      if (startDate) { filters.push("created_at >= :startDate"); binds.startDate = startDate; }
      if (endDate) { filters.push("created_at <= :endDate"); binds.endDate = endDate; }
      if (scope) {
        filters.push("(scope = :scopeExact OR scope LIKE :scopeLike)");
        binds.scopeExact = scope;
        binds.scopeLike = `${scope}/%`;
      }
      if (tags?.length) {
        filters.push(`(${tags.map((_, index) => `tags LIKE :tagLike${index}`).join(" OR ")})`);
        tags.forEach((tag, index) => { binds[`tagLike${index}`] = `%"${tag}"%`; });
      }
      const types = memoryType?.split(",").map((type) => type.trim().toUpperCase()).filter(Boolean) ?? [];
      if (types.length) {
        filters.push(`memory_type IN (${types.map((_, index) => `:memoryType${index}`).join(", ")})`);
        types.forEach((type, index) => { binds[`memoryType${index}`] = type; });
      }
      filters.push("(status IS NULL OR status = 'active')");
      const filterSql = filters.map((filter) => `AND ${filter}`).join(" ");

      if (queryVector) {
        try {
        const searchResults = await db.searchVectorScoped(
          "ai_dreaming_memory",
          queryVector,
          limit + offset,
          tenantId,
          filters.join(" AND ") || "1 = 1",
          Object.fromEntries(Object.entries(binds).filter(([key]) => key !== "tenantId")),
        );
        vectorSearchIds = searchResults.map((result) => result.id);
        searchResults.forEach((result) => { vectorScores[result.id] = result.score; });
        if (vectorSearchIds.length === 0) {
          // Existing rows without embeddings (or an unavailable vector index)
          // remain retrievable through their lexical evidence.
          queryVector = null;
        }
        } catch {
          logger.warn("[Dreaming] Vector index unavailable; using scoped lexical fallback");
          queryVector = null;
        }
      }

      let idFilter = "";
      if (queryVector) {
        idFilter = `AND id IN (${vectorSearchIds.map((_, index) => `:vecId${index}`).join(", ")})`;
        vectorSearchIds.forEach((id, index) => { binds[`vecId${index}`] = id; });
      } else if (queryText.trim()) {
        const lexicalTerms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}_./:#-]{3,}/gu) ?? [])].slice(0, 5);
        if (lexicalTerms.length) {
          const alternatives = lexicalTerms.map((_, index) => `lower(content) LIKE :lexicalTerm${index}`);
          filters.push(`(${alternatives.join(" OR ")})`);
          lexicalTerms.forEach((term, index) => { binds[`lexicalTerm${index}`] = `%${term}%`; });
        } else {
          filters.push("1 = 0");
        }
      }
      const finalFilterSql = filters.map((filter) => `AND ${filter}`).join(" ");
        const selectCols = 'id, session_id, project, project_id, provider, memory_type, content, importance, created_at, confidence, status, evidence_count, access_count, version, scope, tags, related_ids';

        let sql: string;
        if (!queryVector) {
          binds.limit = limit;
          binds.offset = offset;
          const lexicalOrder = queryText.trim() ? "CASE WHEN lower(content) LIKE :lexicalExact THEN 0 ELSE 1 END, " : "";
          if (queryText.trim()) binds.lexicalExact = `%${queryText.trim().toLowerCase()}%`;
          sql = `
            SELECT ${selectCols}
            FROM ai_dreaming_memory
            WHERE tenant_id = :tenantId ${finalFilterSql}
            ORDER BY ${lexicalOrder} created_at DESC
            LIMIT :limit OFFSET :offset
          `;
        } else {
          sql = `
            SELECT ${selectCols}
            FROM ai_dreaming_memory
            WHERE tenant_id = :tenantId ${filterSql} ${idFilter}
          `;
        }

        const rows = await db.query<Record<string, unknown>>(sql, binds);

        // ⚡ Bolt Optimization: Fire and forget DB update to prevent "Write on Read" N+1 blocking
        // Bump access_count non-critically without blocking the query return path.
        if (rows.length > 0) {
          const ids = rows.map(r => r['id'] as string).filter(Boolean);
          if (ids.length > 0) {
            const { clause, binds: inBinds } = buildInClause(ids, { tenantId });
            const updatePromise = db.execute(
              `UPDATE ai_dreaming_memory SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id IN (${clause}) AND tenant_id = :tenantId`,
              inBinds
            ).then(result => {
              const count = result && typeof (result as any).rowsAffected === 'number' ? (result as any).rowsAffected :
                            result && typeof (result as any).affectedRows === 'number' ? (result as any).affectedRows :
                            result && typeof (result as any).rowCount === 'number' ? (result as any).rowCount :
                            result && typeof (result as any).changes === 'number' ? (result as any).changes : undefined;
              if (count !== undefined) {
                logger.debug(`[Dreaming] Bumped access_count for ${count} memories`);
              }
            });
            const updateTask = updatePromise.catch(bumpErr => {
              logger.warn('[Dreaming] Failed to bump access_count:', bumpErr instanceof Error ? bumpErr.message : String(bumpErr));
            });
            DreamingService.activeBackgroundTasks.add(updateTask);
            updateTask.finally(() => {
              DreamingService.activeBackgroundTasks.delete(updateTask);
            });
          }
        }

        let processedRows: any[] = [...rows];

        if (queryVector) {
          // In-memory scoring over vector-search results
          const scored = processedRows.map(row => {
            const id = (row['id'] ?? row['ID']) as string;
            const importance = Number(row['importance'] ?? row['IMPORTANCE']) || 0;
            const rawDate = row['created_at'] ?? row['CREATED_AT'];
            const createdAtDate = rawDate instanceof Date ? rawDate : new Date(String(rawDate ?? ''));
            const scopeVal = row['scope'] ?? row['SCOPE'];
            const confidence = Number(row['confidence'] ?? row['CONFIDENCE'] ?? 0.50);
            const evidenceCount = Number(row['evidence_count'] ?? row['EVIDENCE_COUNT']) || 0;
            const baseScore = vectorScores[id] ?? 0;
            const lifecycleBonus = 0.20 * confidence + 0.05 * (evidenceCount > 0 ? Math.min(1.0, Math.log2(evidenceCount + 1) / 5) : 0);
            let scopeBoost = 0;
            if (scope) {
              if (scopeVal === scope) scopeBoost = 0.30;
              else if (typeof scopeVal === 'string' && scopeVal.startsWith(scope + '/')) scopeBoost = 0.15;
            }
            const freshnessDays = (Date.now() - createdAtDate.getTime()) / (1000 * 60 * 60 * 24);
            const freshnessScore = 0.15 * (1.0 - Math.min(1.0, freshnessDays / 90));
            const importanceScore = 0.10 * (importance / 10.0);
            const finalScore = baseScore + lifecycleBonus + scopeBoost + freshnessScore + importanceScore;
            return { row, finalScore };
          });
          scored.sort((a, b) => b.finalScore - a.finalScore);
          const minScore = DreamingService.dreamMinScore();
          const relevant = minScore > 0 ? scored.filter(s => s.finalScore >= minScore) : scored;
          if (relevant.length !== scored.length) {
            logger.info(`[Dreaming] Relevance gate dropped ${scored.length - relevant.length} dream(s) below min score ${minScore}`);
          }
          processedRows = relevant.slice(offset, offset + limit).map(item => item.row);
        }

        const cleanRows = DreamingService.filterNoiseRows(processedRows).map(row => Array.isArray(row)
          ? row.map((value, index) => index === 5 && typeof value === 'string' ? redactMemoryText(value) : value)
          : {
            ...row,
            ...(typeof row.content === 'string' ? { content: redactMemoryText(row.content) } : {}),
            ...(typeof row.CONTENT === 'string' ? { CONTENT: redactMemoryText(row.CONTENT) } : {}),
          });
        if (cleanRows.length !== processedRows.length) {
          logger.info(`[Dreaming] Inject-gate filtered ${processedRows.length - cleanRows.length} noisy dream(s)`);
        }
        let retrievalStatus = cleanRows.length > 0 ? "ok" : rows.length > 0 ? "filtered" : queryText.trim() ? "no_match" : "empty";
        if (!rows.length && queryText.trim()) {
          const inventory = await db.query<{ count: number }>(
            `SELECT COUNT(*) AS count FROM ai_dreaming_memory WHERE tenant_id = :tenantId ${filterSql}`, binds);
          if (Number(inventory[0]?.count || 0) === 0) retrievalStatus = "empty";
        }
        return {
          memories: cleanRows,
          retrieval_status: retrievalStatus,
          candidate_count: rows.length,
          returned_count: cleanRows.length,
        };
  }

  /**
   * Deletes a dreaming memory by its ID.
   */
  static async deleteDreamMemory(id: string): Promise<boolean> {
    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;
    const result = await db.execute(
      `DELETE FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
      { id, tenantId }
    );
    const wasDeleted = (result.rowsAffected ?? 0) > 0;
    if (wasDeleted) logger.info(`[Dreaming] Deleted dream memory: ${id}`);
    else logger.warn(`[Dreaming] Dream memory not found for deletion: ${id}`);
    return wasDeleted;
  }
}
