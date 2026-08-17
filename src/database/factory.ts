// src/database/factory.ts
import { IDatabaseAdapter } from "./adapters/interface.js";
import { OracleAdapter } from "./adapters/oracleAdapter.js";
import { SQLiteAdapter } from "./adapters/sqliteAdapter.js";
import { PostgresAdapter } from "./adapters/postgresAdapter.js";

export function createDatabaseAdapter(): IDatabaseAdapter {
  const dbType = process.env.CODEATLAS_DB_TYPE || "oracle";

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
