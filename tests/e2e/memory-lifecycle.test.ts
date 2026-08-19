/**
 * E2E tests for Memory Lifecycle Governance — Phase 1-4
 *
 * Tests:
 * - Phase 1: Lifecycle columns on ai_dreaming_memory
 * - Phase 2: Pre-save noise gate
 * - Phase 3: Weighted retrieval ranking
 * - Phase 4: Consolidation decay/archive/supersession
 */

import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');

// ═════════════════════════════════════════════════════════════════════
// Shared mocks
// ═════════════════════════════════════════════════════════════════════

const mockConnection = {
  execute: mock.fn(),
  executeMany: mock.fn(() => Promise.resolve({ rowsAffected: 0 })),
  close: mock.fn(),
  commit: mock.fn(),
  rollback: mock.fn(),
};

const mockPool = {
  getConnection: mock.fn(() => Promise.resolve(mockConnection)),
};

mock.module('oracledb', {
  namedExports: {
    OUT_FORMAT_OBJECT: 4001,
    CLOB: 2011,
    STRING: 2001,
    DB_TYPE_JSON: 2007,
    createPool: mock.fn(() => Promise.resolve(mockPool)),
    initOracleClient: mock.fn(),
    outFormat: undefined as unknown,
    fetchAsString: [] as number[],
    default: {},
  },
});

mock.module(path.join(srcDir, 'database/connection.js'), {
  namedExports: {
    initPool: mock.fn(() => Promise.resolve(mockPool)),
    setSessionContext: mock.fn(() => Promise.resolve()),
  },
});

const mockDbAdapter = {
  searchVector: mock.fn(() => Promise.resolve([
    { id: 'm1', score: 0.9 },
    { id: 'm2', score: 0.8 },
    { id: 'id1', score: 0.85 },
    { id: 'id2', score: 0.75 },
    { id: 'mem1', score: 0.95 },
    { id: 'mem2', score: 0.65 },
  ])),
  connect: mock.fn(() => Promise.resolve()),
  disconnect: mock.fn(() => Promise.resolve()),
  query: mock.fn(() => Promise.resolve([])),
  execute: mock.fn(() => Promise.resolve({ rowsAffected: 0 })),
  executeMany: mock.fn(() => Promise.resolve({ rowsAffected: 0 })),
  initializeSchema: mock.fn(() => Promise.resolve()),
  checkColumnExists: mock.fn(() => Promise.resolve(true)),
  detectCircularDependencies: mock.fn(() => Promise.resolve([])),
  detectGodObjects: mock.fn(() => Promise.resolve([])),
  detectDeadCode: mock.fn(() => Promise.resolve([])),
};

mock.module(path.join(srcDir, 'database/factory.js'), {
  namedExports: {
    createDatabaseAdapter: mock.fn(() => mockDbAdapter),
  },
});

const mockGenerateEmbedding = mock.fn(() => Promise.resolve([0.1, 0.2, 0.3]));

mock.module(path.join(srcDir, 'services/embeddingService.js'), {
  namedExports: {
    generateEmbedding: mockGenerateEmbedding,
    generateEmbeddingsBatch: mock.fn(() => Promise.resolve([[0.1, 0.2, 0.3]])),
  },
});

const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};

mock.module(path.join(srcDir, 'utils/context.js'), {
  namedExports: {
    authStorage: mockAuthStore,
  },
});

const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn(),
  debug: mock.fn(),
};

mock.module(path.join(srcDir, 'utils/logger.js'), {
  namedExports: {
    logger: mockLogger,
  },
});

const { OracleDreamingService } = await import(path.join(srcDir, 'services/dreamingService.js'));
