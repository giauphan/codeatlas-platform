export class BatchExecutionError extends Error {
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
    this.name = "BatchExecutionError";
    this.originalError = originalError;
    this.failedChunkIndex = Math.max(0, failedChunkIndex);
    this.failedDataChunk = failedDataChunk;

    // Explicitly inherit the stack trace from the original error if available
    // to improve debuggability while maintaining our custom error type.
    // Note: this passes through the original stack. Ensure that upstream
    // handlers redact PII if the original error object embedded sensitive
    // query parameters in its stack trace before flushing to external sinks.
    if (originalError instanceof Error && originalError.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    } else if (typeof originalError === 'string') {
      this.stack = `${this.stack}\nCaused by: ${originalError}`;
    } else {
      this.stack = `${this.stack}\nCaused by: Unknown Error Type`;
    }
  }

  /**
   * Safely serializes the error context for external logging sinks.
   * Redacts the failed data chunk by default to prevent PII leaks.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
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
