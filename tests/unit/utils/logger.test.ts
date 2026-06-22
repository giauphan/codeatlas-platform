import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

describe("Logger", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let stdoutSpy: mock.Mock<any>;
  let stderrSpy: mock.Mock<any>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.LOG_LEVEL = "debug";
    process.env.LOG_FORMAT = "pretty";

    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;

    stdoutSpy = mock.fn(() => true);
    stderrSpy = mock.fn(() => true);

    process.stdout.write = stdoutSpy as any;
    process.stderr.write = stderrSpy as any;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    mock.restoreAll();
  });

  async function getLogger() {
    // Need to clear cache to allow different env vars to apply correctly for each test
    const randomVersion = Math.random().toString(36).substring(7);
    const mod = await import(`../../../src/utils/logger.js?v=${randomVersion}`);
    return mod.logger;
  }

  test("should log string to stdout for info level", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info("test info message");

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);

    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes("[INFO] test info message"));
  });

  test("should log error to stderr for error level", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.error("test error message");

    assert.strictEqual(stdoutSpy.mock.callCount(), 0);
    assert.strictEqual(stderrSpy.mock.callCount(), 1);

    const output = stderrSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes("[ERROR] test error message"));
  });

  test("should log warning to stdout for warn level in pretty mode", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.warn("test warn message");

    // In src/utils/logger.ts, pretty mode logs "warn" to stdout (only "error" goes to stderr in pretty mode)
    // while in json mode both "error" and "warn" go to stderr.
    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);

    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes("[WARN] test warn message"));
  });

  test("should log multiple arguments", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.debug("a", 1, true);

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes("[DEBUG] a 1 true"));
  });

  test("should stringify objects in message", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info("user data:", { id: 1, name: "alice" });

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('user data: {"id":1,"name":"alice"}'));
  });

  test("should properly format Error instances", async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    const error = new Error("Database connection failed");
    logger.error("Failed to connect:", error);

    assert.strictEqual(stderrSpy.mock.callCount(), 1);
    const output = stderrSpy.mock.calls[0].arguments[0];
    assert.ok(
      output.includes("Failed to connect: Error: Database connection failed"),
    );
    assert.ok(output.includes("logger.test.ts"));
  });

  test("should suppress logs below configured LOG_LEVEL", async () => {
    process.env.LOG_LEVEL = "warn";
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.debug("debug log");
    logger.info("info log");
    logger.warn("warn log");
    logger.error("error log");

    assert.strictEqual(stdoutSpy.mock.callCount(), 1); // warn log goes to stdout in pretty mode
    assert.strictEqual(stderrSpy.mock.callCount(), 1); // error log goes to stderr
  });

  test("should output JSON when LOG_FORMAT=json", async () => {
    process.env.LOG_LEVEL = "debug";
    process.env.LOG_FORMAT = "json";
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info("system start", { port: 8080 });

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];

    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.level, "info");
    assert.strictEqual(parsed.msg, "system start");
    assert.deepStrictEqual(parsed.meta, { port: 8080 });
    assert.ok(parsed.time);
  });
});
