import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../src/presentation/httpServer.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('task queue does not release concurrency twice when timeout races task completion', async () => {
  const queue = new TaskQueue(1, 100);
  const first = deferred();
  const second = deferred();
  let secondStarted!: () => void;
  const secondHasStarted = new Promise<void>((resolve) => { secondStarted = resolve; });
  let thirdStarted = false;

  const firstRun = queue.enqueue(() => first.promise);
  const secondRun = queue.enqueue(() => {
    secondStarted();
    return second.promise;
  });

  // The first task times out, releasing the slot and starting the second task.
  await secondHasStarted;
  // Its late completion must not release the second task's slot as well.
  first.resolve();
  await firstRun;

  const thirdRun = queue.enqueue(async () => { thirdStarted = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(thirdStarted, false);

  second.resolve();
  await Promise.all([secondRun, thirdRun]);
  assert.equal(thirdStarted, true);
});

test('task queue reports rejected work through enqueue and continues with the next task', async () => {
  const queue = new TaskQueue(1, 100);
  await assert.rejects(queue.enqueue(async () => { throw new Error('task failed'); }), /task failed/);
  let nextTaskRan = false;
  await queue.enqueue(async () => { nextTaskRan = true; });
  assert.equal(nextTaskRan, true);
});
