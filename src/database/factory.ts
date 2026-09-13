// src/database/factory.ts
import type { IDatabaseAdapter } from "./adapters/interface.js";
import { SQLiteAdapter } from "./adapters/sqliteAdapter.js";
import { PostgresAdapter } from "./adapters/postgresAdapter.js";

/**
 * SQLite + sqlite-vec is the platform database. Postgres remains available as an
 * opt-in backend via CODEATLAS_DB_TYPE=postgres.
 */
export function createDatabaseAdapter(): IDatabaseAdapter {
  const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
  return dbType === "postgres" ? new PostgresAdapter() : new SQLiteAdapter();
}
