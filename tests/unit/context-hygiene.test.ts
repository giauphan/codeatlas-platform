import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoiseBlocklist } from '../../src/services/noiseBlocklist.js';

// Guards the inject-gate corpus: these are the exact content shapes that leaked
// into a live Claude session through the Second Brain retrieval hook. If a
// blocklist pattern is weakened, this fails before the noise reaches a prompt.
const CONTEXT_POLLUTERS: ReadonlyArray<readonly [string, string]> = [
  ['english lesson', 'ok vậy new lession today đi'],
  ['english word choice', 'Khi nào dùng raining and khi dùng rainy? Trong bài nói raining (adj)'],
  ['vietnamese grammar', 'sao để biết nào tính danh/danh/trạng/động ?'],
  ['weather note', 'raining weather but I like sunny weather'],
  ['shopping list', 'write a shopping list before going to the store'],
  ['grocery item', 'buy chicken breast or fish and low-fat milk and plain yogurt'],
  ['lifestyle note', 'I prefer to relax by reading a book and stay at home'],
  ['scheduler retry', '`--retry-failed` for YouTube and clear the stuck `scheduling` records for IG/FB'],
];

// Genuine engineering knowledge must survive the gate, otherwise the blocklist
// silently destroys the memory system's actual value.
const LEGITIMATE_MEMORIES: ReadonlyArray<readonly [string, string]> = [
  ['oracle pooling', 'Using a connection pool with initPool() avoids ORA-00001 collisions when upserting dream memories'],
  ['typescript choice', 'The team decided to use TypeScript strict mode across all modules to prevent unhandled runtime exceptions'],
  ['postgres rationale', 'We selected PostgreSQL for the adapter layer because pgvector supports cosine distance natively'],
  ['sqlite default', 'CODEATLAS_DB_TYPE defaults to sqlite so local onboarding needs no external database server'],
];

describe('context hygiene: inject-gate blocklist corpus', () => {
  for (const [label, content] of CONTEXT_POLLUTERS) {
    test(`blocks ${label} from reaching conversation context`, () => {
      const result = checkNoiseBlocklist(content);

      assert.equal(result.isNoise, true, `expected blocklist to reject: ${content}`);
      assert.match(String(result.reason), /^blocklist: /);
    });
  }

  for (const [label, content] of LEGITIMATE_MEMORIES) {
    test(`keeps ${label} available to conversation context`, () => {
      const result = checkNoiseBlocklist(content);

      assert.equal(result.isNoise, false, `expected blocklist to allow: ${content}`);
      assert.equal(result.reason, null);
    });
  }

  test('treats empty content as non-noise so callers handle it explicitly', () => {
    const result = checkNoiseBlocklist('   ');

    assert.equal(result.isNoise, false);
    assert.equal(result.reason, null);
  });
});
