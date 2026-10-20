// src/database/adapters/sqliteAdapter.ts
import { IDatabaseAdapter, VectorSearchResult, WikiPageRecord } from "./interface.js";
import { authStorage } from "../../utils/context.js";
import { hashApiKey } from "../../utils/apiKey.js";
import { logger } from "../../utils/logger.js";
import * as path from "path";
import * as os from "os";

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

function sanitizeParam(val: unknown): unknown {
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  return val;
}

function bindArgs(sql: string, params: SqliteParams): unknown[] {
  if (Array.isArray(params)) return params.map(sanitizeParam);
  if (NAMED_PLACEHOLDER.test(sql)) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      obj[k] = sanitizeParam(v);
    }
    return [obj];
  }
  return Object.values(params).map(sanitizeParam);
}

let DatabaseClass: DatabaseConstructor | undefined;
let sqliteVecLoad: SqliteVecLoad | undefined;

export class SQLiteAdapter implements IDatabaseAdapter {
  private db: SqliteDatabase | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.CODEATLAS_SQLITE_PATH || path.join(os.homedir(), ".codeatlas", "codeatlas.db");
  }

  async initialize(): Promise<void> {
    await this.connect();
    await this.initializeSchema();
  }

  async close(): Promise<void> {
    await this.disconnect();
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

  async searchVector(table: string, embedding: number[], limit: number, tenantId: string, filterBinds?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    if (!this.db) await this.connect();
    const blob = new Uint8Array(new Float32Array(embedding).buffer);

    // sqlite-vec cosine distance function
    // Filter by blob length to skip rows embedded with a different model/dimension.
    // Each float32 = 4 bytes, so expected blob size = embedding.length * 4.
    const sql = `
      SELECT id, 1 - vec_distance_cosine(embedding, :queryVector) AS score
      FROM ${table}
      WHERE tenant_id = :tenantId AND embedding IS NOT NULL
        AND length(embedding) = :expectedBytes
      ORDER BY vec_distance_cosine(embedding, :queryVector) ASC
      LIMIT :limit
    `;

    const binds = { queryVector: blob, tenantId, limit, expectedBytes: embedding.length * 4, ...(filterBinds || {}) };
    return this.query<VectorSearchResult>(sql, binds);
  }

  async searchVectorScoped(table: string, embedding: number[], limit: number, tenantId: string, whereClause: string, filterBinds: Record<string, unknown> = {}): Promise<VectorSearchResult[]> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Invalid vector table name");
    if (!this.db) await this.connect();
    const blob = new Uint8Array(new Float32Array(embedding).buffer);
    const sql = `
      SELECT id, 1 - vec_distance_cosine(embedding, :dreamQueryVector) AS score
      FROM ${table}
      WHERE tenant_id = :dreamTenantId AND embedding IS NOT NULL
        AND length(embedding) = :dreamExpectedBytes
        AND (${whereClause})
      ORDER BY vec_distance_cosine(embedding, :dreamQueryVector) ASC
      LIMIT :dreamLimit
    `;
    return this.query<VectorSearchResult>(sql, {
      ...filterBinds,
      dreamQueryVector: blob,
      dreamTenantId: tenantId,
      dreamExpectedBytes: embedding.length * 4,
      dreamLimit: limit,
    });
  }

  /** SQLite cannot drop a table-level UNIQUE constraint. Rebuild only that
   * table, in one transaction, retaining every column, row, user index/trigger
   * and stable memory ID. Other memory tables and receipt references survive. */
  private migrateDreamIdentityConstraints(): void {
    const db = this.db!;
    const record = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_dreaming_memory'").all()[0] as { sql: string };
    const legacyConstraint = /,\s*UNIQUE\s*\(\s*project\s*,\s*memory_type\s*,\s*content_hash\s*,\s*tenant_id\s*\)/gi;
    const rebuiltDefinition = record.sql.replace(legacyConstraint, '');
    const foreignKeys = Number((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys || 0);
    if (foreignKeys) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if (rebuiltDefinition !== record.sql) {
          const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'ai_dreaming_memory' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
          const definition = rebuiltDefinition.replace(/^CREATE TABLE(?: IF NOT EXISTS)?\s+[\"`\[]?ai_dreaming_memory[\"`\]]?/i, 'CREATE TABLE ai_dreaming_memory_identity_new');
          if (definition === rebuiltDefinition) throw new Error('Unsupported memory identity migration schema');
          const columns = (db.pragma('table_info(ai_dreaming_memory)') as Array<{ name: string }>).map(column => '"' + column.name.replaceAll('"', '""') + '"').join(', ');
          db.exec(definition);
          db.exec(`INSERT INTO ai_dreaming_memory_identity_new (${columns}) SELECT ${columns} FROM ai_dreaming_memory`);
          db.exec('DROP TABLE ai_dreaming_memory');
          db.exec('ALTER TABLE ai_dreaming_memory_identity_new RENAME TO ai_dreaming_memory');
          for (const object of objects) {
            if (!['ux_dreaming_dedup', 'ux_dreaming_project_id_hash', 'ux_dreaming_idempotency'].includes(object.name)) db.exec(object.sql);
          }
        }
        db.exec(`DROP INDEX IF EXISTS ux_dreaming_dedup;
          DROP INDEX IF EXISTS ux_dreaming_project_id_hash;
          DROP INDEX IF EXISTS ux_dreaming_idempotency;
          CREATE UNIQUE INDEX ux_dreaming_dedup ON ai_dreaming_memory(tenant_id, COALESCE(project_id, project), memory_type, content_hash) WHERE content_hash IS NOT NULL;
          CREATE UNIQUE INDEX ux_dreaming_idempotency ON ai_dreaming_memory(tenant_id, COALESCE(project_id, project), idempotency_key) WHERE idempotency_key IS NOT NULL;`);
      })();
    } finally {
      if (foreignKeys) db.pragma('foreign_keys = ON');
    }
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) await this.connect();

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS ai_dreaming_memory (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project TEXT,
        project_id TEXT,
        provider TEXT,
        memory_type TEXT,
        content TEXT,
        content_hash TEXT,
        idempotency_key TEXT,
        request_hash TEXT,
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
        tenant_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
      CREATE INDEX IF NOT EXISTS idx_dreaming_hash ON ai_dreaming_memory(content_hash);
      CREATE TABLE IF NOT EXISTS dream_memory_provenance (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        certainty TEXT NOT NULL,
        base_confidence REAL NOT NULL,
        extractor_version TEXT NOT NULL,
        topic_key TEXT,
        occurred_at TEXT NOT NULL,
        superseded_by TEXT,
        PRIMARY KEY (tenant_id, project_id, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dream_provenance_topic ON dream_memory_provenance(tenant_id, project_id, topic_key, occurred_at);
      CREATE TABLE IF NOT EXISTS dream_memory_evidence (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        tool_name TEXT,
        span TEXT NOT NULL,
        source_spans_json TEXT,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, project_id, memory_id, source_event_id, evidence_hash)
      );
      CREATE TABLE IF NOT EXISTS dream_capture_events (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project TEXT NOT NULL,
        display_name TEXT,
        workspace_path TEXT,
        event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_role TEXT,
        memory_type_hint TEXT,
        tool_name TEXT,
        request_hash TEXT NOT NULL,
        content_redacted TEXT NOT NULL,
        checkpoint_json TEXT,
        occurred_at TEXT,
        source_spans_json TEXT,
        memory_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        acknowledged_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        capture_sequence INTEGER,
        PRIMARY KEY (tenant_id, project_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dream_capture_pending
        ON dream_capture_events(tenant_id, project_id, status, created_at, event_id);

      CREATE TABLE IF NOT EXISTS dream_job_runs (
        job_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        scheduled_for_utc TEXT NOT NULL,
        timezone TEXT NOT NULL,
        state TEXT NOT NULL,
        owner_id TEXT,
        owner_token TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT,
        operation_stats TEXT,
        error_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE (job_type, tenant_id, project, scheduled_for_utc)
      );
      CREATE INDEX IF NOT EXISTS idx_dream_job_runs_retry
        ON dream_job_runs(state, next_attempt_at, lease_until);

      CREATE TABLE IF NOT EXISTS dream_save_receipts (
        tenant_id TEXT NOT NULL,
        project TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        memory_id TEXT,
        acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, project, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS dream_project_aliases (
        tenant_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        project_id TEXT NOT NULL,
        display_name TEXT,
        workspace_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, alias)
      );
      CREATE INDEX IF NOT EXISTS idx_dream_project_alias_identity
        ON dream_project_aliases(tenant_id, project_id, alias);
      CREATE TABLE IF NOT EXISTS dream_project_alias_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        requested_project_id TEXT NOT NULL,
        existing_project_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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
        key_hash TEXT NOT NULL UNIQUE,
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

      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        key_id TEXT,
        tool TEXT NOT NULL,
        params TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id, created_at);

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
      CREATE INDEX IF NOT EXISTS idx_genome_tenant_category ON codeatlas_genome(tenant_id, category);
      CREATE INDEX IF NOT EXISTS idx_genome_tenant_proj_cat ON codeatlas_genome(tenant_id, project, category);

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

    addColumnIfMissing("ai_dreaming_memory", "idempotency_key", "TEXT");
    addColumnIfMissing("ai_dreaming_memory", "request_hash", "TEXT");
    addColumnIfMissing("ai_dreaming_memory", "project_id", "TEXT");
    addColumnIfMissing("codeatlas_concepts", "project_id", "TEXT");
    addColumnIfMissing("dream_capture_events", "actor_role", "TEXT");
    addColumnIfMissing("dream_capture_events", "memory_type_hint", "TEXT");
    addColumnIfMissing("dream_capture_events", "tool_name", "TEXT");
    addColumnIfMissing("dream_capture_events", "display_name", "TEXT");
    addColumnIfMissing("dream_capture_events", "workspace_path", "TEXT");
    addColumnIfMissing("dream_capture_events", "capture_sequence", "INTEGER");
    addColumnIfMissing("dream_capture_events", "memory_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing("dream_capture_events", "acknowledged_at", "TEXT");
    this.db!.exec(`
      UPDATE dream_capture_events SET capture_sequence = rowid WHERE capture_sequence IS NULL;
      CREATE TRIGGER IF NOT EXISTS dream_capture_assign_sequence
      AFTER INSERT ON dream_capture_events
      WHEN NEW.capture_sequence IS NULL
      BEGIN
        UPDATE dream_capture_events SET capture_sequence = NEW.rowid WHERE rowid = NEW.rowid;
      END;
      CREATE INDEX IF NOT EXISTS idx_dream_capture_session_sequence
        ON dream_capture_events(tenant_id, project_id, session_id, capture_sequence);
    `);
    this.migrateDreamIdentityConstraints();

    let keyColumns = this.db!.pragma("table_info(keys)") as Array<{ name: string }>;
    if (keyColumns.some((entry) => entry.name === "key")) {
      if (!keyColumns.some((entry) => entry.name === "key_hash")) {
        addColumnIfMissing("keys", "key_hash", "TEXT");
        const legacyKeys = this.db!.prepare("SELECT id, key FROM keys WHERE key_hash IS NULL").all() as Array<{ id: string; key: string }>;
        const updateKeyHash = this.db!.prepare("UPDATE keys SET key_hash = ? WHERE id = ?");
        for (const legacyKey of legacyKeys) {
          updateKeyHash.run(await hashApiKey(legacyKey.key), legacyKey.id);
        }
        keyColumns = this.db!.pragma("table_info(keys)") as Array<{ name: string }>;
      }

      const rebuildKeys = this.db!.transaction(() => {
        this.db!.exec("DROP TABLE IF EXISTS keys_new");
        this.db!.exec(`
          CREATE TABLE keys_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            user_id TEXT REFERENCES users(id),
            name TEXT,
            key_hash TEXT NOT NULL UNIQUE,
            tier TEXT DEFAULT 'free',
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        const cols = keyColumns.filter((c) => c.name !== "key").map((c) => c.name).join(", ");
        this.db!.exec(`INSERT INTO keys_new (${cols}) SELECT ${cols} FROM keys`);
        this.db!.exec("DROP TABLE keys");
        this.db!.exec("ALTER TABLE keys_new RENAME TO keys");
        this.db!.exec("CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id)");
      });
      rebuildKeys();
    }
    addColumnIfMissing("ai_episodic_memory", "project_name", "TEXT");
    addColumnIfMissing("ai_dreaming_memory", "evidence_count", "INTEGER DEFAULT 0");
    addColumnIfMissing("ai_dreaming_memory", "version", "INTEGER DEFAULT 1");
    addColumnIfMissing("ai_dreaming_memory", "related_ids", "TEXT");
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_episodic_tenant_project ON ai_episodic_memory(tenant_id, project_name)");

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS codeatlas_wiki_pages (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        content TEXT,
        diagram_data TEXT,
        parent_path TEXT,
        order_index INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        tenant_id TEXT,
        UNIQUE (project_name, path, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_project_tenant ON codeatlas_wiki_pages(project_name, tenant_id);
      CREATE INDEX IF NOT EXISTS idx_wiki_path ON codeatlas_wiki_pages(path);
    `);

    logger.info("[SQLiteAdapter] Schema initialized.");
  }

  async saveWikiPage(page: WikiPageRecord): Promise<void> {
    if (!this.db) await this.connect();
    const sql = `
      INSERT OR REPLACE INTO codeatlas_wiki_pages (
        id,
        project_name,
        path,
        title,
        summary,
        content,
        diagram_data,
        parent_path,
        order_index,
        updated_at,
        tenant_id
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        datetime('now'),
        ?
      )
    `;
    const params = [
      page.id,
      page.project_name,
      page.path,
      page.title,
      page.summary,
      page.content,
      page.diagram_data,
      page.parent_path,
      page.order_index,
      page.tenant_id
    ];
    await this.execute(sql, params);
  }

  async getWikiPage(projectName: string, path: string, tenantId?: string): Promise<WikiPageRecord | null> {
    if (!this.db) await this.connect();
    const sql = `
      SELECT * FROM codeatlas_wiki_pages
      WHERE project_name = ? AND path = ? AND tenant_id = ?
    `;
    const params = [projectName, path, tenantId || ''];
    const results = await this.query<WikiPageRecord>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  async listWikiPages(projectName: string, tenantId?: string): Promise<WikiPageRecord[]> {
    if (!this.db) await this.connect();
    const sql = `
      SELECT * FROM codeatlas_wiki_pages
      WHERE project_name = ? AND tenant_id = ?
      ORDER BY order_index ASC
    `;
    const params = [projectName, tenantId || ''];
    return this.query<WikiPageRecord>(sql, params);
  }

  async deleteWikiPages(projectName: string, tenantId?: string): Promise<void> {
    if (!this.db) await this.connect();
    const sql = `
      DELETE FROM codeatlas_wiki_pages
      WHERE project_name = ? AND tenant_id = ?
    `;
    const params = [projectName, tenantId || ''];
    await this.execute(sql, params);
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
