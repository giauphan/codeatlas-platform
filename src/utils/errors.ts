/**
 * Custom error class thrown by `batchExecuteMany` when a chunk insertion
 * repeatedly fails and exhausts all retry attempts.
 *
 * @example
 * try {
 *   await batchExecuteMany(db, sql, rows);
 * } catch (err) {
 *   if (err instanceof BatchExecutionError) {
 *     logger.error(`Dead-letter queue dump: ${JSON.stringify(err.failedDataChunk)}`);
 *   }
 * }
 */
export class BatchExecutionError extends Error {
  public code: string;
  public dbErrorCode?: string;
  public originalError: Error | string;
  public failedChunkIndex: number;
  public failedDataChunk?: Record<string, unknown>[];

  constructor(
    message: string,
    originalError: Error | string,
    failedChunkIndex: number,
    failedDataChunk?: Record<string, unknown>[]
  ) {
    super(message);

    // Explicitly set the prototype so that `instanceof BatchExecutionError` works correctly
    // across environments and module boundary transpilation boundaries.
    Object.setPrototypeOf(this, BatchExecutionError.prototype);

    this.name = "BatchExecutionError";
    this.code = "ERR_BATCH_EXECUTION_FAILED";
    if (originalError instanceof Error && 'code' in originalError) {
      this.dbErrorCode = String((originalError as { code: unknown }).code);
    }
    this.originalError = originalError;
    this.failedChunkIndex = Math.max(0, failedChunkIndex);
    this.failedDataChunk = failedDataChunk;

    // Ensure the stack trace only inherits safe type information
    // We intentionally drop `originalError.stack` because deeply nested database
    // error objects (like from Sequelize or raw PG) often embed literal query
    // parameter arrays containing PII inside the stack trace properties.
    if (originalError instanceof Error) {
      this.stack = `${this.stack}\nCaused by: [Redacted ${originalError.name} stack trace for PII safety]`;
    } else if (typeof originalError === 'string') {
      this.stack = `${this.stack}\nCaused by: ${originalError}`;
    } else {
      this.stack = `${this.stack}\nCaused by: Unknown Error Type`;
    }
  }

  /**
   * Safely serializes the error context for external logging sinks.
   * Redacts the failed data chunk by default to prevent PII leaks.
   *
   * Example output:
   * {
   *   "name": "BatchExecutionError",
   *   "code": "ERR_BATCH_EXECUTION_FAILED",
   *   "message": "Batch execution failed after 3 attempts in chunk 0 [TraceId: ...].",
   *   "failedChunkIndex": 0,
   *   "originalError": { "name": "Error", "message": "SQLITE_CONSTRAINT: UNIQUE constraint failed" },
   *   "hasDataChunk": true,
   *   "stack": "..."
   * }
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      dbErrorCode: this.dbErrorCode,
      message: this.message,
      failedChunkIndex: this.failedChunkIndex,
      originalError: this.originalError instanceof Error
        ? { name: this.originalError.name, message: this.originalError.message }
        : String(this.originalError),
      hasDataChunk: !!this.failedDataChunk,
      stack: this.stack
    };
  }
}
