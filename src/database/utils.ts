/**
 * Helper to build an IN clause with parameterized bindings.
 * Ensures protection against SQL injection.
 * @param ids Array of ID strings
 * @param baseBinds Base bind variables (e.g. project, tenantId)
 */
import { logger } from "../utils/logger.js";

export function buildInClause(ids: string[], baseBinds: Record<string, unknown> = {}): { clause: string; binds: Record<string, unknown> } {
  const binds = { ...baseBinds };
  if (ids.length === 0) {
    return { clause: "NULL", binds };
  }
  const clause = ids.map((_, i) => `:id${i}`).join(",");
  ids.forEach((id, i) => { binds[`id${i}`] = String(id); });
  return { clause, binds };
}

/**
 * Utility to batch executeMany calls to prevent memory consumption risks
 * during massive batch inserts.
 */
export async function batchExecuteMany(
  db: { executeMany: (sql: string, params: Array<Record<string, unknown>>) => Promise<{ rowsAffected: number }> },
  sql: string,
  rows: Array<Record<string, unknown>>,
  chunkSize?: number
): Promise<void> {
  const defaultSize = Number(process.env.CODEATLAS_BATCH_CHUNK_SIZE) || 500;
  const size = chunkSize ?? defaultSize;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    try {
      await db.executeMany(sql, chunk);
    } catch (err) {
      logger.error(`[BatchExecute] Batch execution failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
