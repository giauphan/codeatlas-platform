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
          oracledb.initOracleClient({ 
            libDir: process.env.ORACLE_LIB_DIR,
            configDir: process.env.ORACLE_WALLET_DIR // Contains tnsnames.ora and wallet files
          });
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
  private static async setSessionContext(connection: oracledb.Connection) {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : "admin";
    
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
        
        await connection.execute(sql, {
          id,
          project,
          eventType,
          data: { val: data, type: oracledb.DB_TYPE_JSON },
          tenantId
        }, { autoCommit: true });
        

    } catch (err) {
      console.error("Error saving episodic memory:", err instanceof Error ? err.message : String(err));
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
          USING (SELECT :id AS id, :project AS project_name, :type AS entity_type, :name AS entity_name, :path AS file_path, :content AS content, :tenantId AS tenant_id FROM DUAL) src
          ON (trg.id = src.id)
          WHEN MATCHED THEN UPDATE SET trg.content = src.content
          WHEN NOT MATCHED THEN INSERT (id, project_name, entity_type, entity_name, file_path, content, tenant_id)
          VALUES (src.id, src.project_name, src.entity_type, src.entity_name, src.file_path, src.content, src.tenant_id)
        `;
        
        const binds = entities.map(e => ({
          id: `${project}_${e.id}`,
          project,
          type: e.type,
          name: e.label,
          path: e.filePath || "",
          content: `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}`,
          tenantId
        }));

        await connection.executeMany(sql, binds, { autoCommit: true });
        

    } catch (err) {
      console.error("Error saving semantic memory:", err instanceof Error ? err.message : String(err));
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
      
        const sql = `
          SELECT entity_name, entity_type, file_path, content
          FROM ai_semantic_memory
          WHERE project_name = :project
          ORDER BY VECTOR_DISTANCE(embedding, VECTOR_EMBEDDING(my_model USING :query), COSINE)
          FETCH FIRST :limit ROWS ONLY
        `;
        
        const result = await connection.execute(sql, { project, query, limit });
        return result.rows;
        

    } catch (err) {
      console.error("Error searching semantic memory:", err instanceof Error ? err.message : String(err));
      return [];
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
      return null;
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
