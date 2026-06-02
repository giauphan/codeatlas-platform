import oracledb from "oracledb";
import * as path from "path";
import { authStorage } from "./context.js";

// Connection configuration derived from environment variables
const dbConfig = {
  user: process.env.ORACLE_USER || "ADMIN",
  password: process.env.ORACLE_PASSWORD || "",
  connectString: process.env.ORACLE_CONN_STRING || ""
};

/**
 * Service to manage AI Memory on Oracle Database 26ai.
 * Employs Thick Mode (via Oracle Instant Client) to support stable mTLS connections.
 */
export class OracleMemoryService {
  private static pool: oracledb.Pool | null = null;

  /**
   * Initializes the Connection Pool
   */
  static async init() {
    if (!this.pool) {
      try {
        // Activate Thick Mode by pointing to the Oracle Instant Client directory
        if (process.env.ORACLE_LIB_DIR) {
          console.log("🚀 Initializing Oracle Client in Thick Mode...");
          try {
            const initOptions: any = {
              configDir: process.env.ORACLE_WALLET_DIR // Contains tnsnames.ora and wallet files
            };
            // On Linux, passing libDir is not supported in initOracleClient() and causes DPI-1047 or crash.
            // Systems libraries must be configured via LD_LIBRARY_PATH or ldconfig on Linux.
            if (process.platform !== "linux") {
              initOptions.libDir = process.env.ORACLE_LIB_DIR;
            }
            oracledb.initOracleClient(initOptions);
          } catch (initErr: any) {
            if (initErr.message && initErr.message.includes("already initialized")) {
              console.log("ℹ️ Oracle Client is already initialized.");
            } else {
              console.warn("⚠️ Warning initializing Oracle Client in Thick Mode:", initErr.message || String(initErr));
            }
          }
        }

        // Configure standard data formats for Oracle 26ai
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        oracledb.fetchAsString = [oracledb.CLOB];
        
        this.pool = await oracledb.createPool({
          ...dbConfig,
          poolMin: 2,
          poolMax: 10,
          poolIncrement: 1
        });
        
        console.log("✅ Oracle 26ai DB Pool initialized successfully (Thick Mode)");
      } catch (err: unknown) {
        console.error("❌ Failed to initialize Oracle DB pool:", err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    return this.pool;
  }

  /**
   * Configures the Session Context for Row-Level Security (Oracle Virtual Private Database)
   */
  private static async setSessionContext(connection: oracledb.Connection, overrideTenantId?: string) {
    const auth = authStorage.getStore();
    const tenantId = overrideTenantId || (auth ? auth.uid : "admin");
    
    try {
      // Invoke the context package to dynamically apply Row-Level Security row-filtering policies
      const sql = `BEGIN ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId); END;`;
      await connection.execute(sql, { tenantId });
      console.log(`[Oracle RLS] Security Context set for tenant: ${tenantId}`);
    } catch (err: unknown) {
      console.error("[Oracle RLS] Failed to set security context:", err instanceof Error ? err.message : String(err));
      // Do not block execution if package/context is not installed (prevents local dev crashes)
      if (process.env.NODE_ENV === "production") {
        throw err;
      }
    }
  }

  /**
   * Tier 1: Episodic JSON - Stores business events (Business Rules / Change Logs)
   */
  static async saveEpisodicMemory(project: string, eventType: "BUSINESS_RULE" | "CHANGE_LOG", data: any) {
    let connection;
    try {
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
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
      console.error("Error saving episodic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
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
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);

      let sql = `
        SELECT id, event_type, event_data, created_at
        FROM ai_episodic_memory
        WHERE project_name = :project
      `;
      const binds: any = { project };

      if (eventType) {
        sql += ` AND event_type = :eventType`;
        binds.eventType = eventType;
      }

      sql += ` ORDER BY created_at DESC`;

      const result = await connection.execute(sql, binds);
      return result.rows || [];
    } catch (err) {
      console.error("Error getting episodic memories:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
        }
      }
    }
  }


  /**
   * Generates an embedding vector using NVIDIA NIM Embeddings API
   */
  private static async generateNvidiaEmbedding(text: string, inputType: 'passage' | 'query'): Promise<number[] | null> {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      console.warn("[NVIDIA SDK] NVIDIA_API_KEY is not set. Skipping embedding generation.");
      return null;
    }

    try {
      const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "nvidia/nv-embed-v1",
          input: [text],
          input_type: inputType,
          encoding_format: "float",
          truncate: "NONE"
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[NVIDIA SDK] API returned error ${response.status}: ${errText}`);
        return null;
      }

      const data: any = await response.json();
      if (data && data.data && data.data[0] && data.data[0].embedding) {
        return data.data[0].embedding;
      }
      return null;
    } catch (error) {
      console.error("[NVIDIA SDK] Connection error to NVIDIA Embeddings API:", error);
      return null;
    }
  }

  /**
   * Generates embeddings in batches using NVIDIA NIM Embeddings API
   */
  private static async generateNvidiaEmbeddingsBatch(texts: string[], inputType: 'passage' | 'query'): Promise<number[][] | null> {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      console.warn("[NVIDIA SDK] NVIDIA_API_KEY is not set. Skipping embedding generation.");
      return null;
    }

    const results: number[][] = [];
    const chunkSize = 50; // process 50 texts at a time to prevent payload size issues

    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      try {
        const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "nvidia/nv-embed-v1",
            input: chunk,
            input_type: inputType,
            encoding_format: "float",
            truncate: "NONE"
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[NVIDIA SDK] API returned error ${response.status}: ${errText}`);
          return null;
        }

        const data: any = await response.json();
        if (data && data.data) {
          const embeddings = data.data.map((item: any) => item.embedding);
          results.push(...embeddings);
        } else {
          return null;
        }
      } catch (error) {
        console.error("[NVIDIA SDK] Connection error to NVIDIA Embeddings API:", error);
        return null;
      }
    }

    return results;
  }

  /**
   * Tier 2: Semantic Memory - Stores code entity embeddings
   */
  static async saveSemanticMemory(project: string, entities: any[]) {
    let connection;
    try {
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
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
        
        // Generate embeddings for the entities chunk-by-chunk
        const contents = entities.map(e => `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}`);
        const embeddings = await this.generateNvidiaEmbeddingsBatch(contents, 'passage');

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

        await connection.executeMany(sql, binds as any[], { autoCommit: true });
        

    } catch (err) {
      console.error("Error saving semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Tier 3: Relational Memory - Stores relationships (Knowledge Graph)
   */
  static async saveRelationalMemory(project: string, links: any[]) {
    let connection;
    try {
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
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

        await connection.executeMany(sql, binds, { autoCommit: true });
        

    } catch (err) {
      console.error("Error saving relational memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Query using AI Vector Search (Native Oracle 26ai feature)
   */
  static async searchSemanticMemory(project: string, query: string, limit: number = 5) {
    let connection;
    try {
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
        const queryVector = await this.generateNvidiaEmbedding(query, 'query');
      
        const sql = `
          SELECT entity_name, entity_type, file_path, content
          FROM ai_semantic_memory
          WHERE project_name = :project
          ${queryVector ? 'ORDER BY VECTOR_DISTANCE(embedding, :queryVector, COSINE)' : ''}
          FETCH FIRST :limit ROWS ONLY
        `;
        
        const binds: any = { project, limit };
        if (queryVector) {
          binds.queryVector = new Float32Array(queryVector);
        }
        
        const result = await connection.execute(sql, binds);
        return result.rows;
        

    } catch (err) {
      console.error("Error searching semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
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
      const pool = await this.init();
      connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
        const smells: any = {
          circularDependencies: [],
          godObjects: [],
          deadCode: []
        };

        // 1. Detect Circular Dependencies (Cycles in the dependency graph) using SQL Graph queries
        const circularSql = `
          SELECT DISTINCT entity_name, file_path
          FROM GRAPH_TABLE ( ai_knowledge_graph
            MATCH (a)-[e IS ai_relational_memory]->{1,5}(a)
            WHERE a.project_name = :project
            COLUMNS (a.entity_name, a.file_path)
          )
        `;
        const circularRes = await connection.execute(circularSql, { project });
        smells.circularDependencies = circularRes.rows;

        // 2. Detect God Objects (Entities with excessively high incoming relationships / high in-degree)
        const godSql = `
          SELECT entity_name, entity_type, file_path, in_degree
          FROM (
            SELECT target_id, count(*) as in_degree
            FROM ai_relational_memory
            WHERE project_name = :project
            GROUP BY target_id
          ) r
          JOIN ai_semantic_memory s ON r.target_id = s.id
          WHERE in_degree > 15
          ORDER BY in_degree DESC
          FETCH FIRST 10 ROWS ONLY
        `;
        const godRes = await connection.execute(godSql, { project });
        smells.godObjects = godRes.rows;

        // 3. Detect Dead Code (Entities with zero incoming relationships, and not main entry points)
        const deadSql = `
          SELECT entity_name, file_path
          FROM ai_semantic_memory s
          WHERE project_name = :project
            AND entity_type IN ('function', 'class')
            AND NOT EXISTS (
              SELECT 1 FROM ai_relational_memory r 
              WHERE r.target_id = s.id
            )
          FETCH FIRST 20 ROWS ONLY
        `;
        const deadRes = await connection.execute(deadSql, { project });
        smells.deadCode = deadRes.rows;

        return smells;
        

    } catch (err) {
      console.error("Error detecting smells:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
        }
      }
    }
  }

  /**
   * Deletes all episodic, semantic, and relational memory records associated with a project.
   */
  static async deleteProjectMemory(project: string, tenantId?: string) {
    let connection;
    try {
      const pool = await this.init();
      connection = await pool.getConnection();
      
      const auth = authStorage.getStore();
      const resolvedTenantId = tenantId || (auth ? auth.uid : "admin");
      
      await this.setSessionContext(connection, resolvedTenantId);

      // 1. Delete episodic memory
      const deleteEpisodic = `
        DELETE FROM ai_episodic_memory 
        WHERE project_name = :project AND tenant_id = :resolvedTenantId
      `;
      await connection.execute(deleteEpisodic, { project, resolvedTenantId });

      // 2. Delete semantic memory
      const deleteSemantic = `
        DELETE FROM ai_semantic_memory 
        WHERE project_name = :project AND tenant_id = :resolvedTenantId
      `;
      await connection.execute(deleteSemantic, { project, resolvedTenantId });

      // 3. Delete relational memory
      const deleteRelational = `
        DELETE FROM ai_relational_memory 
        WHERE project_name = :project AND tenant_id = :resolvedTenantId
      `;
      await connection.execute(deleteRelational, { project, resolvedTenantId });

      await connection.commit();
      console.log(`[Oracle Memory] Successfully deleted all memory for project: ${project} and tenant: ${resolvedTenantId}`);
    } catch (err) {
      console.error("Error deleting project memory from Oracle DB:", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeErr) {
          console.error("Error closing connection:", closeErr);
        }
      }
    }
  }
}
