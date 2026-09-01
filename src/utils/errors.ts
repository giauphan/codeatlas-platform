export class BatchExecutionError extends Error {
  public originalError: Error | string;
  public failedChunkIndex: number;

  constructor(message: string, originalError: Error | string, failedChunkIndex: number) {
    super(message);
    this.name = "BatchExecutionError";
    this.originalError = originalError;
    this.failedChunkIndex = Math.max(0, failedChunkIndex);

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
}
