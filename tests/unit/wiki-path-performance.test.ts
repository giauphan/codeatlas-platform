import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IDatabaseAdapter } from '../../src/database/adapters/interface.js';
import { WikiService } from '../../src/services/wikiService.js';

test('wiki tree handles long parent paths ending in a slash promptly', async () => {
  const parent = `/${'a'.repeat(60_000)}/`;
  const db = { listWikiPages: async () => [{ path: '/child', parent_path: parent, title: 'Child' }] } as unknown as IDatabaseAdapter;
  const start = performance.now();
  const tree = await new WikiService(db).getWikiTree('test');
  assert.equal(tree.totalPages, 1);
  assert.ok(performance.now() - start < 1_000, 'parent title extraction must remain linear');
});
