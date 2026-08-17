// src/database/adapters/oracleAdapter.ts
import oracledb from "oracledb";
import { IDatabaseAdapter, VectorSearchResult } from "./interface.js";
import { initPool, setSessionContext } from "../../database/connection.js";
import { authStorage } from "../../utils/context.js";
import { logger } from "../../utils/logger.js";

export class OracleAdapter implements IDatabaseAdapter {
  private pool: oracledb.Pool | null = null;

  async connect(): Promise<void> {
    this.pool = await initPool();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close(0);
      } catch (err) {
        logger.error("Error closing Oracle pool:", err instanceof Error ? err.message : String(err));
      } finally {
        this.pool = null;
      }
    }
  }

  async getConnection(): Promise<oracledb.Connection> {
    if (!this.pool) {
      throw new Error("Oracle pool not initialized. Call connect() first.");
    }
    const conn = await this.pool.getConnection();
    const auth = authStorage.getStore();
    if (!auth) {
      await conn.close();
      throw new Error("Authentication context required for session context.");
    }
    await setSessionContext(conn);
    return conn;
  }

  async query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const conn = await this.getConnection();
    try {
      const result = await conn.execute(sql, params as oracledb.BindParameters);
      return (result.rows || []) as T[];
    } finally {
      await conn.close();
    }
  }

  async execute(sql: string, params: Record<string, unknown> = {}): Promise<{ rowsAffected: number }> {
    const conn = await this.getConnection();
    try {
      const result = await conn.execute(sql, params as oracledb.BindParameters, { autoCommit: true });
      return { rowsAffected: result.rowsAffected || 0 };
    } finally {
      await conn.close();
    }
  }

  async executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }> {
    const conn = await this.getConnection();
    try {
      const result = await conn.executeMany(sql, params as oracledb.BindParameters[], { autoCommit: true });
      return { rowsAffected: result.rowsAffected || 0 };
    } finally {
      await conn.close();
    }
  }

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string): Promise<VectorSearchResult[]> {
    const queryVector = new Float32Array(embedding);
    const sql = `
      SELECT id, 0.5 * (1 - VECTOR_DISTANCE(embedding, :queryVector, COSINE)) AS score
      FROM ${table}
      WHERE tenant_id = :tenantId
      ORDER BY score DESC
      FETCH FIRST :limit ROWS ONLY
    `;
    return this.query<VectorSearchResult>(sql, { queryVector, tenantId, limit });
  }

  async initializeSchema(): Promise<void> {
    // Oracle schema initialization remains unchanged (existing DDL)
    logger.info("[OracleAdapter] Schema initialization delegated to existing services.");
  }

  async checkColumnExists(table: string, column: string): Promise<boolean> {
    const sql = `SELECT COUNT(*) AS cnt FROM USER_TAB_COLUMNS WHERE table_name = :table AND column_name = :column`;
    const result = await this.query<{ cnt: number }>(sql, { table: table.toUpperCase(), column: column.toUpperCase() });
    return result[0]?.cnt > 0;
  }

  async detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    const sql = `
      SELECT DISTINCT entity_name, file_path
      FROM GRAPH_TABLE ( ai_knowledge_graph
        MATCH (a)-[e IS ai_relational_memory]->{1,5}(a)
        WHERE a.project_name = :project AND a.tenant_id = :tenantId
        COLUMNS (a.entity_name, a.file_path)
      )
    `;
    return this.query(sql, { project, tenantId });
  }

  async detectGodObjects(project: string, tenantId: string): Promise<Array<{ entity_name: string; in_degree: number }>> {
    const sql = `
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
    return this.query(sql, { project, tenantId });
  }

  async detectDeadCode(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    const sql = `
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
    return this.query(sql, { project, tenantId });
  }
}
