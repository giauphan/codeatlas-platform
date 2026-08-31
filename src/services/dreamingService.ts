import crypto from "node:crypto";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { generateEmbedding } from "./embeddingService.js";
import { createDatabaseAdapter } from "../database/factory.js";
import { checkNoiseBlocklist } from "./noiseBlocklist.js";
import { countMatching } from "../utils/array.js";

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

/**
 * Service to manage Dreaming Memories in SQLite with sqlite-vec.
 * Dreaming memories let CodeAtlas store learned patterns, mistakes,
 * preferences, and knowledge discovered during code analysis — surfaced
 * as "dreams" that guide future suggestions.
 */
export class DreamingService {


  /** Cache of detected columns so we only check once per process lifetime */
  static _hasLifecycleColumns: boolean | null = null;
  static _hasContentHashColumn: boolean | null = null;

  /** Initializes the SQLite schema and caches available dream-memory columns. */
  static async initialize(): Promise<void> {
    const db = createDatabaseAdapter();
    await db.connect();
    try {
      await db.initializeSchema();
      DreamingService._hasContentHashColumn = await db.checkColumnExists("ai_dreaming_memory", "content_hash");
      DreamingService._hasLifecycleColumns = await db.checkColumnExists("ai_dreaming_memory", "status");
      logger.info("[Dreaming] SQLite schema initialized");
    } finally {
      await db.disconnect();
    }
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
    relatedIds?: string[]
  ): Promise<string> {
    // Noise gate: reject low-quality, low-value dreams before spending embedding cost
    const noiseCheck = DreamingService.checkNoise(memoryType, content, importance);
    if (noiseCheck.isNoise) {
      logger.warn(`[Dreaming] Noise gate blocked dream: ${noiseCheck.reason} (type=${memoryType} imp=${importance})`);

      // Log to noise filtering file for debugging
      const fs = await import('node:fs');
      const logEntry = `[${new Date().toISOString()}] BLOCKED: ${memoryType} (imp=${importance}) - ${noiseCheck.reason}: ${content.slice(0, 100)}\n`;
      try {
        await fs.promises.appendFile('/tmp/noise_filtering.log', logEntry);
      } catch (err) {
        logger.error(`[Dreaming] Failed to write noise log: ${err}`);
      }
      // Return a sentinel so callers know it was filtered, not an error
      return '__noise_blocked__';
    }

    // Generate embedding BEFORE acquiring a database connection
    const embeddingVector = await generateEmbedding(content, 'passage');
    // Content hash for dedup — same content always produces same hash
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const db = createDatabaseAdapter();
    const tenantId = authStorage.getStore()!.uid;
    const id = `${project}_${memoryType}_${sessionId}_${Date.now()}`;
    const initialConfidence = DreamingService.calcInitialConfidence(memoryType, importance);
    const tagsJson = tags ? JSON.stringify(tags) : null;
    const relatedIdsJson = relatedIds ? JSON.stringify(relatedIds) : null;
    try {
      if (DreamingService._hasContentHashColumn && DreamingService._hasLifecycleColumns) {
          const sql = `
            INSERT INTO ai_dreaming_memory (
              id, session_id, project, provider, memory_type, content, embedding, importance, content_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids
            ) VALUES (
              :id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :contentHash, :initialConfidence, 'active', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson
            )
            ON CONFLICT(project, memory_type, content_hash, tenant_id) DO UPDATE SET
              embedding      = EXCLUDED.embedding,
              importance     = CASE WHEN ai_dreaming_memory.importance > EXCLUDED.importance THEN ai_dreaming_memory.importance ELSE EXCLUDED.importance END,
              content        = EXCLUDED.content,
              session_id     = EXCLUDED.session_id,
              provider       = EXCLUDED.provider,
              id             = EXCLUDED.id,
              confidence     = CASE WHEN ai_dreaming_memory.confidence > EXCLUDED.confidence THEN ai_dreaming_memory.confidence ELSE EXCLUDED.confidence END,
              evidence_count = ai_dreaming_memory.evidence_count + 1,
              scope          = COALESCE(EXCLUDED.scope, ai_dreaming_memory.scope),
              tags           = COALESCE(EXCLUDED.tags, ai_dreaming_memory.tags),
              related_ids    = COALESCE(EXCLUDED.related_ids, ai_dreaming_memory.related_ids)
          `;

          await db.execute(sql, {
            id,
            sessionId,
            project,
            provider: aiModel ?? null,
            memoryType,
            content,
            contentHash,
            embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null,
            importance,
            initialConfidence,
            tenantId,
            scope: scope ?? null,
            tagsJson,
            relatedIdsJson
          });
      } else {
        // Fallback: simple INSERT when content_hash column is missing
        const cols = DreamingService._hasLifecycleColumns
          ? 'id, session_id, project, provider, memory_type, content, embedding, importance, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids'
          : 'id, session_id, project, provider, memory_type, content, embedding, importance, tenant_id, scope, tags, related_ids';
        const vals = DreamingService._hasLifecycleColumns
          ? ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :initialConfidence, \'active\', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson'
          : ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :tenantId, :scope, :tagsJson, :relatedIdsJson';
        const binds = DreamingService._hasLifecycleColumns
          ? { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null, importance, initialConfidence, tenantId, scope: scope ?? null, tagsJson, relatedIdsJson }
          : { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Uint8Array(new Float32Array(embeddingVector).buffer) : null, importance, tenantId, scope: scope ?? null, tagsJson, relatedIdsJson };

        await db.execute(
          `INSERT INTO ai_dreaming_memory (${cols}) VALUES (${vals})`,
          binds
        );
      }

      logger.info(`[Dreaming] Upserted dream memory: ${id}`);
      return id;
    } catch (err) {
      logger.error("[Dreaming] Error saving dream memory:", err instanceof Error ? err.message : String(err));
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
    tags?: string[]
  ) {
    const queryVector = await generateEmbedding(queryText, 'query');

    const tenantId = authStorage.getStore()!.uid;
    let vectorSearchIds: string[] = [];
    let vectorScores: Record<string, number> = {};

    if (queryVector) {
      const db = createDatabaseAdapter();
      // Request limit + offset since we will paginate in memory after db search
      const searchResults = await db.searchVector('ai_dreaming_memory', queryVector, limit + offset, tenantId);
      vectorSearchIds = searchResults.map(r => r.id);
      searchResults.forEach(r => { vectorScores[r.id] = r.score; });
      if (vectorSearchIds.length === 0) {
        return [];
      }
    }

    {
      const db = createDatabaseAdapter();

        const projectFilter = project ? 'AND project = :project' : '';
        const providerFilter = provider ? 'AND provider = :provider' : '';
        const startDateFilter = startDate ? 'AND created_at >= :startDate' : '';
        const endDateFilter = endDate ? 'AND created_at <= :endDate' : '';
        let scopeFilter = '';
        if (scope) scopeFilter = 'AND (scope = :scopeExact OR scope LIKE :scopeLike)';

        let tagsFilter = '';
        if (tags && tags.length > 0) {
          const tagsConditions = tags.map((_, idx) => `tags LIKE :tag_like_${idx}`);
          tagsFilter = `AND (${tagsConditions.join(' OR ')})`;
        }

        let typeFilter = '';
        const binds: Record<string, unknown> = { tenantId };

        if (project) binds.project = project;
        if (provider) binds.provider = provider;
        if (startDate) binds.startDate = startDate;
        if (endDate) binds.endDate = endDate;
        if (scope) { binds.scopeExact = scope; binds.scopeLike = `${scope}/%`; }
        if (tags && tags.length > 0) {
          tags.forEach((tag, idx) => { binds[`tag_like_${idx}`] = `%"${tag}"%`; });
        }
        if (queryVector) {
          const idBinds = vectorSearchIds.map((_, i) => `:vecId${i}`).join(', ');
          typeFilter += ` AND id IN (${idBinds})`;
          vectorSearchIds.forEach((id, i) => { binds[`vecId${i}`] = id; });
        }
        if (memoryType) {
          const types = memoryType.split(',').map(t => t.trim().toUpperCase()).filter(t => t);
          if (types.length > 0) {
            const typeBinds = types.map((_, i) => `:type${i}`).join(', ');
            typeFilter = `AND memory_type IN (${typeBinds})`;
            types.forEach((type, i) => { binds[`type${i}`] = type; });
          }
        }

        const statusFilter = `AND (status IS NULL OR status IN ('active', 'superseded'))`;
        const selectCols = 'id, session_id, project, provider, memory_type, content, importance, created_at, confidence, status, evidence_count, access_count, version, scope, tags, related_ids';

        let sql: string;
        if (!queryVector) {
          binds.limit = limit;
          binds.offset = offset;
          sql = `
            SELECT ${selectCols}
            FROM ai_dreaming_memory
            WHERE tenant_id = :tenantId ${projectFilter} ${providerFilter} ${typeFilter} ${statusFilter} ${startDateFilter} ${endDateFilter} ${scopeFilter} ${tagsFilter}
            ORDER BY created_at DESC
            LIMIT :limit OFFSET :offset
          `;
        } else {
          sql = `
            SELECT ${selectCols}
            FROM ai_dreaming_memory
            WHERE tenant_id = :tenantId ${projectFilter} ${providerFilter} ${typeFilter} ${statusFilter} ${startDateFilter} ${endDateFilter} ${scopeFilter} ${tagsFilter}
          `;
        }

        const rows = await db.query<Record<string, unknown>>(sql, binds);

        // Bump access_count non-critically
        if (rows.length > 0) {
          try {
            const ids = rows.map(r => r['id'] as string).filter(Boolean);
            if (ids.length > 0) {
              const baseBind = { tenantId };
              const binds = ids.map(id => ({ id, ...baseBind }));
              await db.executeMany(
                `UPDATE ai_dreaming_memory SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
                binds
              );
            }
          } catch (bumpErr) {
            logger.warn('[Dreaming] Failed to bump access_count:', bumpErr instanceof Error ? bumpErr.message : String(bumpErr));
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

        const cleanRows = DreamingService.filterNoiseRows(processedRows);
        if (cleanRows.length !== processedRows.length) {
          logger.info(`[Dreaming] Inject-gate filtered ${processedRows.length - cleanRows.length} noisy dream(s)`);
        }
        return cleanRows;
    }
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
