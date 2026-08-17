// src/database/adapters/sqliteAdapter.ts
import { IDatabaseAdapter, VectorSearchResult } from "./interface.js";
import { authStorage } from "../../utils/context.js";
import { logger } from "../../utils/logger.js";

// Lazy-loaded optional dependencies to avoid hard require when DB_TYPE != sqlite
let Database: any;
let sqliteVec: any;

export class SQLiteAdapter implements IDatabaseAdapter {
  private db: any;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = process.env.CODEATLAS_SQLITE_PATH || "./data/codeatlas.db";
  }

  async connect(): Promise<void> {
    if (this.db) return;
    try {
      const DatabaseModule = await import("better-sqlite3");
      const sqliteVecModule = await import("sqlite-vec");
      Database = DatabaseModule.default;
      sqliteVec = sqliteVecModule.load;
    } catch (err) {
      throw new Error(
        "SQLite adapter requires 'better-sqlite3' and 'sqlite-vec'. Install: pnpm add better-sqlite3 sqlite-vec"
      );
    }
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    sqliteVec(this.db);
    logger.info(`[SQLiteAdapter] Connected to ${this.dbPath}`);
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logger.error("Error closing SQLite connection:", err instanceof Error ? err.message : String(err));
      } finally {
        this.db = null;
      }
    }
  }

  async getConnection(): Promise<any> {
    if (!this.db) await this.connect();
    return this.db;
  }

  async query<T>(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<T[]> {
    if (!this.db) await this.connect();
    const stmt = this.db.prepare(sql);
    const result = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    return result as T[];
  }

  async execute(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<{ rowsAffected: number }> {
    if (!this.db) await this.connect();
    const stmt = this.db.prepare(sql);
    const info = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { rowsAffected: info.changes };
  }

  async executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }> {
    if (!this.db) await this.connect();
    let totalChanges = 0;
    this.db.transaction(() => {
      const stmt = this.db.prepare(sql);
      for (const p of params) {
        const info = stmt.run(p);
        totalChanges += info.changes;
      }
    })();
    return { rowsAffected: totalChanges };
  }

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string): Promise<VectorSearchResult[]> {
    if (!this.db) await this.connect();
    const embeddingBinary = new Uint8Array(new Float32Array(embedding).buffer);
    const sql = `
      SELECT id, 1 - vec_distance_cosine(embedding, ?) AS score
      FROM ${table}
      WHERE tenant_id = ?
      ORDER BY score DESC
      LIMIT ?
    `;
    return this.query<VectorSearchResult>(sql, [embeddingBinary, tenantId, limit]);
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) await this.connect();
    this.db.exec(`
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
        embedding BLOB,
        status TEXT DEFAULT 'active',
        scope TEXT,
        tags TEXT,
        lifecycle_stage TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_accessed_at TEXT,
        access_count INTEGER DEFAULT 0,
        tenant_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
      CREATE INDEX IF NOT EXISTS idx_dreaming_hash ON ai_dreaming_memory(content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_dreaming_memory_vec USING vec0(embedding float[1024]);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        tier TEXT DEFAULT 'free'
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT UNIQUE,
        name TEXT,
        role TEXT DEFAULT 'user',
        tier TEXT DEFAULT 'free',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT,
        name TEXT,
        key TEXT NOT NULL UNIQUE,
        key_hash TEXT,
        tier TEXT DEFAULT 'free',
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );

      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
    `);
    this.db.exec(`
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
        embedding BLOB,
        status TEXT DEFAULT 'active',
        source_type TEXT,
        source_id TEXT,
        dependencies TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        tenant_id TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS codeatlas_genome_vec USING vec0(embedding float[1024]);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_semantic_memory (
        id TEXT PRIMARY KEY,
        project_name TEXT,
        entity_type TEXT,
        entity_name TEXT,
        file_path TEXT,
        content TEXT,
        embedding BLOB,
        tenant_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_tenant_project ON ai_semantic_memory(tenant_id, project_name);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_relational_memory (
        source_id TEXT,
        target_id TEXT,
        project_name TEXT,
        relationship_type TEXT,
        tenant_id TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, project_name, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_tenant_project ON ai_relational_memory(tenant_id, project_name);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_episodic_memory (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        event_data TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        tenant_id TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codeatlas_concepts (
        id TEXT PRIMARY KEY,
        label TEXT,
        description TEXT,
        category TEXT,
        embedding BLOB,
        project TEXT,
        confidence REAL DEFAULT 0.5,
        source_ids TEXT,
        evidence_count INTEGER DEFAULT 1,
        access_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_accessed_at TEXT,
        tenant_id TEXT NOT NULL
      );
    `);
    logger.info("[SQLiteAdapter] Schema initialized.");
  }

  async checkColumnExists(table: string, column: string): Promise<boolean> {
    if (!this.db) await this.connect();
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some(r => r.name === column);
  }

  async detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    if (!this.db) await this.connect();
    // Recursive CTE replacement for Oracle GRAPH_TABLE cycle query (depth-bounded to 5)
    const sql = `
      WITH RECURSIVE dependency_chain AS (
        SELECT source_id, target_id, 1 AS depth
        FROM ai_relational_memory
        WHERE project_name = ? AND tenant_id = ?
        UNION ALL
        SELECT r.source_id, r.target_id, dc.depth + 1
        FROM ai_relational_memory r
        JOIN dependency_chain dc ON r.source_id = dc.target_id
        WHERE dc.depth < 5 AND r.project_name = ? AND r.tenant_id = ?
      )
      SELECT DISTINCT s.entity_name, s.file_path
      FROM dependency_chain dc
      JOIN ai_semantic_memory s ON dc.source_id = s.id
      WHERE dc.source_id = dc.target_id
    `;
    return this.query(sql, [project, tenantId, project, tenantId]);
  }

  async detectGodObjects(project: string, tenantId: string): Promise<Array<{ entity_name: string; in_degree: number }>> {
    if (!this.db) await this.connect();
    const sql = `
      SELECT s.entity_name, s.entity_type, s.file_path, r.in_degree
      FROM (
        SELECT target_id, count(*) AS in_degree
        FROM ai_relational_memory
        WHERE project_name = ? AND tenant_id = ?
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
    if (!this.db) await this.connect();
    const sql = `
      SELECT s.entity_name, s.file_path
      FROM ai_semantic_memory s
      WHERE s.project_name = ? AND s.tenant_id = ?
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
