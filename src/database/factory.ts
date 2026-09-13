// src/database/factory.ts
import type { IDatabaseAdapter } from "./adapters/interface.js";
import { SQLiteAdapter } from "./adapters/sqliteAdapter.js";
import { PostgresAdapter } from "./adapters/postgresAdapter.js";

// Memoize adapter per application lifetime to prevent connection/pool exhaustion
let activeAdapter: IDatabaseAdapter | null = null;

/**
 * SQLite + sqlite-vec is the platform database. Postgres remains available as an
 * opt-in backend via CODEATLAS_DB_TYPE=postgres.
 */
export function createDatabaseAdapter(): IDatabaseAdapter {
  if (activeAdapter) return activeAdapter;
  const dbType = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
  activeAdapter = dbType === "postgres" ? new PostgresAdapter() : new SQLiteAdapter();
  return activeAdapter;
}

/**
 * Reset the active adapter instance in tests.
 */
export function setDatabaseAdapter(adapter: IDatabaseAdapter | null): void {
  activeAdapter = adapter;
}

/**
 * Resets the active adapter loop, useful for tests.
 */
export function resetDatabaseAdapter(): void {
  activeAdapter = null;
}
