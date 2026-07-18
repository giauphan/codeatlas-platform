import oracledb from "oracledb";
import type { Connection } from "oracledb";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding, generateEmbeddingsBatch } from "./embeddingService.js";
import type { GraphEntity, GraphLink, ArchSmells } from "../types/index.js";

/**
 * Service to manage AI Memory on Oracle Database 26ai.
 * Employs Thick Mode (via Oracle Instant Client) to support stable mTLS connections.
 */
export class OracleMemoryService {

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
   * Tier 1: Episodic JSON - Stores business events (Business Rules / Change Logs)
   */
  static async saveEpisodicMemory(project: string, eventType: "BUSINESS_RULE" | "CHANGE_LOG", data: Record<string, unknown>) {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const id = `${project}_${eventType}_${Date.now()}`;
      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      const sql = `
          INSERT INTO ai_episodic_memory (id, project_name, event_type, event_data, tenant_id)
          VALUES (:id, :project, :eventType, :data, :tenantId)
        `;

      const jsonValue = typeof data === "object" && data !== null ? data : { val: data };

      await connection.execute(sql, {
        id,
        project,
        eventType,
        data: { val: jsonValue, type: oracledb.DB_TYPE_JSON },
        tenantId
      }, { autoCommit: true });

    } catch (err) {
      logger.error("Error saving episodic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Retrieves episodic memories (change logs / business rules) for a project.
   */
  static async getEpisodicMemories(project: string, eventType?: "BUSINESS_RULE" | "CHANGE_LOG") {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      let sql = `
        SELECT id, event_type, event_data, created_at
        FROM ai_episodic_memory
        WHERE project_name = :project AND tenant_id = :tenantId
      `;
      const binds: Record<string, unknown> = { project, tenantId };

      if (eventType) {
        sql += ` AND event_type = :eventType`;
        binds.eventType = eventType;
      }

      sql += ` ORDER BY created_at DESC`;

      const result = await OracleMemoryService.executeAsync(connection, sql, binds);
      return result.rows ?? [];
    } catch (err) {
      logger.error("Error getting episodic memories:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Tier 2: Semantic Memory - Stores code entity embeddings
   */
  static async saveSemanticMemory(project: string, entities: GraphEntity[]) {
    // Generate embeddings for the entities chunk-by-chunk FIRST without holding a connection
    const contents = entities.map(e => `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}`);
    const embeddings = await generateEmbeddingsBatch(contents, 'passage');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      const sql = `
          MERGE INTO ai_semantic_memory trg
          USING (SELECT :id AS id, :project AS project_name, :type AS entity_type, :name AS entity_name, :path AS file_path, :content AS content, :embedding AS embedding, :tenantId AS tenant_id FROM DUAL) src
          ON (trg.id = src.id)
          WHEN MATCHED THEN UPDATE SET trg.content = src.content, trg.embedding = src.embedding
          WHEN NOT MATCHED THEN INSERT (id, project_name, entity_type, entity_name, file_path, content, embedding, tenant_id)
          VALUES (src.id, src.project_name, src.entity_type, src.entity_name, src.file_path, src.content, src.embedding, src.tenant_id)
        `;

      const binds = entities.map((e, index) => {
        const embeddingVector = embeddings && embeddings[index] ? embeddings[index] : null;
        return {
          id: `${project}_${e.id}`,
          project,
          type: e.type,
          name: e.label,
          path: e.filePath || "",
          content: contents[index],
          embedding: embeddingVector ? new Float32Array(embeddingVector) : null,
          tenantId
        };
      });

      const dbChunkSize = 500;
      for (let i = 0; i < binds.length; i += dbChunkSize) {
        const chunk: any[] = binds.slice(i, i + dbChunkSize);
        await connection.executeMany(sql, chunk, { autoCommit: true });
      }

    } catch (err) {
      logger.error("Error saving semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Tier 3: Relational Memory - Stores relationships (Knowledge Graph)
   */
  static async saveRelationalMemory(project: string, links: GraphLink[]) {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      const sql = `
          MERGE INTO ai_relational_memory trg
          USING (SELECT :src AS source_id, :tgt AS target_id, :project AS project_name, :type AS relationship_type, :tenantId AS tenant_id FROM DUAL) src
          ON (trg.source_id = src.source_id AND trg.target_id = src.target_id AND trg.relationship_type = src.relationship_type AND trg.tenant_id = src.tenant_id)
          WHEN NOT MATCHED THEN INSERT (source_id, target_id, project_name, relationship_type, tenant_id)
          VALUES (src.source_id, src.target_id, src.project_name, src.relationship_type, src.tenant_id)
        `;

      const binds = links.map(l => ({
        src: `${project}_${l.source}`,
        tgt: `${project}_${l.target}`,
        project,
        type: l.type,
        tenantId
      }));

      const dbChunkSize = 1000;
      for (let i = 0; i < binds.length; i += dbChunkSize) {
        const chunk: any[] = binds.slice(i, i + dbChunkSize);
        await connection.executeMany(sql, chunk, { autoCommit: true });
      }

    } catch (err) {
      logger.error("Error saving relational memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Query using AI Vector Search (Native Oracle 26ai feature)
   */
  static async searchSemanticMemory(project: string, query: string, limit: number = 5) {
    // Generate query embedding first, before acquiring database connection
    const queryVector = await generateEmbedding(query, 'query');

    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      const sql = `
          SELECT entity_name, entity_type, file_path, content
          FROM ai_semantic_memory
          WHERE project_name = :project AND tenant_id = :tenantId
          ${queryVector ? 'ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)' : ''}
          FETCH FIRST :limit ROWS ONLY
        `;

      const binds: Record<string, unknown> = { project, limit, tenantId };
      if (queryVector) {
        binds.queryVector = new Float32Array(queryVector);
      }

      const result = await OracleMemoryService.executeAsync(connection, sql, binds);
      return result.rows ?? [];

    } catch (err) {
      logger.error("Error searching semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Graph Analysis: Detect architectural smells (Circular Dependencies, God Objects, Dead Code)
   * Utilizing SQL Property Graph Queries (Oracle 23ai+)
   */
  static async detectArchitecturalSmells(project: string) {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const auth = authStorage.getStore();
      const tenantId = auth ? auth.uid : "admin";

      const smells: ArchSmells = {
        circularDependencies: [],
        godObjects: [],
        deadCode: []
      };

      // 1. Detect Circular Dependencies (Cycles in the dependency graph) using SQL Graph queries
      const circularSql = `
          SELECT DISTINCT entity_name, file_path
          FROM GRAPH_TABLE ( ai_knowledge_graph
            MATCH (a)-[e IS ai_relational_memory]->{1,5}(a)
            WHERE a.project_name = :project AND a.tenant_id = :tenantId
            COLUMNS (a.entity_name, a.file_path)
          )
        `;
      const circularRes = await OracleMemoryService.executeAsync(connection, circularSql, { project, tenantId });
      smells.circularDependencies = (circularRes.rows ?? []) as unknown[];

      // 2. Detect God Objects (Entities with excessively high incoming relationships / high in-degree)
      const godSql = `
          SELECT entity_name, entity_type, file_path, in_degree
          FROM (
            SELECT target_id, count(*) as in_degree
            FROM ai_relational_memory
            WHERE project_name = :project AND tenant_id = :tenantId
            GROUP BY target_id
          ) r
          JOIN ai_semantic_memory s ON r.target_id = s.id AND r.tenant_id = s.tenant_id
          WHERE in_degree > 15
          ORDER BY in_degree DESC
          FETCH FIRST 10 ROWS ONLY
        `;
      const godRes = await OracleMemoryService.executeAsync(connection, godSql, { project, tenantId });
      smells.godObjects = (godRes.rows ?? []) as unknown[];

      // 3. Detect Dead Code (Entities with zero incoming relationships, and not main entry points)
      const deadSql = `
          SELECT entity_name, file_path
          FROM ai_semantic_memory s
          WHERE project_name = :project AND tenant_id = :tenantId
            AND entity_type IN ('function', 'class')
            AND NOT EXISTS (
              SELECT 1 FROM ai_relational_memory r 
              WHERE r.target_id = s.id
            )
          FETCH FIRST 20 ROWS ONLY
        `;
      const deadRes = await OracleMemoryService.executeAsync(connection, deadSql, { project, tenantId });
      smells.deadCode = (deadRes.rows ?? []) as unknown[];

      return smells;

    } catch (err) {
      logger.error("Error detecting smells:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Deletes all episodic, semantic, and relational memory records associated with a project.
   */
  static async deleteProjectMemory(project: string) {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();

      const auth = authStorage.getStore();
      if (!auth || !auth.uid) {
        throw new Error("Authentication context missing for memory deletion.");
      }
      const tenantId = auth.uid;

      await setSessionContext(connection, tenantId);

      // 1. Delete episodic memory
      const deleteEpisodic = `
        DELETE FROM ai_episodic_memory
        WHERE project_name = :project AND tenant_id = :tenantId
      `;
      await connection.execute(deleteEpisodic, { project, tenantId }, { autoCommit: false });

      // 2. Delete semantic memory
      const deleteSemantic = `
        DELETE FROM ai_semantic_memory
        WHERE project_name = :project AND tenant_id = :tenantId
      `;
      await connection.execute(deleteSemantic, { project, tenantId }, { autoCommit: false });

      // 3. Delete relational memory
      const deleteRelational = `
        DELETE FROM ai_relational_memory
        WHERE project_name = :project AND tenant_id = :tenantId
      `;
      await connection.execute(deleteRelational, { project, tenantId }, { autoCommit: false });

      await connection.commit();
      logger.info(`[Oracle Memory] Successfully deleted all memory for project: ${project} and tenant: ${tenantId}`);
    } catch (err) {
      logger.error("Error deleting project memory from Oracle DB:", err instanceof Error ? err.message : String(err));
      if (connection) {
        try {
          await connection.rollback();
          logger.info(`[Oracle Memory] Transaction rolled back for project deletion: ${project}`);
        } catch (rollErr) {
          logger.error("Error rolling back Oracle transaction:", rollErr);
        }
      }
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          logger.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Parses raw episodic memory rows from Oracle DB into a consistent format.
   * Shared between httpServer.ts and mcpTools.ts to avoid duplication.
   */
  static parseEpisodicMemories(memories: Array<Record<string, unknown>>): Array<{ id: unknown; eventType: unknown; data: unknown; createdAt: unknown }> {
    return memories.map((m) => {
      let val = null;
      try {
        if (m.EVENT_DATA) {
          if (typeof m.EVENT_DATA === "string") {
            const parsed: Record<string, unknown> = JSON.parse(m.EVENT_DATA as string);
            val = parsed.val !== undefined ? parsed.val : parsed;
          } else if (typeof m.EVENT_DATA === "object" && m.EVENT_DATA !== null) {
            const eventData = m.EVENT_DATA as Record<string, unknown>;
            val = eventData.val !== undefined ? eventData.val : eventData;
          }
        }
      } catch (e) {
        val = m.EVENT_DATA;
      }
      return {
        id: m.ID,
        eventType: m.EVENT_TYPE,
        data: val,
        createdAt: m.CREATED_AT
      };
    });
  }
}
