import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { validateEnv, get, getDisabledTools, isToolEnabled, PROTECTED_TOOLS } from '../../src/config/env.js';

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
    test('should succeed with default (sqlite) configuration', () => {
      delete process.env.CODEATLAS_DB_TYPE;
      assert.doesNotThrow(() => validateEnv());
    });

    test('should succeed when CODEATLAS_DB_TYPE is sqlite', () => {
      process.env.CODEATLAS_DB_TYPE = 'sqlite';
      assert.doesNotThrow(() => validateEnv());
    });

    test('should succeed when CODEATLAS_DB_TYPE is postgres', () => {
      process.env.CODEATLAS_DB_TYPE = 'postgres';
      assert.doesNotThrow(() => validateEnv());
    });

    test('should throw error for an unsupported CODEATLAS_DB_TYPE', () => {
      process.env.CODEATLAS_DB_TYPE = 'oracle';
      assert.throws(
        () => validateEnv(),
        /Unsupported CODEATLAS_DB_TYPE/
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

  describe('getDisabledTools() & isToolEnabled()', () => {
    test('should return empty set when CODEATLAS_DISABLED_TOOLS is not set', () => {
      delete process.env.CODEATLAS_DISABLED_TOOLS;
      assert.strictEqual(getDisabledTools().size, 0);
      assert.strictEqual(isToolEnabled('detect_architectural_smells'), true);
    });

    test('should parse comma-separated disabled tools and trim whitespace', () => {
      process.env.CODEATLAS_DISABLED_TOOLS = ' detect_architectural_smells , scan_enterprise_vulnerabilities ';
      const disabled = getDisabledTools();
      assert.strictEqual(disabled.has('detect_architectural_smells'), true);
      assert.strictEqual(disabled.has('scan_enterprise_vulnerabilities'), true);
      assert.strictEqual(isToolEnabled('detect_architectural_smells'), false);
      assert.strictEqual(isToolEnabled('scan_enterprise_vulnerabilities'), false);
      assert.strictEqual(isToolEnabled('query_dream_memories'), true);
    });

    test('should never disable protected tools even if explicitly listed', () => {
      process.env.CODEATLAS_DISABLED_TOOLS = 'save_dream_memory,query_dream_memories,search_genome,scan_immune_genes,detect_architectural_smells';
      const disabled = getDisabledTools();
      assert.strictEqual(disabled.has('detect_architectural_smells'), true);
      assert.strictEqual(disabled.has('save_dream_memory'), false);
      assert.strictEqual(disabled.has('query_dream_memories'), false);
      assert.strictEqual(disabled.has('search_genome'), false);
      assert.strictEqual(disabled.has('scan_immune_genes'), false);

      for (const protectedTool of PROTECTED_TOOLS) {
        assert.strictEqual(isToolEnabled(protectedTool), true);
      }
    });
  });
});
