// src/database/adapters/postgresAdapter.ts
import { IDatabaseAdapter, VectorSearchResult } from "./interface.js";
import { logger } from "../../utils/logger.js";

interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  release(): void;
}

interface PgPool {
  connect(): Promise<PgPoolClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

type PgPoolConstructor = new (config: Record<string, unknown>) => PgPool;

let PoolClass: PgPoolConstructor | undefined;
let toSql: ((value: number[] | Float32Array) => string) | undefined;

const NAMED_PLACEHOLDER = /[:@\$][a-zA-Z_][a-zA-Z0-9_]*/g;

function formatPgQuery(sql: string, params: Record<string, unknown> | unknown[]): { pgSql: string, paramValues: unknown[] } {
  if (Array.isArray(params)) return { pgSql: sql, paramValues: params };

  let idx = 0;
  const nameToIdx = new Map<string, number>();
  const paramNames: string[] = [];

  const pgSql = sql.replace(NAMED_PLACEHOLDER, (full) => {
    if (full.startsWith('$') && !isNaN(parseInt(full.slice(1), 10))) {
      return full;
    }
    const name = full.slice(1);
    if (!nameToIdx.has(name)) {
      idx++;
      nameToIdx.set(name, idx);
      paramNames.push(name);
    }
    return `$${nameToIdx.get(name)}`;
  });

  if (paramNames.length === 0) {
    return { pgSql: sql, paramValues: Object.values(params) };
  }

  const paramValues = paramNames.map((n) => params[n]);
  return { pgSql, paramValues };
}

function findExportFn<T>(obj: unknown, prop: string): T | undefined {
  if (!obj) return undefined;
  if (typeof obj === "function") return obj as T;
  const rec = obj as Record<string, unknown>;

  if (typeof rec[prop] === "function") return rec[prop] as T;

  if (rec.default) {
    if (typeof rec.default === "function") return rec.default as T;
    if (typeof rec.default === "object") {
      const found = findExportFn<T>(rec.default, prop);
      if (found) return found;
    }
  }

  return undefined;
}

export class PostgresAdapter implements IDatabaseAdapter {
  private pool: PgPool | null = null;
  private connectPromise: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.pool) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        if (!PoolClass) {
          const pg = await import("pg");
          PoolClass = findExportFn<PgPoolConstructor>(pg, "Pool");
          if (!PoolClass) {
            throw new Error("Postgres adapter requires 'pg'. Install: pnpm add pg @types/pg");
          }
        }
        if (!toSql) {
          const pgv = await import("pgvector/pg" as unknown as string);
          toSql = findExportFn<typeof toSql>(pgv, "toSql");
          if (!toSql) {
            throw new Error("Postgres adapter requires 'pgvector'. Install: pnpm add pgvector @types/pgvector");
          }
        }
        this.pool = new PoolClass({
          user: process.env.POSTGRES_USER || "postgres",
          password: process.env.POSTGRES_PASSWORD || "postgres",
          host: process.env.POSTGRES_HOST || "localhost",
          port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
          database: process.env.POSTGRES_DB || "codeatlas",
          max: 10,
          idleTimeoutMillis: 30000,
        });

