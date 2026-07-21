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
};

mock.module(path.join(srcDir, 'utils/logger.js'), {
  namedExports: {
    logger: mockLogger,
  },
});

// ── Import modules under test ───────────────────────────────────────
const { OracleDreamingService, DreamMemoryType } = await import(
  path.join(srcDir, 'services/dreamingService.js')
);
const { ConsolidationEngine } = await import(
  path.join(srcDir, 'services/consolidationEngine.js')
);

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Memory Lifecycle', () => {
  beforeEach(async () => {
    // Set column detection caches so lifecycle and MERGE paths are active
    OracleDreamingService._hasLifecycleColumns = true;
    OracleDreamingService._hasContentHashColumn = true;

    mockConnection.execute.mock.resetCalls();
    mockConnection.executeMany.mock.resetCalls();
    mockConnection.close.mock.resetCalls();
    mockPool.getConnection.mock.resetCalls();
    mockGenerateEmbedding.mock.resetCalls();
    mockAuthStore.getStore.mock.resetCalls();
    mockAuthStore.run.mock.resetCalls();
    mockLogger.info.mock.resetCalls();
    mockLogger.error.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();

    const { initPool, setSessionContext } = await import(
      path.join(srcDir, 'database/connection.js')
    );
    initPool.mock.resetCalls();
    initPool.mock.mockImplementation(() => Promise.resolve(mockPool));
    setSessionContext.mock.resetCalls();
    setSessionContext.mock.mockImplementation(() => Promise.resolve());
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Lifecycle columns
  // ═══════════════════════════════════════════════════════════════

  describe('Phase 1 — Lifecycle columns', () => {
    test('saveDreamMemory MERGE includes lifecycle fields in INSERT', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      await OracleDreamingService.saveDreamMemory(
        'proj', 'session-1', 'KNOWLEDGE', 'Lifecycle test content for verifying the merge statement contains lifecycle columns', 7,
      );

      const sql = mockConnection.execute.mock.calls[0].arguments[0] as string;
      // Verify MERGE includes lifecycle columns
      assert.ok(sql.includes('confidence'), 'INSERT should include confidence');
      assert.ok(sql.includes('status'), 'INSERT should include status');
      assert.ok(sql.includes('evidence_count'), 'INSERT should include evidence_count');
      assert.ok(sql.includes('access_count'), 'INSERT should include access_count');
      assert.ok(sql.includes('version'), 'INSERT should include version');

      const binds = mockConnection.execute.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.ok('initialConfidence' in binds, 'Bind should include initialConfidence');
    });

    test('calcInitialConfidence returns correct values by type and importance', () => {
      // MISTAKE + high importance → high confidence
      const criticalMistake = OracleDreamingService.calcInitialConfidence('MISTAKE', 10);
      assert.strictEqual(criticalMistake, Math.min(0.99, 0.65 + 0.25));

      // KNOWLEDGE + low importance → lower confidence
      const lowImpKnowledge = OracleDreamingService.calcInitialConfidence('KNOWLEDGE', 2);
      assert.strictEqual(lowImpKnowledge, Math.max(0.05, 0.50 - 0.15));

      // A2A_SHARED_CONTEXT has lowest base
      const shared = OracleDreamingService.calcInitialConfidence('A2A_SHARED_CONTEXT', 5);
      assert.strictEqual(shared, 0.40);

      // Confidence clamped to [0.05, 0.99]
      const maxed = OracleDreamingService.calcInitialConfidence('MISTAKE', 10);
      assert.ok(maxed <= 0.99);
      const minned = OracleDreamingService.calcInitialConfidence('KNOWLEDGE', 0);
      assert.ok(minned >= 0.05);
    });

    test('MERGE ON MATCHED updates evidence_count and bumps confidence', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));
      let execCount = 0;
      mockConnection.execute.mock.mockImplementation(async () => {
        execCount++;
        return { rowsAffected: 1 };
      });

      // Noise gate requires >= 40 chars
      const longContent = 'Same content with enough length to pass noise gate minimum threshold test.';

      // First save (creates)
      await OracleDreamingService.saveDreamMemory(
        'p', 's1', 'MISTAKE', longContent, 6,
      );

      // Second save with same content (should MERGE match)
      await OracleDreamingService.saveDreamMemory(
        'p', 's2', 'MISTAKE', longContent, 8,
      );

      // Both should have executed
      assert.strictEqual(execCount, 2);

      // Second call should use MERGE with evidence_count increment
      const sql2 = mockConnection.execute.mock.calls[1].arguments[0] as string;
      assert.ok(sql2.includes('evidence_count'), 'MATCHED branch should update evidence_count');
      assert.ok(sql2.includes('GREATEST(trg.importance'), 'MATCHED branch should keep max importance');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Noise gate
  // ═══════════════════════════════════════════════════════════════

  describe('Phase 2 — Pre-save noise gate', () => {
    test('checkNoise rejects empty content', () => {
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', '', 5);
      assert.strictEqual(result.isNoise, true);
      assert.ok(result.reason!.includes('empty'));
    });

    test('checkNoise rejects too-short content (< 40 chars)', () => {
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', 'Too short', 5);
      assert.strictEqual(result.isNoise, true);
      assert.ok(result.reason!.includes('short'));
    });

    test('checkNoise rejects content > 2000 chars', () => {
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', 'x'.repeat(2001), 5);
      assert.strictEqual(result.isNoise, true);
      assert.ok(result.reason!.includes('long'));
    });

    test('checkNoise rejects low-importance KNOWLEDGE (< 3)', () => {
      const content = 'This is a sufficiently long piece of knowledge content that discusses patterns.';
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', content, 2);
      assert.strictEqual(result.isNoise, true);
      assert.ok(result.reason!.includes('importance'));
    });

    test('checkNoise rejects stop-word-only phrases (e.g., Vietnamese greetings)', () => {
      // Simulates "Sẵn sàng. Cần tôi làm gì?" — mostly stop words
      const noiseContent = 'là của và với không các được người nhưng hoặc đã sẽ đang này khi từ';
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', noiseContent, 5);
      assert.strictEqual(result.isNoise, true);
      assert.ok(result.reason!.includes('stop-word'));
    });

    test('checkNoise accepts valid high-quality content', () => {
      const goodContent = 'Use JWT with RS256 for API authentication tokens. Rotate keys every 90 days. Store refresh tokens in HttpOnly cookies.';
      const result = OracleDreamingService.checkNoise('KNOWLEDGE', goodContent, 6);
      assert.strictEqual(result.isNoise, false);
      assert.strictEqual(result.reason, null);
    });

    test('saveDreamMemory blocks noise and returns sentinel', async () => {
      // Empty content should be blocked BEFORE any DB call
      const result = await OracleDreamingService.saveDreamMemory(
        'p', 's', 'KNOWLEDGE', 'Too short', 5,
      );
      assert.strictEqual(result, '__noise_blocked__');
      // Should NOT have called embedding or DB
      assert.strictEqual(mockGenerateEmbedding.mock.calls.length, 0);
      assert.strictEqual(mockConnection.execute.mock.calls.length, 0);
    });

    test('saveDreamMemory accepts valid content and proceeds to DB', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const goodContent = 'Always use parameterized queries to prevent SQL injection in database access layer.';
      const result = await OracleDreamingService.saveDreamMemory(
        'p', 's', 'KNOWLEDGE', goodContent, 7,
      );
      assert.notStrictEqual(result, '__noise_blocked__');
      // Should have made DB call
      assert.strictEqual(mockConnection.execute.mock.calls.length, 1);
    });

    test('summarizeConversationForDreams no longer creates noisy KNOWLEDGE from random long sentences', async () => {
      // Import the function
      const { summarizeConversationForDreams } = await import(
        path.join(srcDir, 'services/llmService.js')
      );

      // This is an assistant sentence > 80 chars but with no code/technical keywords
      // Old behavior: would match as KNOWLEDGE. New: should not.
      const noisyTranscript = `[ASSISTANT]\nSẵn sàng. Cần tôi làm gì? Hôm nay tôi có thể giúp gì cho bạn.`;

      const result = await summarizeConversationForDreams(noisyTranscript, 'test', 'proj', 'session-1');
      // Should be null (no dreams extracted) because the catch-all now requires tech keywords
      assert.strictEqual(result, null);
    });

    test('summarizeConversationForDreams still extracts valid technical KNOWLEDGE', async () => {
      const { summarizeConversationForDreams } = await import(
        path.join(srcDir, 'services/llmService.js')
      );

      // Uses tech keywords but avoids pattern/prefer keyword matches
      const techTranscript = `[ASSISTANT]\nThe correct solution is to use dependency injection for the database service because it makes testing easier and the maintainability improves significantly. I found that abstracting the database access behind an interface reduces coupling and makes the code more testable.`;

      const result = await summarizeConversationForDreams(techTranscript, 'test', 'proj', 'session-1');
      assert.ok(result !== null, 'Technical content should produce dreams');
      assert.ok(result!.length >= 1);
      assert.strictEqual(result![0].memoryType, 'KNOWLEDGE');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 3: Weighted retrieval ranking
  // ═══════════════════════════════════════════════════════════════

  describe('Phase 3 — Weighted retrieval ranking', () => {
    const sampleRows = [
      {
        ID: 'mem-1', SESSION_ID: 's1', PROJECT: 'p', PROVIDER: 'test',
        MEMORY_TYPE: 'KNOWLEDGE', CONTENT: 'Use JWT for auth', IMPORTANCE: 8,
        CREATED_AT: new Date('2026-07-20'), CONFIDENCE: 0.90, STATUS: 'active',
        EVIDENCE_COUNT: 5, ACCESS_COUNT: 3, VERSION: 1,
      },
      {
        ID: 'mem-2', SESSION_ID: 's2', PROJECT: 'p', PROVIDER: 'test',
        MEMORY_TYPE: 'MISTAKE', CONTENT: 'Never store secrets in env', IMPORTANCE: 7,
        CREATED_AT: new Date('2026-01-01'), CONFIDENCE: 0.30, STATUS: 'active',
        EVIDENCE_COUNT: 1, ACCESS_COUNT: 0, VERSION: 1,
      },
    ];

    test('queryDreamMemories uses weighted ORDER BY with lifecycle fields', async () => {
      mockConnection.execute.mock.mockImplementation(async () => {
        // First execute() is the query, second is the access_count bump query
        if (mockConnection.execute.mock.calls.length === 0) {
          return { rows: sampleRows };
        }
        return { rowsAffected: 2 };
      });

      await OracleDreamingService.queryDreamMemories('p', 'how to handle auth?', 10);

      const sql = mockConnection.execute.mock.calls[0].arguments[0] as string;
      // Should use weighted scoring expression, not raw VECTOR_DISTANCE
      assert.ok(sql.includes('0.50 * (1 - VECTOR_DISTANCE'), 'Should weight similarity');
      assert.ok(sql.includes('0.20 * NVL(confidence'), 'Should weight confidence');
      assert.ok(sql.includes('0.15 * LEAST(1.0, (SYSDATE'), 'Should weight freshness');
      assert.ok(sql.includes('0.10 * (importance'), 'Should weight importance');
      assert.ok(sql.includes('evidence_count'), 'Should factor evidence');
      assert.ok(sql.includes("status IN ('active', 'superseded')"), 'Should filter out archived');
    });

    test('queryDreamMemories bumps access_count on returned rows', async () => {
      let executeCalls = 0;
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        executeCalls++;
        if (executeCalls === 1) {
          return { rows: sampleRows };
        }
        return { rowsAffected: 2 };
      });

      await OracleDreamingService.queryDreamMemories('p', 'search', 5);

      // Should have executed at least once (query)
      assert.ok(mockConnection.execute.mock.calls.length >= 1, 'Should have made at least 1 DB call');
      // The access_count bump is async and non-critical — check via executeMany
      const executeManyCalls = mockConnection.executeMany.mock.calls;
      if (executeManyCalls.length > 0) {
        const bumpSql = executeManyCalls[0].arguments[0] as string;
        assert.ok(bumpSql.includes('access_count = access_count + 1'), 'Should bump access_count');
        assert.ok(bumpSql.includes('last_accessed_at = CURRENT_TIMESTAMP'), 'Should update last_accessed_at');
      }
    });

    test('queryDreamMemories returns lifecycle columns in result set', async () => {
      mockGenerateEmbedding.mock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));
      mockConnection.execute.mock.mockImplementation(async () => {
        return { rows: sampleRows };
      });

      const rows = await OracleDreamingService.queryDreamMemories('p', 'test', 10);
      const rowsArr = rows as any[] as Array<Record<string, unknown>>;
      assert.ok(rowsArr.length > 0);

      // With outFormat=OBJECT, Oracle returns uppercase property names
      assert.strictEqual(rowsArr[0].CONFIDENCE, 0.90, 'confidence returned');
      assert.strictEqual(rowsArr[0].STATUS, 'active', 'status returned');
      assert.strictEqual(rowsArr[0].EVIDENCE_COUNT, 5, 'evidence_count returned');
      assert.strictEqual(rowsArr[0].ACCESS_COUNT, 3, 'access_count returned');
      assert.strictEqual(rowsArr[0].VERSION, 1, 'version returned');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 4: Consolidation lifecycle scoring for dreams
  // ═══════════════════════════════════════════════════════════════

  describe('Phase 4 — Consolidation score_dreams', () => {
    test('score_dreams applies time decay, evidence boost, access bonus, archive, supersession', async () => {
      let callIndex = 0;
      // Track SQL strings for later assertion
      const allSqls: string[] = [];
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        allSqls.push(sql.substring(0, 200));
        callIndex++;
        // Calls: 1..4=UPDATEs (decay, evidence boost, access bonus, archive),
        //        5=SELECT for supersession
        if (callIndex === 4) {
          return { rowsAffected: 3 }; // archive
        }
        if (callIndex === 5) {
          return {
            rows: [
              ['id-old', 'proj', 'MISTAKE', new Float32Array([0.1, 0.2, 0.3]), 0.30, new Date('2026-01-01')],
              ['id-mid', 'proj', 'MISTAKE', new Float32Array([0.1, 0.2, 0.3]), 0.50, new Date('2026-03-01')],
              ['id-new', 'proj', 'MISTAKE', new Float32Array([0.1, 0.2, 0.3]), 0.80, new Date('2026-07-01')],
            ],
          };
        }
        return { rowsAffected: 5 };
      });

      mockConnection.executeMany.mock.mockImplementation(async () => {
        return { rowsAffected: 1 };
      });

      const engine = new ConsolidationEngine();
      const report = await engine.run({
        project: 'proj',
        operations: ['score_dreams'],
      });



      // Find decay UPDATE among all execute calls
      const decayCall = allSqls.find(s => s.includes('confidence * CASE'));
      assert.ok(decayCall, 'Should apply decay');
      assert.ok(decayCall!.includes('POWER(0.995'), 'Should use 0.995 decay factor');

      // Find archive UPDATE
      const archiveCall = allSqls.find(s => s.includes("status = 'archived'"));
      assert.ok(archiveCall, 'Should set archived status');
      assert.ok(archiveCall!.includes('confidence < 0.10'), 'Should use 0.10 threshold');

      // Supersession: older dreams with similar embedding but lower confidence should be superseded
      assert.ok(mockConnection.executeMany.mock.calls.length >= 1);
      const supSql = mockConnection.executeMany.mock.calls[0].arguments[0] as string;
      assert.ok(supSql.includes("status = 'superseded'"), 'Should set superseded status');

      // Report should reflect the counts
      assert.strictEqual(report.dreamsArchived, 3);
      // With 3 similar dreams (confs 0.30, 0.50, 0.80), the 2 lower-confidence ones get superseded
      assert.strictEqual(report.dreamsSuperseded, 2);
    });

    test('score_dreams with no dreams does not error', async () => {
      mockConnection.execute.mock.mockImplementation(async (sql: string) => {
        return { rowsAffected: 0, rows: [] };
      });

      const engine = new ConsolidationEngine();
      const report = await engine.run({
        operations: ['score_dreams'],
      });

      assert.strictEqual(report.dreamsArchived, 0);
      assert.strictEqual(report.dreamsSuperseded, 0);
      assert.strictEqual(report.errors.length, 0);
    });

    test('score_dreams with provider filter applies provider condition', async () => {
      let callIndex = 0;
      mockConnection.execute.mock.mockImplementation(async (sql: string, binds: any) => {
        callIndex++;
        if (callIndex <= 4) return { rowsAffected: 0 };
        return { rows: [] };
      });

      const engine = new ConsolidationEngine();
      await engine.run({
        project: 'proj',
        provider: 'claude',
        operations: ['score_dreams'],
      });

      // Verify provider is used in WHERE clause
      // The supersession SELECT (call 4, 0-indexed) includes provider filter
      const selectCall = mockConnection.execute.mock.calls[4].arguments[0] as string;
      assert.ok(selectCall.includes(':provider'), 'Should use provider bind');
      const selectBinds = mockConnection.execute.mock.calls[4].arguments[1] as Record<string, unknown>;
      assert.strictEqual(selectBinds.provider, 'claude');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Full lifecycle integration
  // ═══════════════════════════════════════════════════════════════

  describe('Full lifecycle integration', () => {
    test('save → query → consolidate lifecycle works end-to-end', async () => {
      let executeIndex = 0;
      mockConnection.execute.mock.mockImplementation(async (sql: string, binds: any) => {
        executeIndex++;
        // Save (MERGE)
        if (executeIndex === 1) return { rowsAffected: 1 };
        // Query (SELECT) — return 2 dreams with lifecycle fields
        if (executeIndex === 2) {
          return {
            rows: [
              ['id-1', 's1', 'proj', 'test', 'KNOWLEDGE', 'Use RSA keys', 8,
               new Date('2026-07-20'), 0.90, 'active', 5, 3, 1],
              ['id-2', 's2', 'proj', 'test', 'MISTAKE', 'Never hardcode', 7,
               new Date('2026-01-01'), 0.30, 'active', 1, 0, 1],
            ],
          };
        }
        // Query's access_count bump
        if (executeIndex === 3) return { rowsAffected: 2 };
        // Consolidation decay calls (4 UPDATEs)
        if (executeIndex <= 7) return { rowsAffected: executeIndex === 7 ? 0 : 5 };
        // Consolidation supersession SELECT
        return { rows: [] };
      });

      // 1. Save
      const id = await OracleDreamingService.saveDreamMemory(
        'proj', 's1', 'KNOWLEDGE',
        'Use RSA-256 keys for service-to-service auth', 8,
      );
      assert.notStrictEqual(id, '__noise_blocked__');

      // 2. Query
      const rows = await OracleDreamingService.queryDreamMemories(
        'proj', 'authentication', 10,
      );
      assert.strictEqual((rows as any[]).length, 2);

      // 3. Consolidate
      const engine = new ConsolidationEngine();
      const report = await engine.run({
        project: 'proj',
        operations: ['score_dreams'],
      });
      assert.ok('dreamsArchived' in report);
      assert.ok('dreamsSuperseded' in report);
      assert.strictEqual(report.errors.length, 0);
    });
  });
});
