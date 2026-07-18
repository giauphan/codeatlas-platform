import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';

// Simulation of current synchronous implementation
function getVersionSync() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version || "unknown";
  } catch {}
  return version;
}

// Simulation of proposed asynchronous implementation
async function getVersionAsync() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf-8"));
    version = pkg.version || "unknown";
  } catch {}
  return version;
}

async function runBenchmark() {
  const iterations = 10000;
  console.log(`Running benchmark with ${iterations} iterations...`);

  // Warmup
  for (let i = 0; i < 100; i++) {
    getVersionSync();
    await getVersionAsync();
  }

  // Sync test
  const startSync = performance.now();
  for (let i = 0; i < iterations; i++) {
    getVersionSync();
  }
  const endSync = performance.now();
  const timeSync = endSync - startSync;
  console.log(`Synchronous implementation: ${timeSync.toFixed(2)} ms (${(timeSync / iterations).toFixed(4)} ms/op)`);

  // Async test
  const startAsync = performance.now();
  for (let i = 0; i < iterations; i++) {
    await getVersionAsync();
  }
  const endAsync = performance.now();
  const timeAsync = endAsync - startAsync;
  console.log(`Asynchronous implementation: ${timeAsync.toFixed(2)} ms (${(timeAsync / iterations).toFixed(4)} ms/op)`);

  if (timeAsync < timeSync) {
    console.log(`Async is faster by ${(timeSync - timeAsync).toFixed(2)} ms (${((timeSync - timeAsync) / timeSync * 100).toFixed(2)}%)`);
  } else {
    console.log(`Sync is faster by ${(timeAsync - timeSync).toFixed(2)} ms (${((timeAsync - timeSync) / timeAsync * 100).toFixed(2)}%)`);
  }

  console.log("\nNote: While pure execution time for async might be slightly slower in microbenchmarks due to Promise overhead, reading files synchronously in a Node.js server blocks the event loop, preventing all other requests from being processed while the disk I/O completes. In a concurrent server environment, replacing fs.readFileSync with fs.promises.readFile is a critical performance fix for scalability.");
}

runBenchmark().catch(console.error);
