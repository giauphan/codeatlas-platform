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
 * Custom error class to provide context for batch execution failures.
 */
export class BatchExecutionError extends Error {
  public originalError: unknown;
  public failedChunkIndex: number;

  constructor(message: string, originalError: unknown, failedChunkIndex: number) {
    super(message);
    this.name = "BatchExecutionError";
    this.originalError = originalError;
    this.failedChunkIndex = failedChunkIndex;
  }
}

/**
 * Utility to batch executeMany calls to prevent memory consumption risks
 * during massive batch inserts. Includes retry logic for transient failures.
 */
export async function batchExecuteMany(
  db: { executeMany: (sql: string, params: Array<Record<string, unknown>>) => Promise<{ rowsAffected: number }> },
  sql: string,
  rows: Array<Record<string, unknown>>,
  chunkSize?: number,
  maxRetries = 3
): Promise<void> {
  const parsedEnvSize = Number(process.env.CODEATLAS_BATCH_CHUNK_SIZE);
  const defaultSize = Number.isNaN(parsedEnvSize) || parsedEnvSize <= 0 ? 500 : parsedEnvSize;
  const size = chunkSize ?? defaultSize;

  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxRetries) {
      try {
        await db.executeMany(sql, chunk);
        break; // Success, break out of retry loop
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt < maxRetries) {
          logger.warn(`[BatchExecute] Batch ${i / size} execution failed. Retrying attempt ${attempt + 1}/${maxRetries}...`);
          // Small exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }

    if (attempt >= maxRetries) {
      const errMsg = `[BatchExecute] Batch ${i / size} execution failed after ${maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      logger.error(errMsg);
      throw new BatchExecutionError(errMsg, lastError, i / size);
    }
  }
}
