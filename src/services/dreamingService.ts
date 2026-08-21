import crypto from "node:crypto";
import oracledb from "oracledb";
import type { Connection } from "oracledb";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";
import { createDatabaseAdapter } from "../database/factory.js";

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
 * Service to manage Dreaming Memories on Oracle Database 26ai.
 * Dreaming memories let CodeAtlas store learned patterns, mistakes,
 * preferences, and knowledge discovered during code analysis — surfaced
 * as "dreams" that guide future suggestions.
 */
export class OracleDreamingService {

  /**
   * Typed wrapper around connection.execute() to avoid scattered unchecked casts.
   * The Oracle driver's bind parameter types are too complex to match perfectly
   * with Record<string, unknown>, so the cast is isolated in this single method.
   */
  private static async executeAsync(
    connection: Connection,
    sql: string,
    binds: Record<string, unknown>
  ) {
    return connection.execute(sql, binds as oracledb.BindParameters);
  }

  /** Cache of detected columns so we only check once per process lifetime */
  static _hasLifecycleColumns: boolean | null = null;
  static _hasContentHashColumn: boolean | null = null;

  /**
   * Check if a column exists in the ai_dreaming_memory table.
   * Results are cached after first check.
   */
  private static async checkColumn(connection: Connection, colName: string): Promise<boolean> {
    const result = await connection.execute(
      `SELECT COUNT(*) AS cnt FROM USER_TAB_COLUMNS
       WHERE table_name = 'AI_DREAMING_MEMORY' AND column_name = :col`,
      { col: colName.toUpperCase() }
    );
    // oracledb runs with OUT_FORMAT_OBJECT — rows are [{CNT: number}]
    const rows = result.rows as Array<Record<string, number>> | undefined;
    return !!(rows && rows.length > 0 && (rows[0]['CNT'] ?? 0) > 0);
  }

  /**
   * Auto-creates the ai_dreaming_memory table if it does not exist.
   * Called once at service startup to ensure the schema is ready.
   */
  static async initialize(): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      // setSessionContext requires auth context — skip during cold startup
      // Schema migrations don't need RLS (they run on shared metadata tables)

      // Oracle 23ai+ supports VECTOR data type natively.
      // Use PL/SQL with exception handler for idempotent creation.
      const createTableSql = `
        BEGIN
          EXECUTE IMMEDIATE 'CREATE TABLE ai_dreaming_memory (
            id          VARCHAR2(255) PRIMARY KEY,
            session_id  VARCHAR2(255),
            project     VARCHAR2(255),
            provider    VARCHAR2(255) DEFAULT NULL,
            memory_type VARCHAR2(50),
            content     CLOB,
            embedding   VECTOR,
            importance  NUMBER(2),
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            tenant_id   VARCHAR2(255)
          )';
          EXECUTE IMMEDIATE 'COMMENT ON TABLE ai_dreaming_memory IS ''Dreaming memories with vector embeddings for semantic search''';
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLCODE = -955 THEN
              NULL;  -- ORA-00955: name already used → table already exists
            ELSE
              RAISE;
            END IF;
        END;
      `;

      await connection.execute(createTableSql);
      logger.info("[Oracle Dreaming] Table ai_dreaming_memory initialized successfully");

