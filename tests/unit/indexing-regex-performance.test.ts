import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexingService } from '../../src/services/indexingService.js';

test('indexing a long identifier without a call completes promptly', () => {
  const service = new IndexingService();
  const nodes: never[] = [];
  const links: never[] = [];
  const started = performance.now();
  service['parseTSJS']('a'.repeat(60_000), 'file.ts', 'module:file.ts', nodes, links);
  assert.deepEqual(links, []);
  assert.ok(performance.now() - started < 1_000, 'identifier scanning must remain linear');
});
