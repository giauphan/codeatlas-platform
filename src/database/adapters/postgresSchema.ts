export interface PgPoolSchemaClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  release(): void;
}

export interface PgPoolSchemaExecutor {
  connect(): Promise<PgPoolSchemaClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Upgrade the two durable-memory uniqueness indexes only when their
 * definition differs. Rebuilding them on every process start blocks saves. */
export async function ensureDreamMemoryUniqueIndexes(pool: PgPoolSchemaExecutor): Promise<void> {
  const result = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'ai_dreaming_memory'
       AND indexname IN ('ux_dreaming_dedup', 'ux_dreaming_idempotency', 'ux_dreaming_project_id_hash')`,
  );
  const definitions = new Map(
    (result.rows as Array<{ indexname: string; indexdef: string }>).map((row) => [
      row.indexname,
      row.indexdef.replace(/\s+/g, "").toLowerCase(),
    ]),
  );
  const isExpected = (name: string, fragments: string[]): boolean => {
    const definition = definitions.get(name);
    return !!definition && fragments.every((fragment) => definition.includes(fragment));
  };
  const targets = [
    {
      name: "ux_dreaming_dedup",
      fragments: [
        "uniqueindexux_dreaming_dedup",
        "tenant_id,coalesce(project_id,project),memory_type,content_hash",
        "where(content_hashisnotnull)",
      ],
      sql: `CREATE UNIQUE INDEX ux_dreaming_dedup
        ON ai_dreaming_memory(tenant_id, COALESCE(project_id, project), memory_type, content_hash)
        WHERE content_hash IS NOT NULL`,
    },
    {
      name: "ux_dreaming_idempotency",
      fragments: [
        "uniqueindexux_dreaming_idempotency",
        "tenant_id,coalesce(project_id,project),idempotency_key",
        "where(idempotency_keyisnotnull)",
      ],
      sql: `CREATE UNIQUE INDEX ux_dreaming_idempotency
        ON ai_dreaming_memory(tenant_id, COALESCE(project_id, project), idempotency_key)
        WHERE idempotency_key IS NOT NULL`,
    },
  ];
  for (const target of targets) {
    if (isExpected(target.name, target.fragments)) continue;
    await pool.query(`DROP INDEX IF EXISTS ${target.name}`); // NOSONAR
    await pool.query(target.sql); // NOSONAR
  }
  if (definitions.has("ux_dreaming_project_id_hash")) {
    await pool.query("DROP INDEX IF EXISTS ux_dreaming_project_id_hash");
  }
}

export async function initializePostgresSchema(
  pool: PgPoolSchemaExecutor,
  checkColumnExists: (table: string, column: string) => Promise<boolean>,
): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_dreaming_memory (
      id VARCHAR(255) PRIMARY KEY,
      session_id VARCHAR(255),
      project VARCHAR(255),
      project_id VARCHAR(512),
      provider VARCHAR(255),
      memory_type VARCHAR(255),
      content TEXT,
      content_hash VARCHAR(255),
      idempotency_key VARCHAR(255),
      request_hash VARCHAR(255),
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
      evidence_count INT DEFAULT 0,
      version INT DEFAULT 1,
      related_ids TEXT,
      tenant_id VARCHAR(255) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dreaming_tenant_project ON ai_dreaming_memory(tenant_id, project);
    CREATE INDEX IF NOT EXISTS idx_dreaming_embedding ON ai_dreaming_memory USING ivfflat (embedding vector_cosine_ops);
  `);
  await pool.query(`
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS request_hash VARCHAR(255);
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS project_id VARCHAR(512);
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS evidence_count INT DEFAULT 0;
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;
    ALTER TABLE ai_dreaming_memory ADD COLUMN IF NOT EXISTS related_ids TEXT;
    ALTER TABLE ai_dreaming_memory DROP CONSTRAINT IF EXISTS ai_dreaming_memory_project_memory_type_content_hash_tenant_id_key;
  `);
  await ensureDreamMemoryUniqueIndexes(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dream_project_aliases (
      tenant_id VARCHAR(255) NOT NULL,
      alias TEXT NOT NULL,
      project_id VARCHAR(512) NOT NULL,
      display_name VARCHAR(512),
      workspace_path TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_project_alias_identity
      ON dream_project_aliases(tenant_id, project_id, alias);
    CREATE TABLE IF NOT EXISTS dream_project_alias_audit (
      id BIGSERIAL PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL,
      alias TEXT NOT NULL,
      requested_project_id VARCHAR(512) NOT NULL,
      existing_project_id VARCHAR(512) NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    DELETE FROM dream_project_alias_audit duplicate
     USING dream_project_alias_audit retained
     WHERE duplicate.id > retained.id
       AND duplicate.tenant_id = retained.tenant_id
       AND duplicate.alias = retained.alias
       AND duplicate.requested_project_id = retained.requested_project_id
       AND duplicate.existing_project_id = retained.existing_project_id;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_dream_project_alias_audit_collision
      ON dream_project_alias_audit(tenant_id, alias, requested_project_id, existing_project_id);
  `);
  await pool.query(`
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
      tenant_id VARCHAR(255) NOT NULL,
      project_id VARCHAR(512) NOT NULL,
      project VARCHAR(255) NOT NULL,
      display_name VARCHAR(512),
      workspace_path TEXT,
      event_id VARCHAR(255) NOT NULL,
      session_id VARCHAR(255) NOT NULL,
      actor_role VARCHAR(16),
      memory_type_hint VARCHAR(32),
      tool_name VARCHAR(128),
      request_hash VARCHAR(64) NOT NULL,
      content_redacted TEXT NOT NULL,
      checkpoint_json TEXT,
      occurred_at TEXT,
      source_spans_json TEXT,
      memory_ids_json TEXT NOT NULL DEFAULT '[]',
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      acknowledged_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      capture_sequence BIGINT,
      PRIMARY KEY (tenant_id, project_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_capture_pending
      ON dream_capture_events(tenant_id, project_id, status, created_at, event_id);
  `);
  const captureMigration = await pool.connect();
  try {
    await captureMigration.query("BEGIN");
    await captureMigration.query(`
    LOCK TABLE dream_capture_events IN ACCESS EXCLUSIVE MODE;
    CREATE SEQUENCE IF NOT EXISTS dream_capture_sequence_seq;
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS capture_sequence BIGINT;
    WITH ordered AS MATERIALIZED (
      SELECT ctid,
        COALESCE((SELECT MAX(capture_sequence) FROM dream_capture_events), 0) +
          row_number() OVER (ORDER BY created_at, event_id) AS seq
      FROM dream_capture_events WHERE capture_sequence IS NULL
    )
    UPDATE dream_capture_events AS events SET capture_sequence = ordered.seq
    FROM ordered WHERE events.ctid = ordered.ctid;
    SELECT setval(
      'dream_capture_sequence_seq',
      GREATEST((SELECT last_value FROM dream_capture_sequence_seq), COALESCE((SELECT MAX(capture_sequence) FROM dream_capture_events), 0), 1),
      EXISTS (SELECT 1 FROM dream_capture_events)
    );
    ALTER TABLE dream_capture_events ALTER COLUMN capture_sequence SET DEFAULT nextval('dream_capture_sequence_seq');
    ALTER TABLE dream_capture_events ALTER COLUMN capture_sequence SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dream_capture_session_sequence
      ON dream_capture_events(tenant_id, project_id, session_id, capture_sequence);
  `);
    await captureMigration.query("COMMIT");
  } catch (error) {
    await captureMigration.query("ROLLBACK");
    throw error;
  } finally {
    captureMigration.release();
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dream_job_runs (
      job_key VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      job_type VARCHAR(32) NOT NULL,
      tenant_id VARCHAR(255) NOT NULL,
      project VARCHAR(512) NOT NULL DEFAULT '',
      scheduled_for_utc TIMESTAMP WITH TIME ZONE NOT NULL,
      timezone VARCHAR(128) NOT NULL,
      state VARCHAR(32) NOT NULL,
      owner_id VARCHAR(255),
      owner_token VARCHAR(64),
      fencing_token BIGINT NOT NULL DEFAULT 0,
      lease_until TIMESTAMP WITH TIME ZONE,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMP WITH TIME ZONE,
      operation_stats TEXT,
      error_reason TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
      started_at TIMESTAMP WITH TIME ZONE,
      finished_at TIMESTAMP WITH TIME ZONE,
      UNIQUE (job_type, tenant_id, project, scheduled_for_utc)
    );
    CREATE INDEX IF NOT EXISTS idx_dream_job_runs_retry
      ON dream_job_runs(state, next_attempt_at, lease_until);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dream_save_receipts (
      tenant_id VARCHAR(255) NOT NULL,
      project VARCHAR(255) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      request_hash VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      memory_id VARCHAR(255),
      acknowledged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, project, idempotency_key)
    );
  `);
  await pool.query(`
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS actor_role VARCHAR(16);
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS memory_type_hint VARCHAR(32);
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS tool_name VARCHAR(128);
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS display_name VARCHAR(512);
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS workspace_path TEXT;
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS memory_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE dream_capture_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE;
  `);
  await pool.query(`
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
      key_hash VARCHAR(255) NOT NULL UNIQUE,
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

    CREATE TABLE IF NOT EXISTS activity_log (
      id VARCHAR(255) PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL,
      key_id VARCHAR(255),
      tool VARCHAR(255) NOT NULL,
      params TEXT,
      success BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_keys_tenant ON keys(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id, created_at);
  `);

  const hasKeyCol = await checkColumnExists("keys", "key");
  const hasKeyHashCol = await checkColumnExists("keys", "key_hash");
  if (!hasKeyHashCol) {
    await pool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(255);`);
  }
  await pool.query(`DELETE FROM keys WHERE key_hash IS NULL;`);
  await pool.query(`ALTER TABLE keys ALTER COLUMN key_hash SET NOT NULL;`);
  if (hasKeyCol) {
    await pool.query(`ALTER TABLE keys DROP COLUMN IF EXISTS key;`);
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_key_hash ON keys(key_hash);`);

  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_genome_tenant_category ON codeatlas_genome(tenant_id, category);
    CREATE INDEX IF NOT EXISTS idx_genome_tenant_proj_cat ON codeatlas_genome(tenant_id, project, category);
    CREATE INDEX IF NOT EXISTS idx_genome_embedding ON codeatlas_genome USING ivfflat (embedding vector_cosine_ops);
  `);
  await pool.query(`
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
  await pool.query(`
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_episodic_memory (
      id VARCHAR(255) PRIMARY KEY,
      event_type VARCHAR(255),
      event_data TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      tenant_id VARCHAR(255) NOT NULL
    );
  `);
  await pool.query(`
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
    ALTER TABLE codeatlas_concepts ADD COLUMN IF NOT EXISTS project_id VARCHAR(512);
  `);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS codeatlas_wiki_pages (
      id VARCHAR(255) PRIMARY KEY,
      project_name VARCHAR(255) NOT NULL,
      path VARCHAR(500) NOT NULL,
      title VARCHAR(255),
      summary TEXT,
      content TEXT,
      diagram_data TEXT,
      parent_path VARCHAR(500),
      order_index INTEGER,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      tenant_id VARCHAR(255),
      UNIQUE (project_name, path, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_project_tenant ON codeatlas_wiki_pages(project_name, tenant_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_path ON codeatlas_wiki_pages(path);`,
  );
}