      // Migration: add all missing columns — check USER_TAB_COLUMNS first to avoid ORA-00904
      const columnsToAdd: { name: string; ddl: string }[] = [
        // v2.15.0
        { name: 'PROVIDER', ddl: 'ADD (provider VARCHAR2(255) DEFAULT NULL)' },
        // v2.18.0
        { name: 'CONTENT_HASH', ddl: 'ADD (content_hash VARCHAR2(64))' },
        // Lifecycle columns
        { name: 'CONFIDENCE', ddl: 'ADD (confidence NUMBER(5,2) DEFAULT 0.50)' },
        { name: 'STATUS', ddl: "ADD (status VARCHAR2(20) DEFAULT ''active'')" },
        { name: 'SUPERSEDED_BY', ddl: 'ADD (superseded_by VARCHAR2(255) DEFAULT NULL)' },
        { name: 'EVIDENCE_COUNT', ddl: 'ADD (evidence_count NUMBER DEFAULT 1)' },
        { name: 'ACCESS_COUNT', ddl: 'ADD (access_count NUMBER DEFAULT 0)' },
        { name: 'LAST_ACCESSED_AT', ddl: 'ADD (last_accessed_at TIMESTAMP)' },
        { name: 'VERSION', ddl: 'ADD (version NUMBER DEFAULT 1)' },
        // v2.20.0: Scope, Tags, Related IDs for contextual memory retrieval
        { name: 'SCOPE', ddl: 'ADD (scope VARCHAR2(500) DEFAULT NULL)' },
        { name: 'TAGS', ddl: 'ADD (tags CLOB)' },
        { name: 'RELATED_IDS', ddl: 'ADD (related_ids CLOB)' },
      ];
      for (const col of columnsToAdd) {
        const exists = await this.checkColumn(connection, col.name);
        if (!exists) {
          try {
            await connection.execute(`
              BEGIN
                EXECUTE IMMEDIATE 'ALTER TABLE ai_dreaming_memory ${col.ddl}';
              EXCEPTION
                WHEN OTHERS THEN
                  IF SQLCODE = -1430 THEN NULL;  -- ORA-01430: column already exists (race)
                  ELSE RAISE;
                  END IF;
              END;
            `);
            logger.info(`[Oracle Dreaming] Added column ${col.name}`);
          } catch (addErr) {
            logger.warn(`[Oracle Dreaming] Could not add column ${col.name}:`, addErr instanceof Error ? addErr.message : String(addErr));
          }
        }
      }
      // Populate caches after migrations
      OracleDreamingService._hasContentHashColumn = await this.checkColumn(connection, 'CONTENT_HASH');
      OracleDreamingService._hasLifecycleColumns = await this.checkColumn(connection, 'STATUS');
      logger.info(`[Oracle Dreaming] Schema check — has_content_hash=${OracleDreamingService._hasContentHashColumn}, has_lifecycle=${OracleDreamingService._hasLifecycleColumns}`);

      // Data migration: set existing NULL statuses to active (v2.18.1)
      if (OracleDreamingService._hasLifecycleColumns) {
        try {
          const updResult = await connection.execute(
            `UPDATE ai_dreaming_memory SET status = 'active' WHERE status IS NULL`,
            {},
            { autoCommit: true }
          );
          if (updResult.rowsAffected && updResult.rowsAffected > 0) {
            logger.info(`[Oracle Dreaming] Data migration — set ${updResult.rowsAffected} NULL statuses to 'active'`);
          }
        } catch (updErr) {
          logger.warn("[Oracle Dreaming] Data migration warning:", updErr);
        }
      }

      // Second Brain and Genome tables are lazily initialized on first server start.
      // This avoids forcing users to run a separate migration step.
      // Each CREATE TABLE uses EXECUTE IMMEDIATE wrapped in BEGIN...END blocks
      // because Oracle does not support direct CREATE TABLE with IF NOT EXISTS.
      try {
        const sbSql = `
          BEGIN
            EXECUTE IMMEDIATE 'CREATE TABLE codeatlas_concepts (
              id            VARCHAR2(36) PRIMARY KEY,
              label         VARCHAR2(500) NOT NULL,
              description   CLOB,
              category      VARCHAR2(50),
              embedding     VECTOR(1024, FLOAT64),
              project       VARCHAR2(255),
              confidence    NUMBER(3,2) DEFAULT 0.50,
              source_ids    CLOB,
              evidence_count NUMBER DEFAULT 1,
              status        VARCHAR2(20) DEFAULT ''active'',
              created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              tenant_id     VARCHAR2(255)
            )';
            EXECUTE IMMEDIATE 'COMMENT ON TABLE codeatlas_concepts IS ''AI Second Brain concepts''';
          EXCEPTION
            WHEN OTHERS THEN
              IF SQLCODE = -955 THEN NULL;
              ELSE RAISE;
              END IF;
          END;
        `;
        await connection.execute(sbSql);
        logger.info("[SecondBrain] Tables initialized");
      } catch (err) {
        logger.error("[SecondBrain] Failed to init tables:", err instanceof Error ? err.message : String(err));
      }

