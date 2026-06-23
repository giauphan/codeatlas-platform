import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateEnv, get } from '../../src/config/env.js';

describe('Config Environment Utility', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original env before each test
    originalEnv = process.env;
    // Create a shallow copy so we can modify without affecting global state too much
    // However, process.env assignments need to be done on the global object for the code to see it.
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env after each test
    process.env = originalEnv;
  });

  describe('validateEnv()', () => {
    test('should succeed when all required variables are present', () => {
      process.env.ORACLE_PASSWORD = 'test_password';
      process.env.ORACLE_CONN_STRING = 'test_conn_string';

      assert.doesNotThrow(() => validateEnv());
    });

    test('should throw error when ORACLE_PASSWORD is missing', () => {
      delete process.env.ORACLE_PASSWORD;
      process.env.ORACLE_CONN_STRING = 'test_conn_string';

      assert.throws(
        () => validateEnv(),
        /Missing required env vars: ORACLE_PASSWORD/
      );
    });

    test('should throw error when ORACLE_CONN_STRING is missing', () => {
      process.env.ORACLE_PASSWORD = 'test_password';
      delete process.env.ORACLE_CONN_STRING;

      assert.throws(
        () => validateEnv(),
        /Missing required env vars: ORACLE_CONN_STRING/
      );
    });

    test('should list all missing required variables in the error', () => {
      delete process.env.ORACLE_PASSWORD;
      delete process.env.ORACLE_CONN_STRING;

      assert.throws(
        () => validateEnv(),
        /Missing required env vars: ORACLE_PASSWORD, ORACLE_CONN_STRING/
      );
    });
  });

  describe('get()', () => {
    test('should return existing environment variable', () => {
      process.env.TEST_EXISTING_VAR = 'hello_world';
      const value = get('TEST_EXISTING_VAR');
      assert.strictEqual(value, 'hello_world');
    });

    test('should return default value when environment variable is missing', () => {
      delete process.env.TEST_MISSING_VAR;
      const value = get('TEST_MISSING_VAR', 'default_value');
      assert.strictEqual(value, 'default_value');
    });

    test('should return empty string when environment variable is missing and no default provided', () => {
      delete process.env.TEST_MISSING_NO_DEFAULT;
      const value = get('TEST_MISSING_NO_DEFAULT');
      assert.strictEqual(value, '');
    });

    test('should return default value when environment variable is empty string', () => {
       process.env.TEST_EMPTY_VAR = '';
       const value = get('TEST_EMPTY_VAR', 'fallback');
       assert.strictEqual(value, 'fallback');
    });
  });
});
