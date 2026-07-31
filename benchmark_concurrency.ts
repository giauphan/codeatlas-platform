import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';

function getVersionSync() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version || "unknown";
  } catch {}
  return version;
}

async function getVersionAsync() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version || "unknown";
  } catch {}
  return version;
}

// Simulate CPU work to make the event loop busy
function doCpuWork(ms: number) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // block
  }
}

async function runConcurrencyBenchmark() {
  const concurrentRequests = 1000;
  console.log(`Running concurrency benchmark with ${concurrentRequests} simulated concurrent requests...`);

  // Warmup
  getVersionSync();
  await getVersionAsync();

  // Test synchronous blocking version
  const startSync = performance.now();
  const syncPromises = [];
  for (let i = 0; i < concurrentRequests; i++) {
    // In a real server, each request handler is added to the microtask queue
    syncPromises.push(new Promise<void>(resolve => {
        setImmediate(() => {
            getVersionSync();
            resolve();
        });
    }));
  }
  await Promise.all(syncPromises);
  const endSync = performance.now();

  // Test asynchronous non-blocking version
  const startAsync = performance.now();
  const asyncPromises = [];
  for (let i = 0; i < concurrentRequests; i++) {
    asyncPromises.push(new Promise<void>(resolve => {
        setImmediate(async () => {
            await getVersionAsync();
            resolve();
        });
    }));
  }
  await Promise.all(asyncPromises);
  const endAsync = performance.now();

  console.log(`Synchronous implementation (Concurrent): ${(endSync - startSync).toFixed(2)} ms`);
  console.log(`Asynchronous implementation (Concurrent): ${(endAsync - startAsync).toFixed(2)} ms`);

  // What really matters is Event Loop Delay
  console.log("\nMeasuring Event Loop Delay...");

  let maxDelaySync = -Infinity;
  let delayTimerSync = setInterval(() => {
    const delay = performance.now() - lastTickSync - 10;
    if (delay > maxDelaySync) maxDelaySync = delay;
    lastTickSync = performance.now();
  }, 10);
  let lastTickSync = performance.now();

  const delaySyncPromises = [];
  for (let i = 0; i < concurrentRequests; i++) {
    delaySyncPromises.push(new Promise<void>(resolve => {
        setImmediate(() => {
            getVersionSync();
            resolve();
        });
    }));
  }
  await Promise.all(delaySyncPromises);
  clearInterval(delayTimerSync);


  let maxDelayAsync = -Infinity;
  let delayTimerAsync = setInterval(() => {
    const delay = performance.now() - lastTickAsync - 10;
    if (delay > maxDelayAsync) maxDelayAsync = delay;
    lastTickAsync = performance.now();
  }, 10);
  let lastTickAsync = performance.now();

  const delayAsyncPromises = [];
  for (let i = 0; i < concurrentRequests; i++) {
    delayAsyncPromises.push(new Promise<void>(resolve => {
        setImmediate(async () => {
            await getVersionAsync();
            resolve();
        });
    }));
  }
  await Promise.all(delayAsyncPromises);
  clearInterval(delayTimerAsync);

  console.log(`Max Event Loop Delay (Sync): ${(maxDelaySync === -Infinity ? 0 : maxDelaySync).toFixed(2)} ms`);
  console.log(`Max Event Loop Delay (Async): ${(maxDelayAsync === -Infinity ? 0 : maxDelayAsync).toFixed(2)} ms`);
}

runConcurrencyBenchmark().catch(console.error);