        logger.info("[PostgresAdapter] Connected to PostgreSQL database pool.");
      } catch (err) {
        this.connectPromise = null;
        if (err instanceof Error && err.message.startsWith("Postgres adapter requires")) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Postgres adapter failed to connect: ${msg}`);
      }
    })();

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (err) {
        logger.error("Error closing Postgres pool:", err instanceof Error ? err.message : String(err));
      } finally {
        this.pool = null;
        this.connectPromise = null;
      }
    }
  }

  async getConnection(): Promise<unknown> {
    if (!this.pool) await this.connect();
    return this.pool!.connect();
  }

  async query<T>(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<T[]> {
    if (!this.pool) await this.connect();
    const { pgSql, paramValues } = formatPgQuery(sql, params);
    const res = await this.pool!.query(pgSql, paramValues);
    return res.rows as T[];
  }

  async execute(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<{ rowsAffected: number }> {
    if (!this.pool) await this.connect();
    const { pgSql, paramValues } = formatPgQuery(sql, params);
    const res = await this.pool!.query(pgSql, paramValues);
    return { rowsAffected: res.rowCount ?? 0 };
  }

  async executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }> {
    if (!this.pool) await this.connect();
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      let totalChanges = 0;
      // Extract the pg format once
      const firstParam = params.length > 0 ? params[0] : {};
      const { pgSql } = formatPgQuery(sql, firstParam);

      for (const p of params) {
        const { paramValues } = formatPgQuery(sql, p);
        const res = await client.query(pgSql, paramValues);
        totalChanges += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { rowsAffected: totalChanges };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string, filterBinds?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    if (!this.pool) await this.connect();
    const vectorSql = toSql ? toSql(embedding) : JSON.stringify(embedding);

    const params: unknown[] = [vectorSql, tenantId, limit];
    let finalTable = table;

    if (filterBinds) {
      let currentParamIndex = 4;
      for (const [key, value] of Object.entries(filterBinds)) {
        const searchStr = `:${key}`;
        // Using split and join to safely replace all occurrences without regex vulnerabilities
        if (finalTable.includes(searchStr)) {
          finalTable = finalTable.split(searchStr).join(`$${currentParamIndex}`);
          params.push(value);
          currentParamIndex++;
        }
      }
    }

    const sql = `
      SELECT id, 1 - (embedding <=> $1::vector) AS score
      FROM ${finalTable}
      WHERE tenant_id = $2
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $3
    `;
    return this.query<VectorSearchResult>(sql, params);
  }

  async initializeSchema(): Promise<void> {
    if (!this.pool) await this.connect();
    await this.pool!.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ai_dreaming_memory (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255),
        project VARCHAR(255),
        provider VARCHAR(255),
        memory_type VARCHAR(255),
        content TEXT,
        content_hash VARCHAR(255),
        importance FLOAT DEFAULT 0.5,
        confidence FLOAT DEFAULT 0.5,
        embedding vector(1024),
        status VARCHAR(50) DEFAULT 'active',
        scope VARCHAR(255),
        tags TEXT,
        lifecycle_stage VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP WITH TIME ZONE,
        access_count INT DEFAULT 0,
        tenant_id VARCHAR(255) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
      CREATE INDEX IF NOT EXISTS idx_dreaming_embedding ON ai_dreaming_memory USING ivfflat (embedding vector_cosine_ops);
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        tier VARCHAR(50) DEFAULT 'free'
      );

      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id),
        email VARCHAR(255) UNIQUE,
        name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        tier VARCHAR(50) DEFAULT 'free',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS keys (
        id VARCHAR(255) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id),
        user_id VARCHAR(255) REFERENCES users(id),
        name VARCHAR(255),
        key VARCHAR(255) NOT NULL UNIQUE,
        key_hash VARCHAR(255),
        tier VARCHAR(50) DEFAULT 'free',
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(255) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS codeatlas_genome (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        problem TEXT,
        solution TEXT,
        architecture VARCHAR(255),
        category VARCHAR(255),
        project VARCHAR(255),
        confidence FLOAT DEFAULT 0.5,
        version INT DEFAULT 1,
        evolution_score INT DEFAULT 1,
        usage_count INT DEFAULT 0,
        success_rate FLOAT DEFAULT 0.5,
        embedding vector(1024),
        status VARCHAR(50) DEFAULT 'active',
        source_type VARCHAR(255),
        source_id VARCHAR(255),
        dependencies TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        tenant_id VARCHAR(255) NOT NULL
      );
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_genome_tenant_category ON codeatlas_genome(tenant_id, category);
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_genome_tenant_proj_cat ON codeatlas_genome(tenant_id, project, category);
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_genome_embedding ON codeatlas_genome USING ivfflat (embedding vector_cosine_ops);
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ai_semantic_memory (
        id VARCHAR(255) PRIMARY KEY,
        project_name VARCHAR(255),
        entity_type VARCHAR(255),
        entity_name VARCHAR(255),
        file_path VARCHAR(500),
        content TEXT,
        embedding vector(1024),
        tenant_id VARCHAR(255) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_tenant_project ON ai_semantic_memory(tenant_id, project_name);
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ai_relational_memory (
        source_id VARCHAR(255),
        target_id VARCHAR(255),
        project_name VARCHAR(255),
        relationship_type VARCHAR(255),
        tenant_id VARCHAR(255) NOT NULL,
        PRIMARY KEY (source_id, target_id, project_name, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_tenant_project ON ai_relational_memory(tenant_id, project_name);
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ai_episodic_memory (
        id VARCHAR(255) PRIMARY KEY,
        event_type VARCHAR(255),
        event_data TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        tenant_id VARCHAR(255) NOT NULL
      );
    `);
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS codeatlas_concepts (
        id VARCHAR(255) PRIMARY KEY,
        label VARCHAR(255),
        description TEXT,
        category VARCHAR(255),
        embedding vector(1024),
        project VARCHAR(255),
        confidence FLOAT DEFAULT 0.5,
        source_ids TEXT,
        evidence_count INT DEFAULT 1,
        access_count INT DEFAULT 0,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP WITH TIME ZONE,
        tenant_id VARCHAR(255) NOT NULL
      );
    `);
    logger.info("[PostgresAdapter] Schema initialized.");
  }

  async checkColumnExists(table: string, column: string): Promise<boolean> {
    if (!this.pool) await this.connect();
    const sql = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
    `;
    const rows = await this.query<{ column_name: string }>(sql, [table, column]);
    return rows.length > 0;
  }

  async detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    if (!this.pool) await this.connect();
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
    if (!this.pool) await this.connect();
    const sql = `
      SELECT s.entity_name, r.in_degree
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
    if (!this.pool) await this.connect();
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
