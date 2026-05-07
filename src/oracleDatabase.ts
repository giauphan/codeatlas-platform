import oracledb from "oracledb";

// Cấu hình kết nối
// User cần cấu hình biến môi trường hoặc thay đổi trực tiếp
const dbConfig = {
  user: process.env.ORACLE_USER || "CODEATLAS",
  password: process.env.ORACLE_PASSWORD || "CodeAtlas_123",
  connectString: process.env.ORACLE_CONN_STRING || "localhost:1521/FREEPDB1" 
};

export class OracleMemoryService {
  private static pool: oracledb.Pool | null = null;

  /**
   * Khởi tạo Connection Pool
   */
  static async init() {
    if (!this.pool) {
      try {
        // Tuỳ chọn tối ưu cho 23ai/26ai
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        oracledb.fetchAsString = [oracledb.CLOB];
        
        this.pool = await oracledb.createPool({
          ...dbConfig,
          poolMin: 2,
          poolMax: 10,
          poolIncrement: 1
        });
        console.log("Oracle 26ai DB Pool initialized");
      } catch (err) {
        console.error("Failed to initialize Oracle DB pool", err);
      }
    }
  }

  /**
   * Tầng 1: Episodic JSONL - Lưu trữ sự kiện nghiệp vụ (Business Rules / Change Logs)
   */
  static async saveEpisodicMemory(project: string, eventType: "BUSINESS_RULE" | "CHANGE_LOG", data: any) {
    await this.init();
    let connection;
    try {
      connection = await this.pool!.getConnection();
      const id = `${project}_${eventType}_${Date.now()}`;
      
      const sql = `
        INSERT INTO ai_episodic_memory (id, project_name, event_type, event_data)
        VALUES (:id, :project, :eventType, :data)
      `;
      
      await connection.execute(sql, {
        id,
        project,
        eventType,
        // Oracle 26ai native JSON type
        data: { val: data, type: oracledb.DB_TYPE_JSON }
      }, { autoCommit: true });
      
    } catch (err) {
      console.error("Error saving episodic memory", err);
    } finally {
      if (connection) await connection.close();
    }
  }

  /**
   * Tầng 2: Semantic Memory - Lưu trữ Vector của Code Entities
   * Ghi chú: Oracle 26ai hỗ trợ sinh Vector tự động qua hàm VECTOR_EMBEDDING nếu đã load model
   */
  static async saveSemanticMemory(project: string, entities: any[]) {
    await this.init();
    let connection;
    try {
      connection = await this.pool!.getConnection();
      
      // Batch insert để tối ưu hiệu năng
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
        content: `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}` // Dữ liệu thô để sinh vector
      }));

      await connection.executeMany(sql, binds, { autoCommit: true });
      
    } catch (err) {
      console.error("Error saving semantic memory", err);
    } finally {
      if (connection) await connection.close();
    }
  }

  /**
   * Truy vấn bằng AI Vector Search (Native Oracle 26ai)
   * Tìm kiếm các file/logic liên quan dựa vào câu lệnh tự nhiên
   */
  static async searchSemanticMemory(project: string, query: string, limit: number = 5) {
    await this.init();
    let connection;
    try {
      connection = await this.pool!.getConnection();
      
      // VECTOR_DISTANCE: Native Oracle 26ai function
      // Giả sử cột embedding đã được sinh tự động
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
      console.error("Error searching semantic memory", err);
      return [];
    } finally {
      if (connection) await connection.close();
    }
  }
}
