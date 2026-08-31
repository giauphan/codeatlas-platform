/**
 * Helper to build an IN clause with parameterized bindings.
 * Ensures protection against SQL injection.
 * @param ids Array of ID strings
 * @param baseBinds Base bind variables (e.g. project, tenantId)
 */
import { randomUUID } from "node:crypto";
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

    // Explicitly inherit the stack trace from the original error if available
    // to improve debuggability while maintaining our custom error type.
    if (originalError instanceof Error && originalError.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

function isValidPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && Number.isFinite(value);
}

/**
 * Safely parses an environment variable into a positive integer,
 * returning the provided default if invalid (e.g., NaN, Infinity).
 *
 * @param envVarValue The raw string value from process.env to parse.
 * @param defaultValue The fallback positive integer to return if parsing fails.
 * @returns A guaranteed positive integer.
 */
export function parsePositiveInt(envVarValue: string | undefined, defaultValue: number): number {
  const safeDefault = isValidPositiveInt(defaultValue) ? defaultValue : 1;

  if (envVarValue === undefined) {
    return safeDefault;
  }

  const parsed = Number(envVarValue);
  if (!isValidPositiveInt(parsed)) {
    logger.warn(`[Config] Invalid positive integer value provided: "${envVarValue}". Using safe fallback: ${safeDefault}.`);
    return safeDefault;
  }

  return parsed;
}

export interface BatchExecuteConfig {
  chunkSize?: number;
  maxRetries?: number;
  maxDelayMs?: number;
}

/**
 * Executes batch inserts in chunks, addressing N+1 query bottlenecks.
 * Prevents excessive memory consumption during high-volume inserts.
 * Implements retries with exponential backoff for transient DB failures.
 *
 * Note: Be mindful of database-specific parameter limits when tuning chunk sizes
 * (e.g. SQLite's SQLITE_MAX_VARIABLE_NUMBER default limit of 999 or 32766).
 */
export async function batchExecuteMany(
  db: { executeMany: (sql: string, params: Array<Record<string, unknown>>) => Promise<{ rowsAffected: number }> },
  sql: string,
  rows: Array<Record<string, unknown>>,
  config: BatchExecuteConfig = {}
): Promise<void> {
  if (rows.length === 0) return;

  const size = config.chunkSize ?? parsePositiveInt(process.env.CODEATLAS_BATCH_CHUNK_SIZE, 500);
  const retries = config.maxRetries ?? parsePositiveInt(process.env.CODEATLAS_BATCH_MAX_RETRIES, 3);
  const maxDelayMs = config.maxDelayMs ?? parsePositiveInt(process.env.CODEATLAS_BATCH_MAX_DELAY, 2000);

  const startTime = Date.now();
  const traceId = randomUUID();

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
          // Math.random() * 100 adds jitter to the exponential backoff delay.
          // This prevents "thundering herd" scenarios where multiple concurrent
          // failing batches wake up and retry against the database at the exact same time.
          const delay = Math.min(Math.floor(Math.random() * 100 + (2 ** attempt) * 100), maxDelayMs);
          logger.warn(`[BatchExecute][${traceId}] Batch ${i / size} execution failed. Retrying attempt ${attempt + 1}/${retries} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (attempt >= retries) {
      const retryInfo = `after ${retries} attempts. Caused by: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      logger.error(`[BatchExecute][${traceId}] Batch ${i / size} failed ${retryInfo}`);
      throw new BatchExecutionError(`Batch execution failed ${retryInfo}`, lastError, i / size);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.debug(`[BatchExecute][${traceId}] Successfully executed ${rows.length} rows in ${Math.ceil(rows.length / size)} batches (chunk size: ${size}) in ${elapsed}ms.`);
}