      // Same lazy-init pattern for Genome Immune System tables.
      try {
        const genomeSql = [
          "BEGIN",
          "  EXECUTE IMMEDIATE 'CREATE TABLE codeatlas_genome (",
          "    id              VARCHAR2(36) PRIMARY KEY,",
          "    name            VARCHAR2(500) NOT NULL,",
          "    description     CLOB,",
          "    problem         CLOB,",
          "    solution        CLOB,",
          "    architecture    CLOB,",
          "    category        VARCHAR2(50),",
          "    project         VARCHAR2(255),",
          "    confidence      NUMBER(3,2) DEFAULT 0.50,",
          "    version         NUMBER DEFAULT 1,",
          "    evolution_score NUMBER DEFAULT 1,",
          "    usage_count     NUMBER DEFAULT 0,",
          "    success_rate    NUMBER(3,2) DEFAULT 0.50,",
          "    embedding       VECTOR(1024, FLOAT64),",
          "    status          VARCHAR2(20) DEFAULT ''active'',",
          "    source_type     VARCHAR2(50),",
          "    source_id       VARCHAR2(255),",
          "    dependencies    CLOB,",
          "    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,",
          "    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,",
          "    tenant_id       VARCHAR2(255)",
          "  )';",
          "  EXECUTE IMMEDIATE 'COMMENT ON TABLE codeatlas_genome IS ''AI Genome''';",
          "EXCEPTION WHEN OTHERS THEN IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF;",
          "END;",
        ].join("\n");

        const mutSql = [
          "BEGIN",
          "  EXECUTE IMMEDIATE 'CREATE TABLE gene_mutations (",
          "    id          VARCHAR2(36) PRIMARY KEY,",
          "    gene_id     VARCHAR2(36) NOT NULL,",
          "    old_version NUMBER DEFAULT 0,",
          "    new_version NUMBER NOT NULL,",
          "    changes     CLOB,",
          "    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
          "  )';",
          "  EXECUTE IMMEDIATE 'COMMENT ON TABLE gene_mutations IS ''Gene version history''';",
          "EXCEPTION WHEN OTHERS THEN IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF;",
          "END;",
        ].join("\n");

        const relSql = [
          "BEGIN",
          "  EXECUTE IMMEDIATE 'CREATE TABLE gene_relationships (",
          "    id          VARCHAR2(36) PRIMARY KEY,",
          "    source_id   VARCHAR2(36) NOT NULL,",
          "    target_id   VARCHAR2(36) NOT NULL,",
          "    relationship VARCHAR2(50),",
          "    weight      NUMBER(3,2) DEFAULT 0.50,",
          "    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
          "  )';",
          "  EXECUTE IMMEDIATE 'COMMENT ON TABLE gene_relationships IS ''Gene-to-gene links''';",
          "EXCEPTION WHEN OTHERS THEN IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF;",
          "END;",
        ].join("\n");

        await connection.execute(genomeSql);
        await connection.execute(mutSql);
        await connection.execute(relSql);
        logger.info("[Genome] Tables initialized");
      } catch (err) {
        logger.warn("[Genome] table init:", err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      logger.error("[Oracle Dreaming] Failed to initialize table:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("[Oracle Dreaming] Error closing connection:", closeErr);
        }
      }
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
    const stopWordCount = words.filter(w => STOP_WORDS.has(w.toLowerCase())).length;
    const stopRatio = words.length > 0 ? stopWordCount / words.length : 1;

    // If >80% stop words, it's noise (e.g., "Sẵn sàng. Cần tôi làm gì?")
    if (stopRatio > 0.80 && words.length > 0) {
      return { isNoise: true, reason: `stop-word ratio ${stopRatio.toFixed(2)} > 0.80` };
    }

    return { isNoise: false, reason: null };
  }

