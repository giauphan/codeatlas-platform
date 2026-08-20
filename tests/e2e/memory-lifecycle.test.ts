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
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const exportsObj = 'default' in mockObj
    ? mockObj
    : { __esModule: true, default: mockObj, ...mockObj };
  const opts = { exports: exportsObj };

  const specs = new Set<string>([specifier]);

  if (!specifier.startsWith('/') && !specifier.startsWith('.')) {
    specs.add(specifier);
    specs.add(specifier + '/index.js');
    specs.add(specifier + '/lib/index.js');
  } else if (specifier.startsWith('/')) {
    const rawBasePath = specifier.endsWith('.js')
      ? specifier.slice(0, -3)
      : specifier.endsWith('.ts')
        ? specifier.slice(0, -2)
        : specifier;

    const basePaths = new Set<string>([rawBasePath]);
    if (rawBasePath.includes('/src/')) {
      basePaths.add(rawBasePath.replace('/src/', '/dist/'));
      basePaths.add(rawBasePath.replace('/src/', '/dist/src/'));
    }
    if (rawBasePath.includes('/dist/src/')) {
      basePaths.add(rawBasePath.replace('/dist/src/', '/src/'));
    }
    if (rawBasePath.includes('/dist/')) {
      basePaths.add(rawBasePath.replace('/dist/', '/src/'));
    }

    for (const b of basePaths) {
      for (const ext of ['', '.js', '.ts']) {
        const p = b + ext;
        specs.add(p);
        specs.add(pathToFileURL(p).href);
        try {
          if (fs.existsSync(p)) {
            const realP = fs.realpathSync(p);
            specs.add(realP);
            specs.add(pathToFileURL(realP).href);
          }
        } catch {}
      }
    }

    if (rawBasePath.includes('/src/')) {
      const srcIdx = rawBasePath.indexOf('/src/');
      const subPathBase = rawBasePath.slice(srcIdx + 5);
      for (const prefix of ['./', '../', '../../', '../../../', 'src/']) {
        for (const ext of ['', '.js', '.ts']) {
          specs.add(prefix + subPathBase + ext);
        }
      }
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

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

const oracleMock = {
  OUT_FORMAT_OBJECT: 4001,
  CLOB: 2011,
  STRING: 2001,
  DB_TYPE_JSON: 2007,
  createPool: mock.fn(() => Promise.resolve(mockPool)),
  initOracleClient: mock.fn(),
  outFormat: undefined as unknown,
  fetchAsString: [] as number[],
  default: {},
};
safeMockModule('oracledb', oracleMock);

const connMock = {
  initPool: mock.fn(() => Promise.resolve(mockPool)),
  setSessionContext: mock.fn(() => Promise.resolve()),
};
safeMockModule(path.join(srcDir, 'database/connection.js'), connMock);

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

const factoryMock = {
  createDatabaseAdapter: mock.fn(() => mockDbAdapter),
};
safeMockModule(path.join(srcDir, 'database/factory.js'), factoryMock);

const mockGenerateEmbedding = mock.fn(() => Promise.resolve([0.1, 0.2, 0.3]));
const embeddingMock = {
  generateEmbedding: mockGenerateEmbedding,
  generateEmbeddingsBatch: mock.fn(() => Promise.resolve([[0.1, 0.2, 0.3]])),
};
safeMockModule(path.join(srcDir, 'services/embeddingService.js'), embeddingMock);

const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user', tier: 'enterprise', keyId: 'test-key' })),
  run: mock.fn((_store: unknown, fn: () => unknown) => fn()),
};
const contextMock = {
  authStorage: mockAuthStore,
};
safeMockModule(path.join(srcDir, 'utils/context.js'), contextMock);

const mockLogger = {
  info: mock.fn(),
  error: mock.fn(),
  warn: mock.fn(),
  debug: mock.fn(),
};
const loggerMock = {
  logger: mockLogger,
};
safeMockModule(path.join(srcDir, 'utils/logger.js'), loggerMock);

const mockCheckAuth = async () => ({ tier: 'enterprise', uid: 'test-user', keyId: 'test-key' });
const authServiceMock = { checkAuth: mockCheckAuth };
safeMockModule(path.join(srcDir, 'services/authService.js'), authServiceMock);

const { OracleDreamingService } = await import(path.join(srcDir, 'services/dreamingService.js'));
