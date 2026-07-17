/**
 * TaskQueue E2E — validates queue cap, concurrency limit, timeout.
 *
 * Run:  node --import tsx --test tests/unit/utils/task-queue.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const MAX_QUEUED = 10;
const TASK_TIMEOUT_MS = 200;   // fast for tests

class TaskQueue {
  private queue: (() => Promise<any>)[] = [];
  private activeCount = 0;
  private maxConcurrency = 1;

  constructor(maxConcurrency: number = 1) {
    this.maxConcurrency = maxConcurrency;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= MAX_QUEUED) {
      return Promise.reject(new Error("Sync queue full — try again later"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.next();
    });
  }

  private next() {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) return;
    const task = this.queue.shift();
    if (task) {
      this.activeCount++;
      const timeoutId = setTimeout(() => {
        console.log("[TaskQueue] timeout fired, unblocking");
        this.activeCount--;
        this.next();
      }, TASK_TIMEOUT_MS);
      task().finally(() => {
        clearTimeout(timeoutId);
        this.activeCount--;
        this.next();
      });
    }
  }

  status() {
    return { queued: this.queue.length, active: this.activeCount };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("TaskQueue", () => {
  it("processes tasks sequentially (maxConcurrency=1)", async () => {
    const q = new TaskQueue(1);
    const order: number[] = [];
    const results = await Promise.all(
      [1, 2, 3].map((n, i) =>
        q.enqueue(async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
          return n;
        })
      )
    );
    assert.deepEqual(results, [1, 2, 3]);
    assert.deepEqual(order, [0, 1, 2]);
    assert.deepEqual(q.status(), { queued: 0, active: 0 });
  });

  it("rejects when queue exceeds MAX_QUEUED (10)", async () => {
    const q = new TaskQueue(1);

    // Tasks 1-10 fill the active slot + queue
    const staged = Array.from({ length: 11 }, (_, i) =>
      q.enqueue(async () => {
        await new Promise(() => {}); // never resolves (hung)
      })
    );

    // 1st is active, 10th reached MAX_QUEUED → 11th rejected
    // But staged[0] (the 1st enqueue) is active. queue fills from staged[1..10].
    // staged[11] would be the 12th → rejected
    // Actually: staged[0]=active(1), staged[1..10]=queued(10) → staged[10] hits >=10 → rejected
    // So staged[10] is the 11th enqueue → rejected

    // Count: 1 active + 10 queued = staging happens. staged[0]=active, staged[1..9]=queued
    // No wait… 1 active + queued=9 (staged[1..9]) = 10 total. staged[10] is 11th enqueue:
    // queue.length=9 < 10 → allowed → queued=10. staged[11] would be 12th → rejected
    // But we only staged 11 (indices 0-10). staged[10] is allowed, queue.length becomes 10.
    // So no rejection at all since we only did 11 enqueues and moved the boundary.

    // Actually, let's think: staged[0] → active (active=1, queued=0)
    // staged[1] → queued=1, staged[2] → queued=2, … staged[9] → queued=9
    // staged[10] (the 11th): queue.length=9, 9<10 → allowed → queued=10
    // Need a 12th to test rejection: staged[11] → queue.length=10, 10>=10 → rejected
    // So 11 enqueues all go through. Need 12.

    // Staged indicates index of 11th (0-indexed = 10) and 12th (=11).
    // We created 11 (0-10). 12th is needed for rejection.
    const oneMore = q.enqueue(async () => "never");
    await assert.rejects(oneMore, { message: /queue full/i });
    assert.deepEqual(q.status(), { active: 1, queued: 10 });
  });

  it("timeout unblocks queue after TASK_TIMEOUT_MS", async () => {
    const q = new TaskQueue(1);
    const started = Date.now();

    // First task hangs forever
    const p1 = q.enqueue(async () => { await new Promise(() => {}); });
    // Second task waits behind the timeout
    const p2 = q.enqueue(async () => "done");

    const result = await p2;
    assert.equal(result, "done");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 150, `Took ${elapsed}ms — expected >= 150ms (timeout waits for timeout)`);
  });

  it("new tasks enqueue after hung task times out", async () => {
    const q = new TaskQueue(1);
    // Hang
    q.enqueue(async () => { await new Promise(() => {}); });
    // Wait for timeout
    await new Promise((r) => setTimeout(r, 250));
    // Queue is now unblocked because timeout cleared activeCount
    const result = await q.enqueue(async () => "recovered");
    assert.equal(result, "recovered");
  });

  it("rejected task does not break the queue", async () => {
    const q = new TaskQueue(1);
    // First task throws
    const p1 = q.enqueue(async () => { throw new Error("boom"); });
    await assert.rejects(p1, { message: /boom/ });
    await new Promise((r) => setTimeout(r, 30));

    const result = await q.enqueue(async () => "still works");
    assert.equal(result, "still works");
  });

  it("many rapid enqueues — 30 requests on single slot", async () => {
    const q = new TaskQueue(1);
    const log: number[] = [];

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        q.enqueue(async () => {
          log.push(i);
          await new Promise((r) => setTimeout(r, 5));
          return i;
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    // 1 active + 10 queued = first 11 get in if all 30 try
    // Actually each finishes quickly (5ms), so many more get through
    assert.ok(fulfilled >= 11, `Expected >= 11 fulfilled, got ${fulfilled}`);
    assert.ok(rejected > 0, `Expected some rejections, got ${rejected}`);
    assert.deepEqual(q.status(), { queued: 0, active: 0 });
  });
});
