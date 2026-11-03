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

interface DreamQueryFilters {
  filters: string[];
  binds: Record<string, unknown>;
  baseFilterSql: string;
  vectorIds?: string[];
}

interface DreamVectorSearch {
  ids: string[];
  scores: Record<string, number>;
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
  static _hasLifecycleColumns: boolean | null = null; // NOSONAR
  static _hasContentHashColumn: boolean | null = null; // NOSONAR

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
    let impBoost = 0;
    if (importance >= 9) {
      impBoost = 0.25;
    } else if (importance >= 7) {
      impBoost = 0.15;
    } else if (importance <= 3) {
      impBoost = -0.15;
    }
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
    ...optionalArgs: [
      aiModel?: string,
      scope?: string,
      tags?: string[],
      relatedIds?: string[],
      idempotencyKey?: string,
    ]
  ): Promise<string> {
    const [aiModel, scope, tags, relatedIds, idempotencyKey] = optionalArgs;
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
    try {
      const aliases = await DreamingService.registerProjectAliases(input, projectId);
      if (DreamingService.hasInvalidIdempotencyKey(input)) return DreamingService.recordSaveResult({ status: "rejected", persisted: false, reason_code: "invalid_idempotency_key" });
      const db = createDatabaseAdapter();
      const existing = await DreamingService.findExistingIdempotentSave(db, input, tenantId, projectId, requestHash);
      if (existing) return DreamingService.recordSaveResult(existing);
      const noiseResult = await DreamingService.checkDreamSaveNoise(input, db, tenantId, projectId, requestHash);
      if (noiseResult) return noiseResult;
      const duplicate = await DreamingService.findContentDuplicate(db, input, tenantId, projectId, contentHash, requestHash, aliases);
      if (duplicate) return duplicate;
      return await DreamingService.persistAndAcknowledgeSave(db, input, tenantId, projectId, contentHash, requestHash);
    } catch {
      logger.error("[Dreaming] Error saving dream memory");
      return DreamingService.recoverDreamSaveFailure(input, tenantId, projectId, requestHash);
    }
  }

  private static recordSaveResult(result: DreamSaveAcknowledgement): DreamSaveAcknowledgement {
    DreamDiagnostics.recordSave(result.status);
    return result;
  }

  private static async registerProjectAliases(input: DreamSaveInput, projectId: string): Promise<string[]> {
    if (!input.projectId) return [];
    const identity = await DreamProjectIdentityService.register({
      projectId,
      displayName: input.displayName ?? input.project,
      aliases: input.projectAliases,
      workspacePath: input.workspacePath ?? input.projectAliases?.find((alias) => alias.includes("/")),
    });
    return identity.aliases;
  }

  private static hasInvalidIdempotencyKey(input: DreamSaveInput): boolean {
    return input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255);
  }

  private static async findExistingIdempotentSave(
    db: ReturnType<typeof createDatabaseAdapter>, input: DreamSaveInput, tenantId: string, projectId: string, requestHash: string,
  ): Promise<DreamSaveAcknowledgement | null> {
    if (!input.idempotencyKey) return null;
    const params = { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey };
    const receipts = await db.query<{ request_hash: string; status: string; memory_id: string | null }>(
      `SELECT request_hash, status, memory_id FROM dream_save_receipts
       WHERE tenant_id = :tenantId AND project = :project AND idempotency_key = :idempotencyKey LIMIT 1`,
      { tenantId, project: projectId, idempotencyKey: input.idempotencyKey },
    );
    if (receipts.length) return DreamingService.receiptAcknowledgement(receipts[0], requestHash);
    const memories = await db.query<{ id: string; request_hash: string }>(
      `SELECT id, request_hash FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
      params,
    );
    if (!memories.length) return null;
    if (memories[0].request_hash !== requestHash) return { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
    return writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "duplicate", memories[0].id);
  }

  private static receiptAcknowledgement(
    receipt: { request_hash: string; status: string; memory_id: string | null }, requestHash: string,
  ): DreamSaveAcknowledgement {
    if (receipt.request_hash !== requestHash) return { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" };
    if (receipt.status === "filtered") return { status: "filtered", persisted: false, reason_code: "noise_blocked" };
    return { status: "duplicate", persisted: Boolean(receipt.memory_id), ...(receipt.memory_id ? { id: receipt.memory_id } : {}) };
  }

  private static async checkDreamSaveNoise(
    input: DreamSaveInput, db: ReturnType<typeof createDatabaseAdapter>, tenantId: string, projectId: string, requestHash: string,
  ): Promise<DreamSaveAcknowledgement | null> {
    const structured = input.structuredEvidence;
    const grounded = structured?.memory.content === input.content && structured?.memory.memoryType === input.memoryType &&
      validateGroundedCandidates([structured.memory], structured.events).length === 1;
    if (structured && !grounded) return { status: "rejected", persisted: false, reason_code: "unsupported_evidence" };
    const noise = grounded
      ? input.content.trim().length < 20 || input.content.length > 8000 || checkNoiseBlocklist(input.content).isNoise
      : DreamingService.checkNoise(input.memoryType, input.content, input.importance).isNoise;
    if (!noise) return null;
    const reason = grounded ? "invalid_structured_memory" : DreamingService.checkNoise(input.memoryType, input.content, input.importance).reason;
    logger.warn(`[Dreaming] Noise gate blocked dream: ${reason} (type=${input.memoryType} imp=${input.importance})`);
    const result = input.idempotencyKey
      ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "filtered")
      : { status: "filtered" as const, persisted: false, reason_code: "noise_blocked" };
    return DreamingService.recordSaveResult(result);
  }

  private static async findContentDuplicate(
    db: ReturnType<typeof createDatabaseAdapter>, input: DreamSaveInput, tenantId: string, projectId: string,
    contentHash: string, requestHash: string, aliases: string[],
  ): Promise<DreamSaveAcknowledgement | null> {
    if (!DreamingService._hasContentHashColumn) return null;
    const aliasParameters = aliases.map((_, index) => `:legacyProject${index}`).join(", ");
    const aliasFilter = aliases.length ? ` OR (project_id IS NULL AND project IN (${aliasParameters}))` : "";
    const binds: Record<string, unknown> = { tenantId, projectId, project: input.project, memoryType: input.memoryType, contentHash };
    aliases.forEach((alias, index) => { binds[`legacyProject${index}`] = alias; });
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND memory_type = :memoryType AND content_hash = :contentHash
         AND (project_id = :projectId OR (project_id IS NULL AND project = :project)${aliasFilter}) LIMIT 1`,
      binds,
    );
    if (!existing.length) return null;
    const result = input.idempotencyKey
      ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, "duplicate", existing[0].id)
      : { status: "duplicate" as const, persisted: true, id: existing[0].id };
    return DreamingService.recordSaveResult(result);
  }

  private static async persistAndAcknowledgeSave(
    db: ReturnType<typeof createDatabaseAdapter>, input: DreamSaveInput, tenantId: string, projectId: string, contentHash: string, requestHash: string,
  ): Promise<DreamSaveAcknowledgement> {
    const { id: proposedId, inserted } = await DreamingService.persistDreamMemory(input, tenantId, contentHash, requestHash, projectId);
    if (!inserted && input.idempotencyKey) {
      const matchingKey = await db.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM ai_dreaming_memory
         WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
        { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
      );
      if (matchingKey.length) return DreamingService.recordSaveResult(matchingKey[0].request_hash === requestHash
        ? { status: "duplicate", persisted: true, id: matchingKey[0].id }
        : { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" });
    }
    const savedRows = await DreamingService.findPersistedRows(db, input, tenantId, projectId, contentHash);
    if (!inserted && !savedRows.length) return DreamingService.recordSaveResult({ status: "error", persisted: false, reason_code: "save_conflict" });
    const id = savedRows[0]?.id ?? proposedId;
    const saveStatus = inserted ? "stored" as const : "duplicate" as const;
    const result = input.idempotencyKey
      ? await writeSaveReceipt(db, tenantId, projectId, input.idempotencyKey, requestHash, saveStatus, id)
      : { status: saveStatus, persisted: true, id };
    return DreamingService.recordSaveResult(result);
  }

  private static async findPersistedRows(
    db: ReturnType<typeof createDatabaseAdapter>, input: DreamSaveInput, tenantId: string, projectId: string, contentHash: string,
  ): Promise<Array<{ id: string }>> {
    if (DreamingService._hasContentHashColumn) {
      return db.query<{ id: string }>(
        `SELECT id FROM ai_dreaming_memory
         WHERE tenant_id = :tenantId AND memory_type = :memoryType AND content_hash = :contentHash
           AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) LIMIT 1`,
        { tenantId, projectId, project: input.project, memoryType: input.memoryType, contentHash },
      );
    }
    if (!input.idempotencyKey) return [];
    return db.query<{ id: string }>(
      `SELECT id FROM ai_dreaming_memory
       WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
      { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
    );
  }

  private static async recoverDreamSaveFailure(
    input: DreamSaveInput, tenantId: string, projectId: string, requestHash: string,
  ): Promise<DreamSaveAcknowledgement> {
    if (input.idempotencyKey) {
      try {
        const db = createDatabaseAdapter();
        const receipts = await db.query<{ request_hash: string; status: string; memory_id: string | null }>(
          `SELECT request_hash, status, memory_id FROM dream_save_receipts
           WHERE tenant_id = :tenantId AND project = :project AND idempotency_key = :idempotencyKey LIMIT 1`,
          { tenantId, project: projectId, idempotencyKey: input.idempotencyKey },
        );
        if (receipts.length) return DreamingService.recordSaveResult(DreamingService.receiptAcknowledgement(receipts[0], requestHash));
        const memories = await db.query<{ id: string; request_hash: string }>(
          `SELECT id, request_hash FROM ai_dreaming_memory
           WHERE tenant_id = :tenantId AND (project_id = :projectId OR (project_id IS NULL AND project = :project)) AND idempotency_key = :idempotencyKey LIMIT 1`,
          { tenantId, projectId, project: input.project, idempotencyKey: input.idempotencyKey },
        );
        if (memories.length) return DreamingService.recordSaveResult(memories[0].request_hash === requestHash
          ? { status: "duplicate", persisted: true, id: memories[0].id }
          : { status: "rejected", persisted: false, reason_code: "idempotency_key_reused" });
      } catch {
        // Keep the generic error outcome content-free when receipt recovery also fails.
      }
    }
    return DreamingService.recordSaveResult({ status: "error", persisted: false, reason_code: "save_failed" });
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
      const embedding = embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null;
      const insert = DreamingService.buildDreamMemoryInsert({ input, id, projectId, contentHash, requestHash, embedding, initialConfidence, tenantId, tagsJson, relatedIdsJson });
      const result = await db.execute(insert.sql, insert.binds);
      return { id, inserted: result.rowsAffected > 0 };

    } catch (err) {
      logger.error("[Dreaming] Error saving dream memory");
      throw err;
    }
  }

  private static buildDreamMemoryInsert(values: {
    input: DreamSaveInput; id: string; projectId: string; contentHash: string; requestHash: string;
    embedding: Uint8Array | null; initialConfidence: number; tenantId: string; tagsJson: string | null; relatedIdsJson: string | null;
  }): { sql: string; binds: Record<string, unknown> } {
    const { input, id, projectId, contentHash, requestHash, embedding, initialConfidence, tenantId, tagsJson, relatedIdsJson } = values;
    const baseBinds = {
      id, sessionId: input.sessionId, project: input.project, projectId, provider: input.aiModel ?? null,
      memoryType: input.memoryType, content: input.content, embedding, importance: input.importance,
      idempotencyKey: input.idempotencyKey ?? null, requestHash, tenantId,
      scope: input.scope ?? null, tagsJson, relatedIdsJson,
    };
    if (DreamingService._hasContentHashColumn && DreamingService._hasLifecycleColumns) {
      return {
        sql: `INSERT INTO ai_dreaming_memory (
          id, session_id, project, project_id, provider, memory_type, content, embedding, importance, content_hash, idempotency_key, request_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids
        ) VALUES (
          :id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :contentHash, :idempotencyKey, :requestHash, :initialConfidence, 'active', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson
        ) ON CONFLICT DO NOTHING`,
        binds: { ...baseBinds, contentHash, initialConfidence },
      };
    }
    const columns = DreamingService._hasLifecycleColumns
      ? 'id, session_id, project, project_id, provider, memory_type, content, embedding, importance, idempotency_key, request_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids'
      : 'id, session_id, project, project_id, provider, memory_type, content, embedding, importance, idempotency_key, request_hash, tenant_id, scope, tags, related_ids';
    const valuesSql = DreamingService._hasLifecycleColumns
      ? ":id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :idempotencyKey, :requestHash, :initialConfidence, 'active', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson"
      : ":id, :sessionId, :project, :projectId, :provider, :memoryType, :content, :embedding, :importance, :idempotencyKey, :requestHash, :tenantId, :scope, :tagsJson, :relatedIdsJson";
    return {
      sql: `INSERT INTO ai_dreaming_memory (${columns}) VALUES (${valuesSql}) ON CONFLICT DO NOTHING`,
      binds: DreamingService._hasLifecycleColumns ? { ...baseBinds, initialConfidence } : baseBinds,
    };
  }

  /**
   * Queries dreaming memories using vector similarity search.
   * Generates an embedding from queryText, then performs cosine similarity search
   * against stored embeddings, returning the top relevant memories.
   */
  static async queryDreamMemories(
    project: string | undefined,
    queryText: string,
    limit: number = 10,
    offset: number = 0,
    ...optionalFilters: [
      memoryType?: string,
      provider?: string,
      startDate?: Date,
      endDate?: Date,
      scope?: string,
      tags?: string[],
      projectId?: string,
    ]
  ) {
    return (await DreamingService.queryDreamMemoriesWithStatus(
      project, queryText, limit, offset, ...optionalFilters,
    )).memories;
  }

  static async queryDreamMemoriesWithStatus(
    project: string | undefined,
    queryText: string,
    limit: number = 10,
    offset: number = 0,
    ...optionalFilters: [
      memoryType?: string,
      provider?: string,
      startDate?: Date,
      endDate?: Date,
      scope?: string,
      tags?: string[],
      projectId?: string,
      displayName?: string,
      workspacePath?: string,
    ]
  ) {
    const [memoryType, provider, startDate, endDate, scope, tags, projectId] = optionalFilters;
    const normalizedProject = project ?? '';
    queryText = redactMemoryText(queryText);
    const queryVector = await DreamingService.createQueryEmbedding(queryText);
    const tenantId = authStorage.getStore()!.uid;
    const db = createDatabaseAdapter();
    const aliases = projectId ? await DreamProjectIdentityService.getAliases(projectId) : [];
    const filters = DreamingService.buildDreamQueryFilters({ tenantId, project: normalizedProject, projectId, aliases, provider, startDate, endDate, scope, tags, memoryType });
    const vectorResult = await DreamingService.searchDreamVectors(db, queryVector, filters.filters, filters.binds, tenantId, limit + offset);
    const effectiveVector = vectorResult ? queryVector : null;
    DreamingService.addRetrievalTerms(filters, queryText, vectorResult?.ids ?? []);
    const sql = DreamingService.buildDreamQuerySql(effectiveVector, queryText, limit, offset, filters);
    const rows = await db.query<Record<string, unknown>>(sql, filters.binds);
    DreamingService.bumpDreamAccessCount(db, rows, tenantId);
    const processedRows = effectiveVector
      ? DreamingService.scoreDreamQueryRows(rows, vectorResult?.scores ?? {}, scope, offset, limit)
      : rows;
    const cleanRows = DreamingService.cleanDreamQueryRows(processedRows);
    const retrievalStatus = await DreamingService.getDreamRetrievalStatus(db, rows, cleanRows, queryText, filters.baseFilterSql, filters.binds);
    return { memories: cleanRows, retrieval_status: retrievalStatus, candidate_count: rows.length, returned_count: cleanRows.length };
  }

  private static async createQueryEmbedding(queryText: string): Promise<number[] | null> {
    try {
      return await generateEmbedding(queryText, "query");
    } catch {
      logger.warn("[Dreaming] Query embedding unavailable; using lexical fallback");
      return null;
    }
  }

  private static buildDreamQueryFilters(input: {
    tenantId: string; project: string; projectId?: string; aliases: string[]; provider?: string;
    startDate?: Date; endDate?: Date; scope?: string; tags?: string[]; memoryType?: string;
  }): DreamQueryFilters {
    const { tenantId, project, projectId, aliases, provider, startDate, endDate, scope, tags, memoryType } = input;
    const filters: string[] = [];
    const binds: Record<string, unknown> = { tenantId };
    if (projectId) {
      const names = aliases.map((_, index) => `:projectAlias${index}`);
      filters.push(`(project_id = :projectId OR (project_id IS NULL AND project IN (${names.length ? names.join(", ") : ":projectId"})))`);
      binds.projectId = projectId;
      aliases.forEach((alias, index) => { binds[`projectAlias${index}`] = alias; });
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
      const tagConditions = tags.map((_, index) => `tags LIKE :tagLike${index}`).join(" OR ");
      filters.push(`(${tagConditions})`);
      tags.forEach((tag, index) => { binds[`tagLike${index}`] = `%"${tag}"%`; });
    }
    const types = memoryType?.split(",").map((type) => type.trim().toUpperCase()).filter(Boolean) ?? [];
    if (types.length) {
      const typePlaceholders = types.map((_, index) => `:memoryType${index}`).join(", ");
      filters.push(`memory_type IN (${typePlaceholders})`);
      types.forEach((type, index) => { binds[`memoryType${index}`] = type; });
    }
    filters.push("(status IS NULL OR status = 'active')");
    return { filters, binds, baseFilterSql: filters.map((filter) => `AND ${filter}`).join(" ") };
  }

  private static async searchDreamVectors(
    db: ReturnType<typeof createDatabaseAdapter>, vector: number[] | null, filters: string[], binds: Record<string, unknown>, tenantId: string, limit: number,
  ): Promise<DreamVectorSearch | null> {
    if (!vector) return null;
    try {
      const results = await db.searchVectorScoped(
        "ai_dreaming_memory", vector, limit, tenantId, filters.join(" AND ") || "1 = 1",
        Object.fromEntries(Object.entries(binds).filter(([key]) => key !== "tenantId")),
      );
      if (!results.length) return null;
      const scores: Record<string, number> = {};
      results.forEach((result) => { scores[result.id] = result.score; });
      return { ids: results.map((result) => result.id), scores };
    } catch {
      logger.warn("[Dreaming] Vector index unavailable; using scoped lexical fallback");
      return null;
    }
  }

  private static addRetrievalTerms(filters: DreamQueryFilters, queryText: string, vectorIds: string[]): void {
    if (vectorIds.length) {
      filters.vectorIds = vectorIds;
      vectorIds.forEach((id, index) => { filters.binds[`vecId${index}`] = id; });
      return;
    }
    if (!queryText.trim()) return;
    const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}_./:#-]{3,}/gu) ?? [])].slice(0, 5);
    if (!terms.length) {
      filters.filters.push("1 = 0");
      return;
    }
    const alternatives = terms.map((_, index) => `lower(content) LIKE :lexicalTerm${index}`);
    filters.filters.push(`(${alternatives.join(" OR ")})`);
    terms.forEach((term, index) => { filters.binds[`lexicalTerm${index}`] = `%${term}%`; });
  }

  private static buildDreamQuerySql(vector: number[] | null, queryText: string, limit: number, offset: number, filters: DreamQueryFilters): string {
    const selectCols = "id, session_id, project, project_id, provider, memory_type, content, importance, created_at, confidence, status, evidence_count, access_count, version, scope, tags, related_ids";
    if (vector) {
      const vectorParameters = (filters.vectorIds ?? []).map((_, index) => `:vecId${index}`).join(", ");
      const idFilter = `AND id IN (${vectorParameters})`;
      return `SELECT ${selectCols} FROM ai_dreaming_memory WHERE tenant_id = :tenantId ${filters.baseFilterSql} ${idFilter}`;
    }
    filters.binds.limit = limit;
    filters.binds.offset = offset;
    const lexicalOrder = queryText.trim() ? "CASE WHEN lower(content) LIKE :lexicalExact THEN 0 ELSE 1 END, " : "";
    if (queryText.trim()) filters.binds.lexicalExact = `%${queryText.trim().toLowerCase()}%`;
    const filterSql = filters.filters.map((filter) => `AND ${filter}`).join(" ");
    return `SELECT ${selectCols} FROM ai_dreaming_memory WHERE tenant_id = :tenantId ${filterSql}
      ORDER BY ${lexicalOrder} created_at DESC LIMIT :limit OFFSET :offset`;
  }

  private static bumpDreamAccessCount(db: ReturnType<typeof createDatabaseAdapter>, rows: Array<Record<string, unknown>>, tenantId: string): void {
    const ids = rows.map((row) => row.id as string).filter(Boolean);
    if (!ids.length) return;
    const { clause, binds } = buildInClause(ids, { tenantId });
    const updateTask = db.execute(
      `UPDATE ai_dreaming_memory SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id IN (${clause}) AND tenant_id = :tenantId`, binds,
    ).then((result) => {
      const count = DreamingService.readAffectedCount(result);
      if (count !== undefined) logger.debug(`[Dreaming] Bumped access_count for ${count} memories`);
    }).catch((error: unknown) => {
      logger.warn("[Dreaming] Failed to bump access_count:", error instanceof Error ? error.message : String(error));
    });
    DreamingService.activeBackgroundTasks.add(updateTask);
    void updateTask.finally(() => DreamingService.activeBackgroundTasks.delete(updateTask));
  }

  private static readAffectedCount(result: unknown): number | undefined {
    if (!result || typeof result !== "object") return undefined;
    const row = result as Record<string, unknown>;
    for (const key of ["rowsAffected", "affectedRows", "rowCount", "changes"]) {
      if (typeof row[key] === "number") return row[key];
    }
    return undefined;
  }

  private static scoreDreamQueryRows(
    rows: Array<Record<string, unknown>>, vectorScores: Record<string, number>, scope: string | undefined, offset: number, limit: number,
  ): Array<Record<string, unknown>> {
    const scored = rows.map((row) => {
      const idValue = row.id ?? row.ID;
      const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : "";
      const importance = Number(row.importance ?? row.IMPORTANCE) || 0;
      const rawDate = row.created_at ?? row.CREATED_AT;
      const dateText = typeof rawDate === "string" || typeof rawDate === "number" ? String(rawDate) : "";
      const createdAt = rawDate instanceof Date ? rawDate : new Date(dateText);
      const scopeValue = row.scope ?? row.SCOPE;
      const confidence = Number(row.confidence ?? row.CONFIDENCE ?? 0.5);
      const evidenceCount = Number(row.evidence_count ?? row.EVIDENCE_COUNT) || 0;
      const lifecycleBonus = 0.2 * confidence + 0.05 * (evidenceCount > 0 ? Math.min(1, Math.log2(evidenceCount + 1) / 5) : 0);
      const scopeBoost = DreamingService.dreamScopeBoost(scopeValue, scope);
      const freshnessDays = (Date.now() - createdAt.getTime()) / 86_400_000;
      const finalScore = (vectorScores[id] ?? 0) + lifecycleBonus + scopeBoost + 0.15 * (1 - Math.min(1, freshnessDays / 90)) + 0.1 * (importance / 10);
      return { row, finalScore };
    });
    scored.sort((left, right) => right.finalScore - left.finalScore);
    const minScore = DreamingService.dreamMinScore();
    const relevant = minScore > 0 ? scored.filter((item) => item.finalScore >= minScore) : scored;
    if (relevant.length !== scored.length) logger.info(`[Dreaming] Relevance gate dropped ${scored.length - relevant.length} dream(s) below min score ${minScore}`);
    return relevant.slice(offset, offset + limit).map((item) => item.row);
  }

  private static dreamScopeBoost(scopeValue: unknown, scope?: string): number {
    if (!scope) return 0;
    if (scopeValue === scope) return 0.3;
    return typeof scopeValue === "string" && scopeValue.startsWith(`${scope}/`) ? 0.15 : 0;
  }

  private static cleanDreamQueryRows(rows: Array<Record<string, unknown>>) {
    const cleanRows = DreamingService.filterNoiseRows(rows).map((row) => Array.isArray(row)
      ? row.map((value, index) => index === 5 && typeof value === "string" ? redactMemoryText(value) : value)
      : {
        ...row,
        ...(typeof row.content === "string" ? { content: redactMemoryText(row.content) } : {}),
        ...(typeof row.CONTENT === "string" ? { CONTENT: redactMemoryText(row.CONTENT) } : {}),
      });
    if (cleanRows.length !== rows.length) logger.info(`[Dreaming] Inject-gate filtered ${rows.length - cleanRows.length} noisy dream(s)`);
    return cleanRows;
  }

  private static async getDreamRetrievalStatus(
    db: ReturnType<typeof createDatabaseAdapter>, rows: Array<Record<string, unknown>>, cleanRows: readonly unknown[], queryText: string,
    filterSql: string, binds: Record<string, unknown>,
  ): Promise<string> {
    let status = "empty";
    if (cleanRows.length > 0) status = "ok";
    else if (rows.length > 0) status = "filtered";
    else if (queryText.trim()) status = "no_match";
    if (!rows.length && queryText.trim()) {
      const inventory = await db.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ai_dreaming_memory WHERE tenant_id = :tenantId ${filterSql}`, binds,
      );
      if (Number(inventory[0]?.count || 0) === 0) status = "empty";
    }
    return status;
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
