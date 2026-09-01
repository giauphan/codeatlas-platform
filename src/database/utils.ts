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
    const reason = value <= 0 ? 'value must be greater than zero' : 'value must be a safe, finite integer';
    logger.debug(`[Config] Validation failed for positive integer${variableName ? ` (${variableName})` : ''}: ${value} - ${reason}`);
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
 *
 * @example
 * // Validates that 'id' and 'name' are strings on the first 10 rows
 * validateRows(rows, { id: 'string', name: 'string' }, 10, 'UsersTable');
 */
export function validateRows<T extends Record<string, unknown>>(
  rows: T[],
  expectedTypes: Partial<Record<keyof T, "string" | "number" | "boolean" | "object" | "undefined">>,
  sampleSize?: number,
  traceIdContext?: string
): void {
  const rowsToCheck = sampleSize && sampleSize > 0
    ? rows.slice(0, Math.min(sampleSize, rows.length))
    : rows;

  const logPrefix = traceIdContext ? `[BatchExecute][${traceIdContext}]` : `[BatchExecute]`;

  for (let i = 0; i < rowsToCheck.length; i++) {
    const row = rowsToCheck[i];
    for (const [field, expectedType] of Object.entries(expectedTypes) as [keyof T, string][]) {
      const val = row[field];
      if (expectedType && typeof val !== expectedType) {
        const errMsg = `${logPrefix} Pre-validation failed at row index ${i}: field '${String(field)}' expected ${expectedType}, got ${typeof val}.`;
        logger.error(errMsg);
        throw new Error(errMsg);
      }

      // Enforce non-empty string constraint
      if (expectedType === 'string' && (val as unknown as string).trim() === '') {
        const errMsg = `${logPrefix} Pre-validation failed at row index ${i}: field '${String(field)}' must not be an empty string.`;
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

export interface BatchExecuteDatabaseAdapter<T extends Record<string, unknown>> {
  executeMany?: (sql: string, params: T[]) => Promise<{ rowsAffected: number }>;
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
 *
 * Behavior on failure: If execution fails after `maxRetries` attempts or exceeds
 * `timeoutMs`, this function will throw a `BatchExecutionError`. Callers should
 * capture this error if they need to implement fallback recovery mechanisms (like
 * writing failed chunks to a dead-letter queue).
 *
 * @example
 * // Inserts 10,000 rows in chunks of 500, retrying up to 3 times on lock errors
 * await batchExecuteMany(db, "INSERT INTO table VALUES (:a, :b)", rows, { chunkSize: 500 });
 */
export async function batchExecuteMany<T extends Record<string, unknown>>(
  db: BatchExecuteDatabaseAdapter<T>,
  sql: string,
  rows: T[],
  config: BatchExecuteConfig = {}
): Promise<void> {
  if (rows.length === 0) return;

  if (typeof db.executeMany !== 'function') {
    throw new Error("[BatchExecute] Provided database adapter does not support 'executeMany'.");
  }

  const size = config.chunkSize ?? BatchConfigDefaults.CHUNK_SIZE;
  const retries = config.maxRetries ?? BatchConfigDefaults.MAX_RETRIES;
  const maxDelayMs = config.maxDelayMs ?? BatchConfigDefaults.MAX_DELAY;
  const timeoutMs = config.timeoutMs ?? BatchConfigDefaults.TIMEOUT_MS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? BatchConfigDefaults.RETRY_BASE_DELAY_MS;
  const retryJitterMs = config.retryJitterMs ?? BatchConfigDefaults.RETRY_JITTER_MS;

  const startTime = performance.now();
  const traceId = randomUUID();

  // ==========================================
  // EXECUTION & RETRY LOOP
  // ==========================================
  let totalRetries = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunkIndex = i / size;
    const chunk = rows.slice(i, i + size);
    let attempt = 0;
    let lastError: unknown;
    const batchStartTime = performance.now();

    while (attempt < retries) {
      try {
        await db.executeMany!(sql, chunk);
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
          throw new BatchExecutionError(`Fatal batch execution error in chunk ${chunkIndex} [TraceId: ${traceId}].`, parsedErr, chunkIndex, chunk);
        }

        attempt++;
        const elapsedSinceBatchStart = performance.now() - batchStartTime;
        if (elapsedSinceBatchStart > timeoutMs) {
          logger.error(`[BatchExecute][${traceId}] Batch chunk ${chunkIndex} exceeded cumulative timeout of ${timeoutMs}ms. Aborting retries.`);
          throw new BatchExecutionError(`Batch execution timeout exceeded for chunk ${chunkIndex} [TraceId: ${traceId}].`, parsedErr, chunkIndex, chunk);
        }

        if (attempt < retries) {
          totalRetries++;
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
      throw new BatchExecutionError(`Batch execution failed after ${retries} attempts in chunk ${chunkIndex} [TraceId: ${traceId}].`, lastError as Error | string, chunkIndex, chunk);
    }
  }

  // ==========================================
  // PERFORMANCE LOGGING
  // ==========================================
  const elapsed = Math.round(performance.now() - startTime);
  const totalChunks = Math.ceil(rows.length / size);
  const retryMetrics = totalRetries > 0 ? ` with ${totalRetries} retries` : '';
  logger.debug(`[BatchExecute][${traceId}] Successfully executed ${rows.length} rows across ${totalChunks} chunks in ${elapsed}ms cumulative time${retryMetrics} (chunk size: ${size}).`);
}
