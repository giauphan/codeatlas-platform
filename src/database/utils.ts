/**
 * Helper to build an IN clause with parameterized bindings.
 * Ensures protection against SQL injection.
 * @param ids Array of ID strings
 * @param baseBinds Base bind variables (e.g. project, tenantId)
 */
import { randomUUID, randomInt } from "node:crypto";
import { logger } from "../utils/logger.js";
import { BatchExecutionError } from "../utils/errors.js";

/** Default configurations for batchExecuteMany retries and chunking. */
export const BatchConfigDefaults = {
  CHUNK_SIZE: 500, // Number of rows per DB operation
  MAX_RETRIES: 3, // Max DB retry attempts per chunk
  MAX_DELAY: 2000, // Maximum cap on exponential backoff delay in ms
  TIMEOUT_MS: 30000, // Overall execution timeout per chunk
  RETRY_BASE_DELAY_MS: 100, // Base floor delay for first retry
  RETRY_JITTER_MS: 100, // Max random jitter added to delay
} as const;

/** Known fatal errors where retrying will never succeed (e.g. constraints, syntax). */
export const FatalErrorTypes = {
  SQLITE_CONSTRAINT: 'SQLITE_CONSTRAINT',
  POSTGRES_UNIQUE_VIOLATION: '23505', // Postgres unique constraint violation code
  POSTGRES_FOREIGN_KEY_VIOLATION: '23503', // Postgres FK constraint violation
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

function isValidPositiveInt(value: number, variableName?: string): boolean {
  const isValid = value > 0 && Number.isSafeInteger(value) && Number.isFinite(value);
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
    logger.warn(`[Config] parsePositiveInt invalid input: provided value${variableName ? ` for ${variableName}` : ''} must be a positive finite integer. Using fallback: ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

/**
 * Helper function to pre-validate rows before database insertion.
 * For large datasets, a sampleSize can be provided to only validate
 * the first N rows under the assumption of schema homogeneity,
 * trading strictness for performance.
 */
export function validateRows<T extends Record<string, unknown>>(
  rows: T[],
  expectedTypes: Partial<Record<keyof T, "string" | "number" | "boolean" | "object" | "undefined">>,
  sampleSize?: number
): void {
  const rowsToCheck = sampleSize && sampleSize > 0 && sampleSize < rows.length
    ? rows.slice(0, sampleSize)
    : rows;

  for (const row of rowsToCheck) {
    for (const [field, expectedType] of Object.entries(expectedTypes) as [keyof T, string][]) {
      if (expectedType && typeof row[field] !== expectedType) {
        const errMsg = `[BatchExecute] Pre-validation failed: row field '${String(field)}' expected ${expectedType}, got ${typeof row[field]}.`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }
    }
  }
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
 * If your SQL query uses 5 parameters per row and you set CHUNK_SIZE to 500,
 * you will pass 2500 variables, which exceeds older SQLite defaults. Adjust
 * config.chunkSize accordingly for your dialect.
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

  const startTime = performance.now();
  const traceId = randomUUID();

  for (let i = 0; i < rows.length; i += size) {
    const chunkIndex = i / size;
    const chunk = rows.slice(i, i + size);
    let attempt = 0;
    let lastError: unknown;
    const batchStartTime = performance.now();

    while (attempt < retries) {
      try {
        await db.executeMany(sql, chunk);
        break; // Success, break out of retry loop
      } catch (err) {
        const parsedErr = err instanceof Error ? err : new Error(String(err));
        lastError = parsedErr;

        // Immediately fail on known non-transient / fatal errors
        const errCode = (parsedErr as { code?: string }).code;
        const isFatal =
          errCode === FatalErrorTypes.SQLITE_CONSTRAINT ||
          errCode === FatalErrorTypes.POSTGRES_UNIQUE_VIOLATION ||
          errCode === FatalErrorTypes.POSTGRES_FOREIGN_KEY_VIOLATION ||
          parsedErr.name === FatalErrorTypes.SYNTAX_ERROR;

        if (isFatal) {
          logger.error(`[BatchExecute][${traceId}] Fatal error encountered in batch chunk ${chunkIndex}. Aborting retries.`);
          throw new BatchExecutionError(`Fatal batch execution error in chunk ${chunkIndex} [TraceId: ${traceId}].`, parsedErr, chunkIndex);
        }

        attempt++;
        const elapsedSinceBatchStart = performance.now() - batchStartTime;
        if (elapsedSinceBatchStart > timeoutMs) {
          logger.error(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} exceeded cumulative timeout of ${timeoutMs}ms. Aborting retries.`);
          throw new BatchExecutionError(`Batch execution timeout exceeded for chunk ${chunkIndex} [TraceId: ${traceId}].`, parsedErr, chunkIndex);
        }

        if (attempt < retries) {
          // Adds jitter using a cryptographically secure random number generator to prevent "thundering herd" scenarios.
          // Ensures a minimum delay bounded by retryBaseDelayMs even on the first attempt (when 2^0 = 1).
          const jitter = randomInt(0, retryJitterMs + 1);
          const targetDelay = Math.min(
            Math.max(
              retryBaseDelayMs,
              Math.floor(jitter + (2 ** attempt) * retryBaseDelayMs)
            ),
            maxDelayMs
          );

          // Cap the delay so we don't sleep longer than the remaining timeout budget
          const remainingTimeout = timeoutMs - elapsedSinceBatchStart;
          const delay = Math.min(targetDelay, remainingTimeout);

          logger.warn(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} execution failed. Retrying attempt ${attempt + 1}/${retries} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (attempt >= retries) {
      // Redact sensitive details in logs by logging error name only (unless explicitly configured to trace)
      const errorName = lastError instanceof Error ? lastError.name : "UnknownError";
      logger.error(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} failed after ${retries} attempts. ErrorType: ${errorName}`);
      throw new BatchExecutionError(`Batch execution failed after ${retries} attempts in chunk ${chunkIndex} [TraceId: ${traceId}].`, lastError as Error | string, chunkIndex);
    }
  }

  const elapsed = Math.round(performance.now() - startTime);
  logger.debug(`[BatchExecute][${traceId}] Successfully executed ${rows.length} rows in ${Math.ceil(rows.length / size)} batches (chunk size: ${size}) in ${elapsed}ms.`);
}
