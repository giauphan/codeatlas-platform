// Type declarations for optional SQLite/Postgres adapter dependencies.
// These modules are only required when CODEATLAS_DB_TYPE is set to "sqlite" or "postgres".

declare module "better-sqlite3" {
  interface Statement {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
  }
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string): unknown;
    transaction<T>(fn: () => T): T;
    loadExtension(path: string): void;
    close(): void;
  }
  const Database: {
    new (path: string): Database;
  };
  export default Database;
}

declare module "sqlite-vec" {
  const sqliteVec: (db: unknown) => void;
  export default sqliteVec;
}

declare module "pg" {
  interface QueryResult<T = unknown> {
    rows: T[];
    rowCount: number;
  }
  class Pool {
    constructor(config: unknown);
    query(sql: string, params?: unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
  }
  export { Pool };
}

declare module "pgvector" {
  export function toSql(vector: number[]): string;
}
