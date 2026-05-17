import oracledb from "oracledb";
import * as path from "path";
import { authStorage } from "./context.js";

// Cấu hình kết nối lấy từ .env
const dbConfig = {
  user: process.env.ORACLE_USER || "ADMIN",
  password: process.env.ORACLE_PASSWORD || "",
  connectString: process.env.ORACLE_CONN_STRING || ""
};

/**
 * Service quản lý bộ nhớ AI trên Oracle Database 26ai
 * Sử dụng chế độ Thick Mode (với Oracle Instant Client) để hỗ trợ mTLS ổn định
 */
export class OracleMemoryService {
  private static pool: oracledb.Pool | null = null;

  /**
   * Khởi tạo Connection Pool
   */
  static async init() {
    if (!this.pool) {
      try {
        // Kích hoạt Thick Mode bằng cách trỏ tới Instant Client
        if (process.env.ORACLE_LIB_DIR) {
          console.log("🚀 Initializing Oracle Client in Thick Mode...");
          oracledb.initOracleClient({ 
            libDir: process.env.ORACLE_LIB_DIR,
            configDir: process.env.ORACLE_WALLET_DIR // Chứa tnsnames.ora và wallet files
          });
        }

        // Cấu hình định dạng dữ liệu cho Oracle 26ai
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        oracledb.fetchAsString = [oracledb.CLOB];
        
        this.pool = await oracledb.createPool({
          ...dbConfig,
          poolMin: 2,
          poolMax: 10,
          poolIncrement: 1
        });
        
        console.log("✅ Oracle 26ai DB Pool initialized successfully (Thick Mode)");
      } catch (err: any) {
        console.error("❌ Failed to initialize Oracle DB pool:", err.message);
        throw err;
      }
    }
    return this.pool;
  }

  /**
   * Thiết lập Session Context cho Row-Level Security (Oracle Virtual Private Database)
   */
  private static async setSessionContext(connection: oracledb.Connection) {
    const auth = authStorage.getStore();
    const tenantId = auth ? auth.uid : "admin";
    
    try {
      // Gọi package gán context để Oracle tự động áp dụng chính sách lọc hàng
      const sql = `BEGIN ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId); END;`;
      await connection.execute(sql, { tenantId });
      console.log(`[Oracle RLS] Security Context set for tenant: ${tenantId}`);
    } catch (err: any) {
      console.error("[Oracle RLS] Failed to set security context:", err.message);
      // Không chặn đứng tiến trình nếu DB chưa cài đặt Package/Context (để tránh crash ở local dev)
    }
  }

  /**
   * Tầng 1: Episodic JSON - Lưu trữ sự kiện nghiệp vụ (Business Rules / Change Logs)
   */
  static async saveEpisodicMemory(project: string, eventType: "BUSINESS_RULE" | "CHANGE_LOG", data: any) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
      try {
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
        
      } finally {
        await connection.close();
      }
    } catch (err) {
      console.error("Error saving episodic memory:", err);
    }
  }

  /**
   * Tầng 2: Semantic Memory - Lưu trữ Vector của Code Entities
   */
  static async saveSemanticMemory(project: string, entities: any[]) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
      try {
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
        
      } finally {
        await connection.close();
      }
    } catch (err) {
      console.error("Error saving semantic memory:", err);
    }
  }

  /**
   * Tầng 3: Relational Memory - Lưu trữ quan hệ (Knowledge Graph)
   */
  static async saveRelationalMemory(project: string, links: any[]) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
      try {
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
        
      } finally {
        await connection.close();
      }
    } catch (err) {
      console.error("Error saving relational memory:", err);
    }
  }

  /**
   * Truy vấn bằng AI Vector Search (Native Oracle 26ai)
   */
  static async searchSemanticMemory(project: string, query: string, limit: number = 5) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
      try {
        const sql = `
          SELECT entity_name, entity_type, file_path, content
          FROM ai_semantic_memory
          WHERE project_name = :project
          ORDER BY VECTOR_DISTANCE(embedding, VECTOR_EMBEDDING(my_model USING :query), COSINE)
          FETCH FIRST :limit ROWS ONLY
        `;
        
        const result = await connection.execute(sql, { project, query, limit });
        return result.rows;
        
      } finally {
        await connection.close();
      }
    } catch (err) {
      console.error("Error searching semantic memory:", err);
      return [];
    }
  }

  /**
   * Suy luận trên Knowledge Graph (Oracle 23ai/26ai Graph Features)
   * Tìm kiếm các "Code Smell" kiến trúc: Circular Dependencies, God Objects, Dead Code
   */
  static async detectArchitecturalSmells(project: string) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      await this.setSessionContext(connection);
      
      try {
        const smells: any = {
          circularDependencies: [],
          godObjects: [],
          deadCode: []
        };

        // 1. Tìm Circular Dependencies (Chu trình trong đồ thị)
        // Sử dụng SQL Graph (Oracle 23ai+)
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

        // 2. Tìm God Objects (Các thực thể có quá nhiều kết nối đến - In-degree cao)
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

        // 3. Tìm Dead Code (Các thực thể không có ai gọi đến và không phải entry point)
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
        
      } finally {
        await connection.close();
      }
    } catch (err) {
      console.error("Error detecting smells:", err);
      return null;
    }
  }
}
