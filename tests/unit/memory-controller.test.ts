import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import {
  MemoryController,
  getMemoryStatus,
  syncMemory,
  disableMemoryAutoLoad,
  enableMemoryAutoLoad,
  resetMemory,
  reloadMemory,
  getMemoryState
} from '../../src/services/memoryController.js';

import { DreamingService } from '../../src/services/dreamingService.js';
import { MemoryService } from '../../src/services/memoryService.js';

describe('MemoryController Unit Tests', () => {
  beforeEach(() => {
    resetMemory();
    enableMemoryAutoLoad();
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('autoInitialize()', () => {
    test('initializes all memory subsystems successfully', async () => {
      mock.method(DreamingService, 'initialize', async () => {});
      mock.method(MemoryService, 'saveEpisodicMemory', async () => ({ id: 'ep-1' }));

      await MemoryController.autoInitialize();

      const status = getMemoryStatus();
      assert.strictEqual(status.dreamMemory, true);
      assert.strictEqual(status.semanticMemory, true);
      assert.strictEqual(status.episodicMemory, true);
      assert.strictEqual(status.error, null);
      assert.strictEqual(MemoryController.isHealthy(), true);
    });

    test('handles partial failure gracefully when DreamingService fails', async () => {
      mock.method(DreamingService, 'initialize', async () => {
        throw new Error('Dream init failed');
      });
      mock.method(MemoryService, 'saveEpisodicMemory', async () => ({ id: 'ep-1' }));

      await MemoryController.autoInitialize();

      const status = getMemoryStatus();
      assert.strictEqual(status.dreamMemory, false);
      assert.strictEqual(status.semanticMemory, true);
      assert.strictEqual(status.episodicMemory, true);
      assert.strictEqual(status.error, 'Dream init failed');
      assert.strictEqual(MemoryController.isHealthy(), false);
    });

    test('handles partial failure gracefully when Episodic Memory fails', async () => {
      mock.method(DreamingService, 'initialize', async () => {});
      mock.method(MemoryService, 'saveEpisodicMemory', async () => {
        throw new Error('Episodic init failed');
      });

      await MemoryController.autoInitialize();

      const status = getMemoryStatus();
      assert.strictEqual(status.dreamMemory, true);
      assert.strictEqual(status.semanticMemory, true);
      assert.strictEqual(status.episodicMemory, false);
      assert.strictEqual(status.error, 'Episodic init failed');
    });

    test('skips initialization when auto-load is disabled', async () => {
      let dreamCalled = false;
      mock.method(DreamingService, 'initialize', async () => {
        dreamCalled = true;
      });

      disableMemoryAutoLoad();
      await MemoryController.autoInitialize();

      assert.strictEqual(dreamCalled, false);
      assert.strictEqual(getMemoryStatus().autoLoadEnabled, false);
    });
  });

  describe('manualInitialize() and reload()', () => {
    test('executes manual initialization', async () => {
      mock.method(DreamingService, 'initialize', async () => {});
      mock.method(MemoryService, 'saveEpisodicMemory', async () => ({ id: 'ep-1' }));

      const status = await MemoryController.manualInitialize('my-project');

      assert.strictEqual(status.syncCount, 2);
      assert.ok(status.lastSync instanceof Date);
      assert.strictEqual(status.error, null);
    });

    test('reload() forces full re-initialization', async () => {
      mock.method(DreamingService, 'initialize', async () => {});
      mock.method(MemoryService, 'saveEpisodicMemory', async () => ({ id: 'ep-1' }));

      const status = await reloadMemory();

      assert.strictEqual(status.dreamMemory, true);
      assert.strictEqual(status.error, null);
    });
  });

  describe('syncProjectMemory()', () => {
    test('synchronizes project business rules and change logs', async () => {
      const episodicSaves: any[] = [];
      mock.method(MemoryService, 'saveEpisodicMemory', async (proj: string, type: string, data: any) => {
        episodicSaves.push({ proj, type, data });
        return { id: 'ep-1' };
      });

      const result = await syncMemory('test-proj', 'Fixed rate limiting issue', 'Do not exceed API quotas');

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.project, 'test-proj');
      assert.strictEqual(episodicSaves.length, 2);
      assert.strictEqual(episodicSaves[0].type, 'BUSINESS_RULE');
      assert.strictEqual(episodicSaves[1].type, 'CHANGE_LOG');
      assert.strictEqual(getMemoryStatus().syncCount, 1);
    });

    test('handles errors during sync without throwing', async () => {
      mock.method(MemoryService, 'saveEpisodicMemory', async () => {
        throw new Error('Database write error');
      });

      const result = await syncMemory('test-proj', 'Some change');

      assert.strictEqual(result.success, false);
      assert.match(result.message, /Database write error/);
      assert.strictEqual(getMemoryStatus().error, 'Database write error');
    });
  });

  describe('Utility methods and State management', () => {
    test('resetMemory clears error and counters', () => {
      getMemoryState.error = 'Some fatal error';
      getMemoryState.syncCount = 5;

      resetMemory();

      const status = getMemoryStatus();
      assert.strictEqual(status.error, null);
      assert.strictEqual(status.syncCount, 0);
      assert.strictEqual(status.lastSync, null);
    });
  });
});
