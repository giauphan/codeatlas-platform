import oracledb from "oracledb";
import * as path from "node:path";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

// Connection pool singleton
let pool: oracledb.Pool | null = null;

const getDbConfig = () => {
  const user = process.env.ORACLE_USER || "ADMIN";
  const password = process.env.ORACLE_PASSWORD;
  const connectString = process.env.ORACLE_CONN_STRING;
  if (!password) throw new Error("ORACLE_PASSWORD environment variable is required");
  if (!connectString) throw new Error("ORACLE_CONN_STRING environment variable is required");
  return { user, password, connectString };
};

/**
 * Returns the current connection pool (may be null if not yet initialized).
 */
export function getPool(): oracledb.Pool | null {
  return pool;
}

/**
 * Initializes the Connection Pool (reuses existing pool if already created).
 */
export async function initPool(): Promise<oracledb.Pool> {
  if (!pool) {
    try {
      // Activate Thick Mode — needed for TCPS (mTLS) wallet connections.
      // Triggered by either ORACLE_LIB_DIR (explicit lib path) or ORACLE_WALLET_DIR (wallet config).
      const walletDir = process.env.ORACLE_WALLET_DIR;
      const libDir = process.env.ORACLE_LIB_DIR;
      if (libDir || walletDir) {
        logger.info("🚀 Initializing Oracle Client in Thick Mode...");
        try {
          const initOptions: oracledb.InitialiseOptions = {};
          if (walletDir) {
            // Resolve relative to project root
            initOptions.configDir = path.resolve(walletDir);
          }
          // On Linux, cannot pass libDir to initOracleClient (causes DPI-1047).
          // Must use LD_LIBRARY_PATH or ldconfig instead.
          if (process.platform !== "linux" && libDir) {
            initOptions.libDir = libDir;
          }
          oracledb.initOracleClient(initOptions);
        } catch (initErr: unknown) {
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          if (msg.includes("already initialized")) {
            logger.info("ℹ️ Oracle Client is already initialized.");
          } else {
            logger.warn("⚠️ Warning initializing Oracle Client in Thick Mode:", msg);
          }
        }
      }

      // Configure standard data formats for Oracle 26ai
      oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
      oracledb.fetchAsString = [oracledb.CLOB];

      pool = await oracledb.createPool({
        ...getDbConfig(),
        poolMin: 0,
        poolMax: 3,
        poolIncrement: 1,
        queueTimeout: 300000,
      });

      logger.info("✅ Oracle 26ai DB Pool initialized successfully (Thick Mode)");
    } catch (err: unknown) {
      logger.error("❌ Failed to initialize Oracle DB pool:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  return pool;
}

/**
 * Configures the Session Context for Row-Level Security (Oracle Virtual Private Database)
 */
export async function setSessionContext(connection: oracledb.Connection, overrideTenantId?: string) {
  const auth = authStorage.getStore();
  const tenantId = overrideTenantId || (auth ? auth.uid : "admin");

  try {
    // Invoke the context package to dynamically apply Row-Level Security row-filtering policies
    const sql = `BEGIN ADMIN.codeatlas_ctx_pkg.set_tenant(:tenantId); END;`;
    await connection.execute(sql, { tenantId });
    logger.info(`[Oracle RLS] Security Context set for tenant: ${tenantId}`);
  } catch (err: unknown) {
    logger.error("[Oracle RLS] Failed to set security context:", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Health check ping to keep the Always Free Oracle Database active (prevents auto-stopping due to 7 days idle)
 */
export async function ping() {
  let connection;
  try {
    const p = await initPool();
    connection = await p.getConnection();
    const result = await connection.execute("SELECT 1 FROM DUAL");
    logger.info("[Oracle DB] Keep-alive ping executed successfully:", result.rows);
  } catch (err) {
    logger.error("[Oracle DB] Keep-alive ping failed:", err instanceof Error ? err.message : String(err));
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        logger.error("[Oracle DB] Keep-alive ping connection close error:", closeErr);
      }
    }
  }
}

export { getDbConfig };
