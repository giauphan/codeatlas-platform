import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchedulerTickRunner } from '../../src/presentation/httpServer.js';

test('scheduler tick runner does not overlap a pending tick and resumes after it settles', async () => {
  let runs = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const run = createSchedulerTickRunner(async () => {
    runs++;
    await pending;
  });

  run();
  run();
  await Promise.resolve();
  assert.equal(runs, 1);

  release();
  await new Promise(resolve => setImmediate(resolve));
  run();
  await Promise.resolve();
  assert.equal(runs, 2);
});
