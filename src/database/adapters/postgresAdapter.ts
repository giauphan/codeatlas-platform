// src/database/adapters/postgresAdapter.ts
import { IDatabaseAdapter, VectorSearchResult } from "./interface.js";
import { logger } from "../../utils/logger.js";

// Lazy-loaded optional dependencies
let Pool: typeof import("pg").Pool;
let pgvector: typeof import("pgvector");

const importPg = async () => {
  if (!Pool) {
    const pg = await import("pg");
    Pool = pg.default ? pg.default.Pool || pg.Pool : pg.Pool;
  }
};

const importPgvector = async () => {
  if (!pgvector) {
    // @ts-ignore: Dynamic import of optional dependency
    const pgv = await import("pgvector/pg");
    pgvector = pgv;
  }
};

interface PgPool {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
  end: () => Promise<void>;
}

export class PostgresAdapter implements IDatabaseAdapter {
  private pool: PgPool | null = null;

  constructor() {
    // Dynamic import initialization is handled in connect()
  }

  async connect(): Promise<void> {
    try {
      await importPg();
      await importPgvector();
    } catch (err) {
      throw new Error(
        "Postgres adapter requires 'pg' and 'pgvector'. Install: pnpm add pg pgvector"
      );
    }

    this.pool = new Pool({
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || "5432"),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    });
    logger.info("[PostgresAdapter] Connected to PostgreSQL");
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (err) {
        logger.error("Error closing Postgres pool:", err instanceof Error ? err.message : String(err));
      } finally {
        this.pool = null;
      }
    }
  }

  async getConnection(): Promise<PgPool> {
    if (!this.pool) await this.connect();
    return this.pool!;
  }

  async query<T>(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<T[]> {
    const pool = await this.getConnection();
    const result = await pool.query(sql, Array.isArray(params) ? params : Object.values(params));
    return result.rows as T[];
  }

  async execute(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<{ rowsAffected: number }> {
    const pool = await this.getConnection();
    const result = await pool.query(sql, Array.isArray(params) ? params : Object.values(params));
    return { rowsAffected: result.rowCount || 0 };
  }

  async executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }> {
    const pool = await this.getConnection();
    let totalRows = 0;
    for (const p of params) {
      const result = await pool.query(sql, Object.values(p));
      totalRows += result.rowCount || 0;
    }
    return { rowsAffected: totalRows };
  }

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string): Promise<VectorSearchResult[]> {
    const pool = await this.getConnection();
    const embeddingVector = pgvector.toSql(embedding);
    const sql = `
      SELECT id, 1 - (embedding <=> $1) AS score
      FROM ${table}
      WHERE tenant_id = $2
      ORDER BY score DESC
      LIMIT $3
    `;
    const result = await pool.query(sql, [embeddingVector, tenantId, limit]);
    return result.rows as VectorSearchResult[];
  }

  async initializeSchema(): Promise<void> {
    const pool = await this.getConnection();
    // Create tables with IF NOT EXISTS
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query("CREATE EXTENSION IF NOT EXISTS btree_gin");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_dreaming_memory (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project TEXT,
        provider TEXT,
        memory_type TEXT,
        content TEXT,
        content_hash TEXT,
        importance REAL DEFAULT 0.5,
        confidence REAL DEFAULT 0.5,
        embedding vector(1024),
        status TEXT DEFAULT 'active',
        scope TEXT,
        tags JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        last_accessed_at TIMESTAMP,
        access_count INTEGER DEFAULT 0,
        tenant_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
      CREATE INDEX IF NOT EXISTS idx_dreaming_embedding ON ai_dreaming_memory USING ivfflat (embedding vector_cosine_ops);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS codeatlas_genome (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        problem TEXT,
        solution TEXT,
        architecture TEXT,
        category TEXT,
        project TEXT,
        confidence REAL DEFAULT 0.5,
        version INTEGER DEFAULT 1,
        evolution_score INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0.5,
        embedding vector(1024),
        status TEXT DEFAULT 'active',
        source_type TEXT,
        source_id TEXT,
        dependencies JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        tenant_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_genome_embedding ON codeatlas_genome USING ivfflat (embedding vector_cosine_ops);
    `);

    logger.info("[PostgresAdapter] Schema initialized.");
  }

  async checkColumnExists(table: string, column: string): Promise<boolean> {
    const sql = `
      SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
    `;
    const result = await this.query(sql, [table, column]);
    return result.length > 0;
  }

  async detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    // Recursive CTE replacement for Oracle GRAPH_TABLE
    const sql = `
      WITH RECURSIVE dependency_chain AS (
        SELECT source_id, target_id, 1 AS depth
        FROM ai_relational_memory
        WHERE project_name = $1 AND tenant_id = $2
        UNION ALL
        SELECT r.source_id, r.target_id, dc.depth + 1
        FROM ai_relational_memory r
        JOIN dependency_chain dc ON r.source_id = dc.target_id
        WHERE dc.depth < 5 AND r.project_name = $1 AND r.tenant_id = $2
      )
      SELECT DISTINCT s.entity_name, s.file_path
      FROM dependency_chain dc
      JOIN ai_semantic_memory s ON dc.source_id = s.id
      WHERE dc.source_id = dc.target_id
    `;
    return this.query(sql, [project, tenantId]);
  }

  async detectGodObjects(project: string, tenantId: string): Promise<Array<{ entity_name: string; in_degree: number }>> {
    const sql = `
      SELECT s.entity_name, s.entity_type, s.file_path, r.in_degree
      FROM (
        SELECT target_id, count(*) AS in_degree
        FROM ai_relational_memory
        WHERE project_name = $1 AND tenant_id = $2
        GROUP BY target_id
      ) r
      JOIN ai_semantic_memory s ON r.target_id = s.id
      WHERE r.in_degree > 15
      ORDER BY r.in_degree DESC
      LIMIT 10
    `;
    return this.query(sql, [project, tenantId]);
  }

  async detectDeadCode(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    const sql = `
      SELECT s.entity_name, s.file_path
      FROM ai_semantic_memory s
      WHERE s.project_name = $1 AND s.tenant_id = $2
        AND s.entity_type IN ('function', 'class')
        AND NOT EXISTS (
          SELECT 1 FROM ai_relational_memory r
          WHERE r.target_id = s.id AND r.tenant_id = s.tenant_id
        )
      LIMIT 20
    `;
    return this.query(sql, [project, tenantId]);
  }
}