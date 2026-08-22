import { createDatabaseAdapter } from "./factory.js";
import type { IDatabaseAdapter } from "./adapters/interface.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

// Database adapter singleton
let adapter: IDatabaseAdapter | null = null;

/**
 * Returns the current database adapter (may be null if not yet initialized).
 */
export function getAdapter(): IDatabaseAdapter | null {
  return adapter;
}

/**
 * Initializes the database adapter based on CODEATLAS_DB_TYPE environment variable.
 * Defaults to SQLite.
 */
export async function initAdapter(): Promise<IDatabaseAdapter> {
  if (!adapter) {
    try {
      adapter = createDatabaseAdapter();
      await adapter.connect();
      logger.info(`Database adapter initialized (${process.env.CODEATLAS_DB_TYPE || "sqlite"})`);
    } catch (err: unknown) {
      logger.error("Failed to initialize database adapter:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  return adapter;
}

/**
 * Connection-like façade over IDatabaseAdapter.
 * The Second Brain services were written against the oracledb Connection API;
 * this keeps them working on any adapter without a rewrite of every call site.
 */
export interface AdapterConnection {
  execute<T = unknown>(
    sql: string,
    binds?: Record<string, unknown> | unknown[],
    opts?: Record<string, unknown>
  ): Promise<{ rows: T[]; rowsAffected: number }>;
  executeMany(
    sql: string,
    binds: Array<Record<string, unknown>>,
    opts?: Record<string, unknown>
  ): Promise<{ rowsAffected: number; batchErrors?: Array<{ message: string }> }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

const READ_QUERY = /^\s*(?:WITH|SELECT)\b/i;

function wrapAdapter(db: IDatabaseAdapter): AdapterConnection {
  return {
    async execute<T = unknown>(sql: string, binds = {}, _opts = {}) {
      if (READ_QUERY.test(sql)) {
        const rows = await db.query<T>(sql, binds);
        return { rows, rowsAffected: rows.length };
      }
      const res = await db.execute(sql, binds);
      return { rows: [] as T[], rowsAffected: res.rowsAffected };
    },
    async executeMany(sql: string, binds: Array<Record<string, unknown>>, _opts = {}) {
      const res = await db.executeMany(sql, binds);
      return { rowsAffected: res.rowsAffected };
    },
    async commit() {
      // Adapters auto-commit each statement.
    },
    async rollback() {
      // Adapters auto-commit each statement; no transaction to unwind.
    },
    async close() {
      // The adapter owns the underlying pool/handle.
    },
  };
}

/**
 * Backwards-compatible pool accessor for services written against oracledb.
 * Returns a pool-like object whose getConnection() yields an adapter-backed façade.
 */
export async function initPool(): Promise<{ getConnection: () => Promise<AdapterConnection> }> {
  const db = await initAdapter();
  return { getConnection: async () => wrapAdapter(db) };
}

/**
 * Configures the Session Context for Row-Level Security.
 * Oracle applies VPD via a package call; SQLite/Postgres enforce tenant
 * isolation through explicit tenant_id predicates, so this only validates auth.
 */
export async function setSessionContext(connection?: unknown): Promise<void> {
  const auth = authStorage.getStore();
  if (!auth) {
    throw new Error("Auth context required — call within authStorage.run()");
  }

  if ((process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase() === "oracle" && connection) {
    await (connection as AdapterConnection).execute(
      `BEGIN ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId); END;`,
      { tenantId: auth.uid }
    );
  }
}

/**
 * Health check ping to keep the database active.
 */
export async function ping(): Promise<void> {
  try {
    const db = await initAdapter();
    const result = await db.query("SELECT 1 AS ping_result");
    logger.info("[Database] Keep-alive ping executed successfully:", result);
  } catch (err) {
    logger.error("[Database] Keep-alive ping failed:", err instanceof Error ? err.message : String(err));
  }
}