  /**
   * Saves a dreaming memory into Oracle.
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
    const noiseCheck = OracleDreamingService.checkNoise(memoryType, content, importance);
    if (noiseCheck.isNoise) {
      logger.warn(`[Oracle Dreaming] Noise gate blocked dream: ${noiseCheck.reason} (type=${memoryType} imp=${importance})`);

      // Log to noise filtering file for debugging
      const fs = await import('node:fs');
      const logEntry = `[${new Date().toISOString()}] BLOCKED: ${memoryType} (imp=${importance}) - ${noiseCheck.reason}: ${content.slice(0, 100)}\n`;
      try {
        await fs.promises.appendFile('/tmp/noise_filtering.log', logEntry);
      } catch (err) {
        logger.error(`[Oracle Dreaming] Failed to write noise log: ${err}`);
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
    const initialConfidence = OracleDreamingService.calcInitialConfidence(memoryType, importance);
    const tagsJson = tags ? JSON.stringify(tags) : null;
    const relatedIdsJson = relatedIds ? JSON.stringify(relatedIds) : null;
    const dbType = (process.env.CODEATLAS_DB_TYPE || "oracle").toLowerCase();

    try {
      if (OracleDreamingService._hasContentHashColumn && OracleDreamingService._hasLifecycleColumns) {
        if (dbType === "postgres" || dbType === "sqlite") {
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
            embedding: embeddingVector ? (dbType === "sqlite" ? new Uint8Array(new Float32Array(embeddingVector).buffer) : new Float32Array(embeddingVector)) : null,
            importance,
            initialConfidence,
            tenantId,
            scope: scope ?? null,
            tagsJson,
            relatedIdsJson
          });
        } else {
          // Full MERGE with dedup on content_hash (preferred path for Oracle)
          const sql = `
            MERGE INTO ai_dreaming_memory trg
            USING (SELECT :project AS project, :memoryType AS memory_type, :contentHash AS content_hash, :tenantId AS tenant_id FROM DUAL) src
            ON (trg.project = src.project AND trg.memory_type = src.memory_type AND trg.content_hash = src.content_hash AND trg.tenant_id = src.tenant_id)
            WHEN MATCHED THEN
              UPDATE SET
                embedding      = :embedding,
                importance     = GREATEST(trg.importance, :importance),
                content        = :content,
                session_id     = :sessionId,
                provider       = :provider,
                id             = :id,
                confidence     = GREATEST(trg.confidence, :initialConfidence),
                evidence_count = trg.evidence_count + 1,
                scope          = COALESCE(:scope, trg.scope),
                tags           = COALESCE(TO_CLOB(:tagsJson), trg.tags),
                related_ids    = COALESCE(TO_CLOB(:relatedIdsJson), trg.related_ids)
            WHEN NOT MATCHED THEN
              INSERT (id, session_id, project, provider, memory_type, content, embedding, importance, content_hash, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids)
              VALUES (:id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :contentHash, :initialConfidence, 'active', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson)
          `;

          await db.execute(sql, {
            id,
            sessionId,
            project,
            provider: aiModel ?? null,
            memoryType,
            content,
            contentHash,
            embedding: embeddingVector ? new Float32Array(embeddingVector) : null,
            importance,
            initialConfidence,
            tenantId,
            scope: scope ?? null,
            tagsJson,
            relatedIdsJson
          });
        }
      } else {
        // Fallback: simple INSERT when content_hash column is missing
        const cols = OracleDreamingService._hasLifecycleColumns
          ? 'id, session_id, project, provider, memory_type, content, embedding, importance, confidence, status, evidence_count, access_count, version, tenant_id, scope, tags, related_ids'
          : 'id, session_id, project, provider, memory_type, content, embedding, importance, tenant_id, scope, tags, related_ids';
        const vals = OracleDreamingService._hasLifecycleColumns
          ? ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :initialConfidence, \'active\', 1, 0, 1, :tenantId, :scope, :tagsJson, :relatedIdsJson'
          : ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :tenantId, :scope, :tagsJson, :relatedIdsJson';
        const binds = OracleDreamingService._hasLifecycleColumns
          ? { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Float32Array(embeddingVector) : null, importance, initialConfidence, tenantId, scope: scope ?? null, tagsJson, relatedIdsJson }
          : { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Float32Array(embeddingVector) : null, importance, tenantId, scope: scope ?? null, tagsJson, relatedIdsJson };

        await db.execute(
          `INSERT INTO ai_dreaming_memory (${cols}) VALUES (${vals})`,
          binds
        );
      }

      logger.info(`[Oracle Dreaming] Upserted dream memory: ${id}`);
      return id;
    } catch (err) {
      logger.error("[Oracle Dreaming] Error saving dream memory:", err instanceof Error ? err.message : String(err));
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

    let connection;
    try {
      const tenantId = authStorage.getStore()!.uid;
      let vectorSearchIds: string[] = [];
      let vectorScores: Record<string, number> = {};

      const dbType = (process.env.CODEATLAS_DB_TYPE || 'oracle').toLowerCase();

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

      // SQLite/Postgres path — avoid Oracle pool dependency
      if (dbType === 'sqlite' || dbType === 'postgres') {
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
            for (const rid of ids) {
              await db.execute(
                `UPDATE ai_dreaming_memory SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = :id AND tenant_id = :tenantId`,
                { id: rid, tenantId }
              );
            }
          } catch (bumpErr) {
            logger.warn('[Oracle Dreaming] Failed to bump access_count:', bumpErr instanceof Error ? bumpErr.message : String(bumpErr));
          }
        }

        let processedRows: any[] = [...rows];

        if (queryVector) {
          // In-memory scoring identical to Oracle path
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
          processedRows = scored.slice(offset, offset + limit).map(item => item.row);
        }

        return processedRows;
      }

      // Oracle path below
      const pool = await initPool();
      connection = await pool.getConnection();

      await setSessionContext(connection);

      const projectFilter = project ? 'AND project = :project' : '';

      // Build provider filter
      const providerFilter = provider ? 'AND provider = :provider' : '';

      // Build date filters using direct Date binding instead of risky TO_TIMESTAMP formats
      const startDateFilter = startDate ? 'AND created_at >= :startDate' : '';
      const endDateFilter = endDate ? 'AND created_at <= :endDate' : '';

      // Scope filter: support hierarchical matching (e.g. scope "auth" matches "auth/login" or exact "auth")
      let scopeFilter = '';
      if (scope) {
        scopeFilter = 'AND (scope = :scopeExact OR scope LIKE :scopeLike)';
      }

      // Tags filter: check if any of the requested tags exist in the JSON array tags column
      let tagsFilter = '';
      if (tags && tags.length > 0) {
        // Oracle JSON_EXISTS is strict about path literals — cannot bind path dynamically.
        // Fallback: use LIKE for older Oracle versions, or JSON_EXISTS with literal paths.
        // We'll use LIKE for compatibility, and JSON_EXISTS if the column exists and we're on Oracle 23ai+.
        const hasTagsColumn = await OracleDreamingService.checkColumn(connection, 'TAGS');
        if (hasTagsColumn) {
          // Use LIKE bound parameters for compatibility: tags is a JSON array like ["jwt","security"]
          // We search for typical JSON formatted tag values ("%tag%")
          const tagsConditions = tags.map((_, idx) => `tags LIKE :tag_like_${idx}`);
          tagsFilter = `AND (${tagsConditions.join(' OR ')})`;
        }
      }

      // Build type filter for memory_type IN clause
      let typeFilter = '';
      const binds: Record<string, unknown> = { tenantId };
      if (!queryVector) {
        binds.limit = limit;
        binds.offset = offset;
      }

      if (project) binds.project = project;
      if (provider) binds.provider = provider;
      if (startDate) binds.startDate = startDate;
      if (endDate) binds.endDate = endDate;
      if (scope) {
        binds.scopeExact = scope;
        binds.scopeLike = `${scope}/%`;
      }
      if (tags && tags.length > 0) {
        tags.forEach((tag, idx) => {
          binds[`tag_like_${idx}`] = `%"${tag}"%`;
        });
      }
      if (queryVector) {
        // Build IN clause for IDs returned from searchVector
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

      // Build status filter — exclude archived/deprecated by default (only if column exists)
      // NULL status means pre-migration row, treat as active
      const statusFilter = OracleDreamingService._hasLifecycleColumns
        ? `AND (status IS NULL OR status IN ('active', 'superseded'))`
        : '';

      let orderClause: string;
      let paginationClause = '';

      if (!queryVector) {
        // When there is no search query, default to purely chronological sorting (newest first)
        // so the UI naturally shows recent memories instead of burying them under old high-importance ones.
        orderClause = `ORDER BY created_at DESC`;
        paginationClause = `OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`;
      } else {
        // If queryVector, we will sort and paginate in memory
        orderClause = '';
      }

      const selectCols = OracleDreamingService._hasLifecycleColumns
        ? 'id, session_id, project, provider, memory_type, content, importance, created_at, confidence, status, evidence_count, access_count, version, scope, tags, related_ids'
        : 'id, session_id, project, provider, memory_type, content, importance, created_at, scope, tags, related_ids';

      const sql = `
        SELECT ${selectCols}
        FROM ai_dreaming_memory
        WHERE tenant_id = :tenantId ${projectFilter} ${providerFilter} ${typeFilter} ${statusFilter} ${startDateFilter} ${endDateFilter} ${scopeFilter} ${tagsFilter}
        ${orderClause}
        ${paginationClause}
      `;

      const result = await OracleDreamingService.executeAsync(connection, sql, binds);

      let processedRows = result.rows ? [...(result.rows as any[])] : [];

      if (queryVector) {
        // In-memory sorting based on vector distance + metadata
        processedRows = processedRows.map(row => {
          // Note: these mappings depend on the order of selectCols
          const id = row[0];
          const importance = row[6] || 0;
          const createdAtDate = row[7] instanceof Date ? row[7] : new Date(row[7]);
          const scopeVal = OracleDreamingService._hasLifecycleColumns ? row[13] : row[8];
          const confidence = OracleDreamingService._hasLifecycleColumns ? (row[8] ?? 0.50) : 0.50;
          const evidenceCount = OracleDreamingService._hasLifecycleColumns ? (row[10] || 0) : 0;

          const baseScore = vectorScores[id] ?? 0; // 0.50 * (1 - VECTOR_DISTANCE) from adapter

          let lifecycleBonus = 0;
          if (OracleDreamingService._hasLifecycleColumns) {
            lifecycleBonus = 0.20 * confidence + 0.05 * (evidenceCount > 0 ? Math.min(1.0, Math.log2(evidenceCount + 1) / 5) : 0);
          }

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

        processedRows.sort((a, b) => b.finalScore - a.finalScore);
        processedRows = processedRows.slice(offset, offset + limit).map(item => item.row);
      }

      // Bump access_count for retrieved dreams — tracks usefulness for decay calculation
      if (processedRows && processedRows.length > 0 && OracleDreamingService._hasLifecycleColumns) {
        const fetchedIds: string[] = [];
        for (const row of processedRows) {
          if (row[0]) fetchedIds.push(row[0]);  // id is column 0
        }
        if (fetchedIds.length > 0) {
          try {
            // Oracle doesn't support UPDATE ... WHERE id IN (...) with array bind easily,
            // so use executeMany for batch update of access_count + last_accessed_at
            const bumpBinds = fetchedIds.map((id: string) => ({ id, tenantId: authStorage.getStore()!.uid }));
            await connection.executeMany(
              `UPDATE ai_dreaming_memory SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP
               WHERE id = :id AND tenant_id = :tenantId`,
              bumpBinds,
              { autoCommit: false, bindDefs: { id: { type: oracledb.STRING, maxSize: 255 }, tenantId: { type: oracledb.STRING, maxSize: 255 } } }
            );
          } catch (bumpErr) {
            // Non-critical — log and continue
            logger.warn("[Oracle Dreaming] Failed to bump access_count:", bumpErr instanceof Error ? bumpErr.message : String(bumpErr));
          }
        }
      }

      return processedRows;
    } catch (err) {
      logger.error("[Oracle Dreaming] Error querying dream memories:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("[Oracle Dreaming] Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Deletes a dreaming memory by its ID.
   */
  static async deleteDreamMemory(id: string): Promise<boolean> {
    const dbType = (process.env.CODEATLAS_DB_TYPE || 'oracle').toLowerCase();
    if (dbType === 'sqlite' || dbType === 'postgres') {
      const db = createDatabaseAdapter();
      const tenantId = authStorage.getStore()!.uid;
      const result = await db.execute(
        `DELETE FROM ai_dreaming_memory WHERE id = :id AND tenant_id = :tenantId`,
        { id, tenantId }
      );
      const wasDeleted = (result.rowsAffected ?? 0) > 0;
      if (wasDeleted) logger.info(`[Oracle Dreaming] Deleted dream memory: ${id}`);
      else logger.warn(`[Oracle Dreaming] Dream memory not found for deletion: ${id}`);
      return wasDeleted;
    }

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();

      await setSessionContext(connection);

      const sql = `
        DELETE FROM ai_dreaming_memory
        WHERE id = :id AND tenant_id = :tenantId
      `;

      const result = await connection.execute(sql, { id, tenantId: authStorage.getStore()!.uid }, { autoCommit: true });

      // result.rowsAffected is a number if the driver reports it
      const deletedCount = result.rowsAffected ?? 0;
      const wasDeleted = deletedCount > 0;

      if (wasDeleted) {
        logger.info(`[Oracle Dreaming] Deleted dream memory: ${id}`);
      } else {
        logger.warn(`[Oracle Dreaming] Dream memory not found for deletion: ${id}`);
      }

      return wasDeleted;
    } catch (err) {
      logger.error("[Oracle Dreaming] Error deleting dream memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("[Oracle Dreaming] Error closing connection:", closeErr);
        }
      }
    }
  }
}
