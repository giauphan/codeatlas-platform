/**
 * Helper to build an IN clause with parameterized bindings.
 * Ensures protection against SQL injection.
 * @param ids Array of ID strings
 * @param baseBinds Base bind variables (e.g. project, tenantId)
 */
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

export const BatchConfigDefaults = {
  CHUNK_SIZE: 500,
  MAX_RETRIES: 3,
  MAX_DELAY: 2000,
  TIMEOUT_MS: 30000,
  RETRY_BASE_DELAY_MS: 100,
  RETRY_JITTER_MS: 100,
} as const;

export const FatalErrorTypes = {
  SQLITE_CONSTRAINT: 'SQLITE_CONSTRAINT',
  SYNTAX_ERROR: 'SyntaxError'
} as const;


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
  public originalError: Error | string;
  public failedChunkIndex: number;

  constructor(message: string, originalError: Error | string, failedChunkIndex: number) {
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

function isValidPositiveInt(value: number, variableName?: string): boolean {
  const isValid = Number.isSafeInteger(value) && value > 0 && Number.isFinite(value);
  if (!isValid) {
    logger.debug(`[Config] Validation failed for positive integer${variableName ? ` (${variableName})` : ''}: ${value}`);
  }
  return isValid;
}

/**
 * Safely parses an environment variable into a positive integer,
 * returning the provided default if invalid (e.g., NaN, Infinity).
 *
 * @param envVarValue The raw string value from process.env to parse.
 * @param defaultValue The fallback positive integer to return if parsing fails.
 * @param variableName Optional variable name to include in debug logs.
 * @returns A guaranteed positive integer.
 */
export function parsePositiveInt(envVarValue: string | undefined, defaultValue: number, variableName?: string): number {
  if (!isValidPositiveInt(defaultValue, variableName ? `${variableName} default` : undefined)) {
    throw new Error(`[Config] Invalid defaultValue provided to parsePositiveInt: ${defaultValue}. Must be a positive integer.`);
  }

  if (envVarValue === undefined) {
    return defaultValue;
  }

  const parsed = Number(envVarValue);
  if (!isValidPositiveInt(parsed, variableName)) {
    logger.warn(`[Config] Invalid positive integer value provided${variableName ? ` for ${variableName}` : ''}: "${envVarValue}". Using fallback: ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

export interface BatchExecuteConfig {
  chunkSize?: number;
  maxRetries?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
}

/**
 * Executes batch inserts in chunks, addressing N+1 query bottlenecks.
 * Prevents excessive memory consumption during high-volume inserts.
 * Implements retries with exponential backoff for transient DB failures.
 *
 * Note: Be mindful of database-specific parameter limits when tuning chunk sizes
 * (e.g. SQLite's SQLITE_MAX_VARIABLE_NUMBER default limit of 999 or 32766).
 */
export async function batchExecuteMany<T extends Record<string, unknown>>(
  db: { executeMany: (sql: string, params: T[]) => Promise<{ rowsAffected: number }> },
  sql: string,
  rows: T[],
  config: BatchExecuteConfig = {}
): Promise<void> {
  if (rows.length === 0) return;

  const size = config.chunkSize ?? BatchConfigDefaults.CHUNK_SIZE;
  const retries = config.maxRetries ?? BatchConfigDefaults.MAX_RETRIES;
  const maxDelayMs = config.maxDelayMs ?? BatchConfigDefaults.MAX_DELAY;
  const timeoutMs = config.timeoutMs ?? BatchConfigDefaults.TIMEOUT_MS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? BatchConfigDefaults.RETRY_BASE_DELAY_MS;
  const retryJitterMs = config.retryJitterMs ?? BatchConfigDefaults.RETRY_JITTER_MS;

  const startTime = Date.now();
  const traceId = randomUUID();

  for (let i = 0; i < rows.length; i += size) {
    const chunkIndex = i / size;
    const chunk = rows.slice(i, i + size);
    let attempt = 0;
    let lastError: unknown;
    const batchStartTime = Date.now();

    while (attempt < retries) {
      try {
        await db.executeMany(sql, chunk);
        break; // Success, break out of retry loop
      } catch (err) {
        const parsedErr = err instanceof Error ? err : new Error(String(err));
        lastError = parsedErr;

        // Immediately fail on known non-transient / fatal errors
        const isFatal =
          (parsedErr as { code?: string }).code === FatalErrorTypes.SQLITE_CONSTRAINT ||
          parsedErr.name === FatalErrorTypes.SYNTAX_ERROR;

        if (isFatal) {
          logger.error(`[BatchExecute][${traceId}] Fatal error encountered in batch chunk ${chunkIndex}. Aborting retries.`);
          throw new BatchExecutionError(`Fatal batch execution error.`, parsedErr, chunkIndex);
        }

        attempt++;
        if (Date.now() - batchStartTime > timeoutMs) {
          logger.error(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} exceeded cumulative timeout of ${timeoutMs}ms. Aborting retries.`);
          throw new BatchExecutionError(`Batch execution timeout exceeded.`, parsedErr, chunkIndex);
        }

        if (attempt < retries) {
          // Adds jitter to the exponential backoff delay to prevent "thundering herd" scenarios.
          const delay = Math.min(Math.floor(Math.random() * retryJitterMs + (2 ** attempt) * retryBaseDelayMs), maxDelayMs);
          logger.warn(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} execution failed. Retrying attempt ${attempt + 1}/${retries} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (attempt >= retries) {
      // Redact sensitive details in logs by logging error name only (unless explicitly configured to trace)
      const errorName = lastError instanceof Error ? lastError.name : "UnknownError";
      logger.error(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} failed after ${retries} attempts. ErrorType: ${errorName}`);
      throw new BatchExecutionError(`Batch execution failed after ${retries} attempts.`, lastError as Error | string, chunkIndex);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.debug(`[BatchExecute][${traceId}] Successfully executed ${rows.length} rows in ${Math.ceil(rows.length / size)} batches (chunk size: ${size}) in ${elapsed}ms.`);
}
