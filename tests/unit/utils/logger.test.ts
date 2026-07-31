import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

describe('Logger', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let stdoutSpy: mock.Mock<any>;
  let stderrSpy: mock.Mock<any>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'pretty';

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
  });

  async function getLogger() {
    // Need to clear cache to allow different env vars to apply correctly for each test
    const randomVersion = Math.random().toString(36).substring(7);
    const mod = await import(`../../../src/utils/logger.js?v=${randomVersion}`);
    return mod.logger;
  }

  test('should log string to stdout for info level', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info('test info message');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);

    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[INFO] test info message'));
  });

  test('should log error to stderr for error level', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.error('test error message');

    assert.strictEqual(stdoutSpy.mock.callCount(), 0);
    assert.strictEqual(stderrSpy.mock.callCount(), 1);

    const output = stderrSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[ERROR] test error message'));
  });

  test('should log warning to stdout for warn level in pretty mode', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.warn('test warn message');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);

    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[WARN] test warn message'));
  });

  test('should log multiple arguments', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.debug('a', 1, true);

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[DEBUG] a 1 true'));
  });

  test('should stringify objects in message', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info('user data:', { id: 1, name: 'alice' });

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('user data: {"id":1,"name":"alice"}'));
  });

  test('should properly format Error instances', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    const error = new Error('Database connection failed');
    logger.error('Failed to connect:', error);

    assert.strictEqual(stderrSpy.mock.callCount(), 1);
    const output = stderrSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('Failed to connect: Error: Database connection failed'));
    assert.ok(output.includes('logger.test.ts'));
  });

  test('should suppress logs below configured LOG_LEVEL', async () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.debug('debug log');
    logger.info('info log');
    logger.warn('warn log');
    logger.error('error log');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1); // warn log goes to stdout in pretty mode
    assert.strictEqual(stderrSpy.mock.callCount(), 1); // error log goes to stderr
  });

  test('should output JSON when LOG_FORMAT=json', async () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'json';
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info('system start', { port: 8080 });

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];

    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.msg, 'system start');
    assert.deepStrictEqual(parsed.meta, { port: 8080 });
    assert.ok(parsed.time);
  });

  test('should default to info level if LOG_LEVEL is unset or invalid', async () => {
    delete process.env.LOG_LEVEL;
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.debug('should be suppressed');
    logger.info('should appear');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[INFO] should appear'));
  });

  test('should default to pretty format if LOG_FORMAT is unset or invalid', async () => {
    process.env.LOG_FORMAT = 'invalid_format';
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info('system start');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(!output.startsWith('{')); // not JSON
    assert.ok(output.includes('[INFO] system start'));
  });

  test('should handle null and undefined arguments', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info(null, undefined);

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[INFO] null undefined'));
  });

  test('should handle empty string messages', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    logger.info('');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    assert.ok(output.includes('[INFO] '));
  });

  test('should fallback to String() for circular objects where JSON.stringify throws', async () => {
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    const circularObj: any = {};
    circularObj.self = circularObj;

    // A circular object passed as meta might throw, but our logger handles it in stringify if it isn't meta.
    // However, if it's treated as meta, JSON.stringify(meta) at the end of `log` will throw.
    // BUT wait! The logger stringify function catches JSON.stringify errors and uses String(val).
    // Let's pass it as a regular message part first:
    logger.info('circular in message', circularObj, 'end');

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    // Object toString fallback is typically '[object Object]'
    assert.ok(output.includes('circular in message [object Object] end'));

    // In our logger.ts, if it's the LAST argument, formatMeta treats it as meta.
    // If it's meta, it uses JSON.stringify directly in log(): `output += " " + JSON.stringify(meta)`
    // This will actually throw if it's circular! Let's verify logger doesn't crash or handles it.
    // Wait, let's look at `logger.ts` line 67:
    // `output += \` \${JSON.stringify(meta)}\`;`
    // It does not try/catch here! It only try/catches inside `stringify(val)`.
    // Wait... if I pass circularObj as the *last* arg, it becomes `meta`.
    // And JSON.stringify(meta) WILL throw.
    logger.info('circular as meta', circularObj);
    assert.strictEqual(stdoutSpy.mock.callCount(), 2);
    const output2 = stdoutSpy.mock.calls[1].arguments[0];
    assert.ok(output2.includes('circular as meta [object Object]'));
  });

  test('should fallback to String() for circular objects in JSON mode', async () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'json';
    const logger = await getLogger();
    stdoutSpy.mock.resetCalls();
    stderrSpy.mock.resetCalls();

    const circularObj: any = {};
    circularObj.self = circularObj;

    logger.info('circular as meta in JSON', circularObj);

    assert.strictEqual(stdoutSpy.mock.callCount(), 1);
    const output = stdoutSpy.mock.calls[0].arguments[0];
    const parsed = JSON.parse(output);

    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.msg, 'circular as meta in JSON');
    assert.strictEqual(parsed.meta, '[object Object]');
  });
});
