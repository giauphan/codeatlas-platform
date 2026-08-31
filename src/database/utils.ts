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
 * Safely parses an environment variable into a positive integer,
 * returning the provided default if invalid.
 *
 * @param envVarValue The raw string value from process.env to parse.
 * @param defaultValue The fallback positive integer to return if parsing fails.
 * @returns A guaranteed positive integer.
 */
export function parsePositiveInt(envVarValue: string | undefined, defaultValue: number): number {
  const parsed = Number(envVarValue);
  return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

/**
 * Executes batch inserts in chunks, addressing N+1 query bottlenecks.
 * Prevents excessive memory consumption during high-volume inserts.
 * Implements retries with exponential backoff for transient DB failures.
 */
export async function batchExecuteMany(
  db: { executeMany: (sql: string, params: Array<Record<string, unknown>>) => Promise<{ rowsAffected: number }> },
  sql: string,
  rows: Array<Record<string, unknown>>,
  chunkSize?: number,
  maxRetries?: number
): Promise<void> {
  const defaultSize = parsePositiveInt(process.env.CODEATLAS_BATCH_CHUNK_SIZE, 500);
  const size = chunkSize ?? defaultSize;
  const retries = maxRetries ?? parsePositiveInt(process.env.CODEATLAS_BATCH_MAX_RETRIES, 3);

  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < retries) {
      try {
        await db.executeMany(sql, chunk);
        break; // Success, break out of retry loop
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        attempt++;
        if (attempt < retries) {
          logger.warn(`[BatchExecute] Batch ${i / size} execution failed. Retrying attempt ${attempt + 1}/${retries}...`);
          // Small exponential backoff with jitter and a max cap of 2000ms
          const delay = Math.min(Math.floor(Math.random() * 100 + Math.pow(2, attempt) * 100), 2000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (attempt >= retries) {
      const errMsg = `[BatchExecute] Batch ${i / size} execution failed after ${retries} attempts.`;
      logger.error(errMsg);
      throw new BatchExecutionError(errMsg, lastError, i / size);
    }
  }
}
