import "dotenv/config";
import oracledb from "oracledb";
import { SQLiteAdapter } from "../src/database/adapters/sqliteAdapter.js";
import type { IDatabaseAdapter } from "../src/database/adapters/interface.js";

oracledb.fetchAsString = [oracledb.CLOB];

const TABLES = [
  {
    name: "tenants",
    columns: ["id", "name", "description", "created_at", "updated_at", "tier"],
    conflict: "id",
  },
  {
    name: "users",
    columns: ["id", "tenant_id", "email", "name", "role", "tier", "created_at", "updated_at"],
    conflict: "id",
  },
  {
    name: "keys",
    columns: ["id", "tenant_id", "user_id", "name", "key", "key_hash", "tier", "expires_at", "created_at", "updated_at"],
    conflict: "id",
  },
  {
    name: "projects",
    columns: ["id", "tenant_id", "name", "description", "created_at", "updated_at"],
    conflict: "id",
  },
  {
    name: "ai_episodic_memory",
    columns: ["id", "project_name", "event_type", "event_data", "created_at", "tenant_id"],
    conflict: "id",
  },
  {
    name: "ai_semantic_memory",
    columns: ["id", "project_name", "entity_type", "entity_name", "file_path", "content", "embedding", "tenant_id"],
    conflict: "id",
  },
  {
    name: "ai_relational_memory",
    columns: ["source_id", "target_id", "project_name", "relationship_type", "tenant_id"],
    conflict: "source_id,target_id,project_name,tenant_id",
  },
  {
    name: "ai_dreaming_memory",
    columns: [
      "id", "session_id", "project", "provider", "memory_type", "content", "content_hash", "importance",
      "confidence", "embedding", "status", "scope", "tags", "lifecycle_stage", "created_at", "updated_at",
      "last_accessed_at", "access_count", "evidence_count", "version", "related_ids", "tenant_id",
    ],
    conflict: "id",
  },
  {
    name: "codeatlas_genome",
    columns: [
      "id", "name", "description", "problem", "solution", "architecture", "category", "project", "confidence",
      "version", "evolution_score", "usage_count", "success_rate", "embedding", "status", "source_type", "source_id",
      "dependencies", "created_at", "updated_at", "tenant_id",
    ],
    conflict: "id",
  },
  {
    name: "codeatlas_concepts",
    columns: [
      "id", "label", "description", "category", "embedding", "project", "confidence", "source_ids",
      "evidence_count", "access_count", "status", "created_at", "updated_at", "last_accessed_at", "tenant_id",
    ],
    conflict: "id",
  },
  {
    name: "gene_mutations",
    columns: ["id", "gene_id", "previous_version", "new_version", "change_reason", "diff_summary", "created_at"],
    conflict: "id",
  },
  {
    name: "gene_relationships",
    columns: ["source_id", "target_id", "relationship_type", "weight", "created_at"],
    conflict: "source_id,target_id,relationship_type",
  },
] as const;

type TableSpec = (typeof TABLES)[number];
type OracleRow = Record<string, unknown>;

async function getOracleColumns(connection: oracledb.Connection, tableName: string): Promise<Set<string>> {
  const result = await connection.execute<OracleRow>(
    `SELECT column_name FROM user_tab_columns WHERE table_name = :tableName`,
    { tableName: tableName.toUpperCase() },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return new Set((result.rows ?? []).map((row) => String(row.COLUMN_NAME).toLowerCase()));
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const values = Array.from(value as ArrayLike<number>, Number);
    return Buffer.from(new Float32Array(values).buffer);
  }
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_]+$/i.test(identifier)) throw new Error(`Invalid identifier: ${identifier}`);
  return `"${identifier.toUpperCase()}"`;
}

async function migrateTable(connection: oracledb.Connection, sqlite: IDatabaseAdapter, spec: TableSpec): Promise<number> {
  const oracleColumns = await getOracleColumns(connection, spec.name);
  if (oracleColumns.size === 0) return 0;

  const selectedColumns = spec.columns.filter((column) => oracleColumns.has(column));
  const columns = selectedColumns.map(quoteIdentifier).join(", ");
  const result = await connection.execute<OracleRow>(
    `SELECT ${columns} FROM ${quoteIdentifier(spec.name)}`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = (result.rows ?? []) as OracleRow[];
  if (rows.length === 0) return 0;

  const placeholders = selectedColumns.map(() => "?").join(", ");
  const conflictColumns = spec.conflict.split(",");
  const updates = selectedColumns
    .filter((column) => !conflictColumns.includes(column))
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
    .join(", ");
  const conflictSql = conflictColumns.map(quoteIdentifier).join(", ");
  const action = updates ? `DO UPDATE SET ${updates}` : "DO NOTHING";
  const sql = `INSERT INTO ${quoteIdentifier(spec.name)} (${columns}) VALUES (${placeholders}) ON CONFLICT (${conflictSql}) ${action}`;

  for (const row of rows) {
    await sqlite.execute(sql, selectedColumns.map((column) => normalizeValue(row[column.toUpperCase()])));
  }
  return rows.length;
}

async function main(): Promise<void> {
  const oracle = await oracledb.getConnection({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectionString: process.env.ORACLE_CONN_STRING,
  });
  const sqlite = new SQLiteAdapter();
  await sqlite.connect();
  await sqlite.initializeSchema();

  try {
    let total = 0;
    for (const table of TABLES) {
      try {
        const count = await migrateTable(oracle, sqlite, table);
        total += count;
        console.log(`[Oracle → SQLite] ${table.name}: ${count} rows`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ORA-00942|no such table/i.test(message)) {
          console.warn(`[Oracle → SQLite] ${table.name}: skipped (table does not exist)`);
          continue;
        }
        throw error;
      }
    }
    console.log(`[Oracle → SQLite] complete: ${total} rows processed`);
  } finally {
    await oracle.close();
    await sqlite.disconnect();
  }
}

main().catch((error) => {
  console.error("[Oracle → SQLite] failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
