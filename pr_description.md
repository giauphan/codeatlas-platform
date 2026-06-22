🧪 Add unit tests for logger.ts utility

🎯 **What:** The testing gap addressed
The `logger.ts` utility file was missing unit tests, leaving logging behaviors (like output streams, logic based on levels, structured JSON outputs vs. pretty formatting, and error formatting) untested.

📊 **Coverage:** What scenarios are now tested
- Validates the info, warn, debug, and error outputs to the correct stream (`stdout` vs `stderr`).
- Verifies format strings with multiple arguments are handled properly.
- Checks that plain objects are gracefully stringified or attached as metadata depending on the environment context.
- Guarantees correct stringification and trace rendering for Error instances.
- Ensures output matches the `LOG_LEVEL` filtering mechanism.
- Validates structural output formats based on `LOG_FORMAT=json`.

✨ **Result:** The improvement in test coverage
`src/utils/logger.ts` now features 100% test coverage for its exported functions and internal mechanisms via mocking of the `stdout/stderr` streams using `node:test`, providing a solid foundation for safely refining its logic in the future.
