import oracledb from "oracledb";
import type { Connection } from "oracledb";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";

/**
 * Memory types for dreaming memories
 */
export type DreamMemoryType = 'MISTAKE' | 'PREFERENCE' | 'KNOWLEDGE' | 'PATTERN' | 'A2A_SHARED_CONTEXT' | 'FEEDBACK';

export interface DreamMemory {
  id: string;
  sessionId: string;
  project: string;
  memoryType: DreamMemoryType;
  content: string;
  importance: number;
  createdAt: string;
  tenantId: string;
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

  /**
   * Auto-creates the ai_dreaming_memory table if it does not exist.
   * Called once at service startup to ensure the schema is ready.
   */
  static async initialize(): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      // Oracle 23ai+ supports VECTOR data type natively.
      // Use PL/SQL with exception handler for idempotent creation.
      const createTableSql = `
        BEGIN
          EXECUTE IMMEDIATE 'CREATE TABLE ai_dreaming_memory (
            id          VARCHAR2(255) PRIMARY KEY,
            session_id  VARCHAR2(255),
            project     VARCHAR2(255),
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

      // Initialize Second Brain tables
      try {
        const sbSql = \`
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
        \`;
        await connection.execute(sbSql);
        logger.info("[SecondBrain] Tables initialized");
      } catch (err) {
        logger.error("[SecondBrain] Failed to init tables:", err instanceof Error ? err.message : String(err));
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
   * Saves a dreaming memory into Oracle.
   * Generates an embedding vector from content, then inserts the record.
   */
  static async saveDreamMemory(
    project: string,
    sessionId: string,
    memoryType: DreamMemoryType,
    content: string,
    importance: number
  ): Promise<string> {
    // Generate embedding BEFORE acquiring a database connection
    const embeddingVector = await generateEmbedding(content, 'passage');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      // Unique ID: project + memoryType + sessionId + timestamp
      const id = `${project}_${memoryType}_${sessionId}_${Date.now()}`;

      const sql = `
        INSERT INTO ai_dreaming_memory (id, session_id, project, memory_type, content, embedding, importance, tenant_id)
        VALUES (:id, :sessionId, :project, :memoryType, :content, :embedding, :importance, :tenantId)
      `;

      await connection.execute(sql, {
        id,
        sessionId,
        project,
        memoryType,
        content,
        embedding: embeddingVector ? new Float32Array(embeddingVector) : null,
        importance,
        tenantId
      } as oracledb.BindParameters, { autoCommit: true });

      logger.info(`[Oracle Dreaming] Saved dream memory: ${id}`);
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
    project: string,
    queryText: string,
    limit: number = 10
  ) {
    // Generate query embedding first, before acquiring database connection
    const queryVector = await generateEmbedding(queryText, 'query');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      // Use VECTOR_DISTANCE with COSINE similarity for Oracle 23ai+ vector search
      const sql = `
        SELECT id, session_id, project, memory_type, content, importance, created_at
        FROM ai_dreaming_memory
        WHERE project = :project
        ${queryVector ? 'ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)' : 'ORDER BY created_at DESC'}
        FETCH FIRST :limit ROWS ONLY
      `;

      const binds: Record<string, unknown> = { project, limit };
      if (queryVector) {
        binds.queryVector = new Float32Array(queryVector);
      }

      const result = await OracleDreamingService.executeAsync(connection, sql, binds);
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
        WHERE id = :id
      `;

      const result = await connection.execute(sql, { id }, { autoCommit: true });

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
