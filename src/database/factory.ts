// src/database/factory.ts
import { IDatabaseAdapter } from "./adapters/interface.js";
import { OracleAdapter } from "./adapters/oracleAdapter.js";
import { SQLiteAdapter } from "./adapters/sqliteAdapter.js";
import { PostgresAdapter } from "./adapters/postgresAdapter.js";

export function getDbType(): string {
  return (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
}

export function getCurrentTimestampSql(): string {
  return getDbType() === "sqlite" ? "datetime('now')" : "CURRENT_TIMESTAMP";
}

export function createDatabaseAdapter(): IDatabaseAdapter {
  const dbType = getDbType();

  switch (dbType.toLowerCase()) {
    case "sqlite":
      return new SQLiteAdapter();
    case "postgres":
      return new PostgresAdapter();
    case "oracle":
    default:
      return new OracleAdapter();
  }
}
