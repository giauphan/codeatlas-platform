// src/database/adapters/sqliteAdapter.ts
import { IDatabaseAdapter, VectorSearchResult } from "./interface.js";
import { authStorage } from "../../utils/context.js";
import { logger } from "../../utils/logger.js";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): unknown;
  exec(sql: string): void;
  close(): void;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

type DatabaseConstructor = new (filename: string) => SqliteDatabase;
type SqliteVecLoad = (db: unknown) => void;

type SqliteParams = Record<string, unknown> | unknown[];

const NAMED_PLACEHOLDER = /[:@$][a-zA-Z_][a-zA-Z0-9_]*/;

function bindArgs(sql: string, params: SqliteParams): unknown[] {
  if (Array.isArray(params)) return params;
  return NAMED_PLACEHOLDER.test(sql) ? [params] : Object.values(params);
}

let DatabaseClass: DatabaseConstructor | undefined;
let sqliteVecLoad: SqliteVecLoad | undefined;

export class SQLiteAdapter implements IDatabaseAdapter {
  private db: SqliteDatabase | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = process.env.CODEATLAS_SQLITE_PATH || "./data/codeatlas.db";
  }

  async connect(): Promise<void> {
    if (this.db) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        if (!DatabaseClass) {
          const DatabaseModule = await import("better-sqlite3");
          DatabaseClass = DatabaseModule.default as unknown as DatabaseConstructor;
        }
        if (!sqliteVecLoad) {
          const sqliteVecModule = await import("sqlite-vec");
          sqliteVecLoad = (sqliteVecModule as unknown as { load: SqliteVecLoad }).load;
        }
      } catch (err) {
        this.connectPromise = null;
        throw new Error(
          "SQLite adapter requires 'better-sqlite3' and 'sqlite-vec'. Install: pnpm add better-sqlite3 sqlite-vec @types/better-sqlite3"
        );
      }

      // Ensure directory exists
      const path = await import("path");
      const fs = await import("fs");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new DatabaseClass(this.dbPath);
      if (sqliteVecLoad) {
        sqliteVecLoad(this.db);
      }

      // WAL mode & busy timeout for performance & high concurrency
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");

      logger.info(`[SQLiteAdapter] Connected to SQLite database at ${this.dbPath}`);
    })();

    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logger.error("Error closing SQLite connection:", err instanceof Error ? err.message : String(err));
      } finally {
        this.db = null;
        this.connectPromise = null;
      }
    }
  }

  async getConnection(): Promise<unknown> {
    if (!this.db) await this.connect();
    return this.db;
  }

  async query<T>(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<T[]> {
    if (!this.db) await this.connect();
    const stmt = this.db!.prepare(sql);
    return stmt.all(...bindArgs(sql, params)) as T[];
  }

  async execute(sql: string, params: Record<string, unknown> | unknown[] = {}): Promise<{ rowsAffected: number }> {
    if (!this.db) await this.connect();
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(...bindArgs(sql, params));
    return { rowsAffected: result.changes };
  }

  async executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }> {
    if (!this.db) await this.connect();
    const stmt = this.db!.prepare(sql);
    let totalChanges = 0;
    const transaction = this.db!.transaction((rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        const result = stmt.run(...bindArgs(sql, row));
        totalChanges += result.changes;
      }
    });
    transaction(params);
    return { rowsAffected: totalChanges };
  }

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string): Promise<VectorSearchResult[]> {
    if (!this.db) await this.connect();
    const blob = new Uint8Array(new Float32Array(embedding).buffer);

    // sqlite-vec cosine distance function
    const sql = `
      SELECT id, 1 - vec_distance_cosine(embedding, ?) AS score
      FROM ${table}
      WHERE tenant_id = ? AND embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC
      LIMIT ?
    `;

    return this.query<VectorSearchResult>(sql, [blob, tenantId, blob, limit]);
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) await this.connect();

    this.db!.exec(`
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
        evidence_count INTEGER DEFAULT 0,
        version INTEGER DEFAULT 1,
        related_ids TEXT,
        tenant_id TEXT NOT NULL,
        UNIQUE (project, memory_type, content_hash, tenant_id)
      );
      DELETE FROM ai_dreaming_memory
      WHERE content_hash IS NOT NULL
        AND rowid NOT IN (
          SELECT MAX(rowid)
          FROM ai_dreaming_memory
          WHERE content_hash IS NOT NULL
          GROUP BY project, memory_type, content_hash, tenant_id
        );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_dreaming_dedup
        ON ai_dreaming_memory(project, memory_type, content_hash, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
      CREATE INDEX IF NOT EXISTS idx_dreaming_hash ON ai_dreaming_memory(content_hash);

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
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        email TEXT UNIQUE,
        name TEXT,
        role TEXT DEFAULT 'user',
        tier TEXT DEFAULT 'free',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        user_id TEXT REFERENCES users(id),
        name TEXT,
        key TEXT NOT NULL UNIQUE,
        key_hash TEXT,
        tier TEXT DEFAULT 'free',
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);

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
      CREATE INDEX IF NOT EXISTS idx_genome_tenant_project ON codeatlas_genome(tenant_id, project);

      CREATE TABLE IF NOT EXISTS gene_mutations (
        id TEXT PRIMARY KEY,
        gene_id TEXT REFERENCES codeatlas_genome(id),
        previous_version INTEGER,
        new_version INTEGER,
        change_reason TEXT,
        diff_summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS gene_relationships (
        source_id TEXT REFERENCES codeatlas_genome(id),
        target_id TEXT REFERENCES codeatlas_genome(id),
        relationship_type TEXT,
        weight REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id, relationship_type)
      );

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

      CREATE TABLE IF NOT EXISTS ai_relational_memory (
        source_id TEXT,
        target_id TEXT,
        project_name TEXT,
        relationship_type TEXT,
        tenant_id TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, project_name, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_tenant_project ON ai_relational_memory(tenant_id, project_name);

      CREATE TABLE IF NOT EXISTS ai_episodic_memory (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        event_type TEXT,
        event_data TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        tenant_id TEXT NOT NULL
      );

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

    const addColumnIfMissing = (table: string, column: string, definition: string): void => {
      const columns = this.db!.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!columns.some((entry) => entry.name === column)) {
        this.db!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    addColumnIfMissing("ai_episodic_memory", "project_name", "TEXT");
    addColumnIfMissing("ai_dreaming_memory", "evidence_count", "INTEGER DEFAULT 0");
    addColumnIfMissing("ai_dreaming_memory", "version", "INTEGER DEFAULT 1");
    addColumnIfMissing("ai_dreaming_memory", "related_ids", "TEXT");
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_episodic_tenant_project ON ai_episodic_memory(tenant_id, project_name)");

    logger.info("[SQLiteAdapter] Schema initialized.");
  }

  async checkColumnExists(table: string, column: string): Promise<boolean> {
    if (!this.db) await this.connect();
    const info = this.db!.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return info.some((c) => c.name === column);
  }

  async detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>> {
    if (!this.db) await this.connect();
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
      SELECT s.entity_name, r.in_degree
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
