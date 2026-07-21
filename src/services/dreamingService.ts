import crypto from "node:crypto";
import oracledb from "oracledb";
import type { Connection } from "oracledb";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";

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
export type DreamMemoryType = 'MISTAKE' | 'PREFERENCE' | 'KNOWLEDGE' | 'PATTERN' | 'A2A_SHARED_CONTEXT' | 'FEEDBACK';

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
    if (trimmed.length < 40) return { isNoise: true, reason: `too short (${trimmed.length} chars, min 40)` };
    if (trimmed.length > 2000) return { isNoise: true, reason: `too long (${trimmed.length} chars, max 2000)` };

    // Minimum importance thresholds by type
    const minImportance: Record<string, number> = {
      KNOWLEDGE: 3,
      PREFERENCE: 2,
      PATTERN: 3,
      MISTAKE: 3,
      FEEDBACK: 1,
      A2A_SHARED_CONTEXT: 1,
    };
    const minImp = minImportance[memoryType] ?? 2;
    if (importance < minImp) return { isNoise: true, reason: `importance ${importance} < minimum ${minImp} for ${memoryType}` };

    // Content quality: check information density via stop-word ratio
    const words = trimmed.split(/\s+/);
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
    aiModel?: string
  ): Promise<string> {
    // Noise gate: reject low-quality, low-value dreams before spending embedding cost
    const noiseCheck = OracleDreamingService.checkNoise(memoryType, content, importance);
    if (noiseCheck.isNoise) {
      logger.info(`[Oracle Dreaming] Noise gate blocked dream: ${noiseCheck.reason} (type=${memoryType} imp=${importance})`);
      // Return a sentinel so callers know it was filtered, not an error
      return '__noise_blocked__';
    }

    // Generate embedding BEFORE acquiring a database connection
    const embeddingVector = await generateEmbedding(content, 'passage');
    // Content hash for dedup — same content always produces same hash
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const tenantId = authStorage.getStore()!.uid;
      const id = `${project}_${memoryType}_${sessionId}_${Date.now()}`;
      const initialConfidence = OracleDreamingService.calcInitialConfidence(memoryType, importance);

      if (OracleDreamingService._hasContentHashColumn && OracleDreamingService._hasLifecycleColumns) {
        // Full MERGE with dedup on content_hash (preferred path)
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
              evidence_count = trg.evidence_count + 1
          WHEN NOT MATCHED THEN
            INSERT (id, session_id, project, provider, memory_type, content, embedding, importance, content_hash, confidence, status, evidence_count, access_count, version, tenant_id)
            VALUES (:id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :contentHash, :initialConfidence, 'active', 1, 0, 1, :tenantId)
        `;

        await connection.execute(sql, {
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
          tenantId
        } as oracledb.BindParameters, { autoCommit: true });
      } else {
        // Fallback: simple INSERT when content_hash column is missing
        const cols = OracleDreamingService._hasLifecycleColumns
          ? 'id, session_id, project, provider, memory_type, content, embedding, importance, confidence, status, evidence_count, access_count, version, tenant_id'
          : 'id, session_id, project, provider, memory_type, content, embedding, importance, tenant_id';
        const vals = OracleDreamingService._hasLifecycleColumns
          ? ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :initialConfidence, \'active\', 1, 0, 1, :tenantId'
          : ':id, :sessionId, :project, :provider, :memoryType, :content, :embedding, :importance, :tenantId';
        const binds = OracleDreamingService._hasLifecycleColumns
          ? { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Float32Array(embeddingVector) : null, importance, initialConfidence, tenantId }
          : { id, sessionId, project, provider: aiModel ?? null, memoryType, content, embedding: embeddingVector ? new Float32Array(embeddingVector) : null, importance, tenantId };

        await connection.execute(
          `INSERT INTO ai_dreaming_memory (${cols}) VALUES (${vals})`,
          binds as oracledb.BindParameters,
          { autoCommit: true }
        );
      }

      logger.info(`[Oracle Dreaming] Upserted dream memory: ${id}`);
      return id;
    } catch (err) {
      logger.error("[Oracle Dreaming] Error saving dream memory:", err instanceof Error ? err.message : String(err));
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
    provider?: string
  ) {
    const queryVector = await generateEmbedding(queryText, 'query');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();

      await setSessionContext(connection);

      const projectFilter = project ? 'AND project = :project' : '';

      // Build provider filter
      const providerFilter = provider ? 'AND provider = :provider' : '';

      // Build type filter for memory_type IN clause
      let typeFilter = '';
      const binds: Record<string, unknown> = { tenantId: authStorage.getStore()!.uid, limit, offset };
      if (project) binds.project = project;
      if (provider) binds.provider = provider;
      if (queryVector) {
        binds.queryVector = new Float32Array(queryVector);
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
      const statusFilter = OracleDreamingService._hasLifecycleColumns
        ? `AND status IN ('active', 'superseded')`
        : '';

      let orderClause: string;
      if (queryVector) {
        // Weighted ranking: similarity + freshness + importance + lifecycle bonuses
        const lifecycleBonus = OracleDreamingService._hasLifecycleColumns
          ? `\n            + 0.20 * NVL(confidence, 0.50)\n            + 0.05 * CASE WHEN evidence_count > 0 THEN LEAST(1.0, LOG(2, evidence_count + 1) / 5) ELSE 0 END`
          : '';
        orderClause = `
          ORDER BY (
            0.50 * (1 - VECTOR_DISTANCE(embedding, :queryVector, COSINE))${lifecycleBonus}
            + 0.15 * LEAST(1.0, (SYSDATE - CAST(created_at AS DATE)) / 90)
            + 0.10 * (importance / 10.0)
          ) DESC
        `;
      } else {
        const lifecycleBonus = OracleDreamingService._hasLifecycleColumns
          ? `\n            + 0.40 * NVL(confidence, 0.50)\n            + 0.10 * CASE WHEN evidence_count > 0 THEN LEAST(1.0, LOG(2, evidence_count + 1) / 5) ELSE 0 END`
          : '';
        orderClause = `
          ORDER BY (
            0.30 * LEAST(1.0, (SYSDATE - CAST(created_at AS DATE)) / 90)${lifecycleBonus}
            + 0.20 * (importance / 10.0)
          ) DESC
        `;
      }

      const selectCols = OracleDreamingService._hasLifecycleColumns
        ? 'id, session_id, project, provider, memory_type, content, importance, created_at, confidence, status, evidence_count, access_count, version'
        : 'id, session_id, project, provider, memory_type, content, importance, created_at';

      const sql = `
        SELECT ${selectCols}
        FROM ai_dreaming_memory
        WHERE tenant_id = :tenantId ${projectFilter} ${providerFilter} ${typeFilter} ${statusFilter}
        ${orderClause}
        OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
      `;
      if (queryVector) {
        binds.queryVector = new Float32Array(queryVector);
      }

      const result = await OracleDreamingService.executeAsync(connection, sql, binds);

      // Bump access_count for retrieved dreams — tracks usefulness for decay calculation
      if (result.rows && result.rows.length > 0 && OracleDreamingService._hasLifecycleColumns) {
        const fetchedIds: string[] = [];
        for (const row of result.rows as any[]) {
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

      return result.rows ?? [];
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
