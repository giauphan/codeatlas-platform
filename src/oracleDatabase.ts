import oracledb from "oracledb";
import * as path from "path";

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
   * Tầng 1: Episodic JSON - Lưu trữ sự kiện nghiệp vụ (Business Rules / Change Logs)
   */
  static async saveEpisodicMemory(project: string, eventType: "BUSINESS_RULE" | "CHANGE_LOG", data: any) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      
      try {
        const id = `${project}_${eventType}_${Date.now()}`;
        
        const sql = `
          INSERT INTO ai_episodic_memory (id, project_name, event_type, event_data)
          VALUES (:id, :project, :eventType, :data)
        `;
        
        await connection.execute(sql, {
          id,
          project,
          eventType,
          data: { val: data, type: oracledb.DB_TYPE_JSON }
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
      
      try {
        const sql = `
          MERGE INTO ai_semantic_memory trg
          USING (SELECT :id AS id, :project AS project_name, :type AS entity_type, :name AS entity_name, :path AS file_path, :content AS content FROM DUAL) src
          ON (trg.id = src.id)
          WHEN MATCHED THEN UPDATE SET trg.content = src.content
          WHEN NOT MATCHED THEN INSERT (id, project_name, entity_type, entity_name, file_path, content)
          VALUES (src.id, src.project_name, src.entity_type, src.entity_name, src.file_path, src.content)
        `;
        
        const binds = entities.map(e => ({
          id: `${project}_${e.id}`,
          project,
          type: e.type,
          name: e.label,
          path: e.filePath || "",
          content: `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}`
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
   * Truy vấn bằng AI Vector Search (Native Oracle 26ai)
   */
  static async searchSemanticMemory(project: string, query: string, limit: number = 5) {
    try {
      const pool = await this.init();
      const connection = await pool.getConnection();
      
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
}
