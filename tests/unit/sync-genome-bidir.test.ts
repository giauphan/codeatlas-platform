import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createApiCall, getApiBase } from "../../scripts/sync-genome-bidir.ts";

test("sync API base requires HTTPS for public hosts and explicit opt-in for private hosts", () => {
  assert.equal(getApiBase("https://api.example.com", false, "https://api.example.com").origin, "https://api.example.com");
  assert.throws(() => getApiBase("https://attacker.example", false), /configured trusted API origin/);
  assert.throws(() => getApiBase("http://api.example.com", false, "http://api.example.com"), /must match.*HTTPS/);
  assert.throws(() => getApiBase("https://169.254.169.254", false, "https://169.254.169.254"), /private hosts require/);
  assert.equal(getApiBase("https://10.0.0.4", true, "https://10.0.0.4").origin, "https://10.0.0.4");
  assert.equal(getApiBase("http://10.0.0.4", true, "http://10.0.0.4").origin, "http://10.0.0.4");
});

test("sync API calls reject redirects and preserve the configured base path", async (t) => {
  let redirectedRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === "/prefix/redirect") {
      response.writeHead(302, { location: "/target" }).end();
      return;
    }
    if (request.url === "/target") redirectedRequestCount++;
    response.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const apiBase = `http://127.0.0.1:${address.port}/prefix`;
  const apiCall = createApiCall(getApiBase(apiBase, false, apiBase), "test-api-key");

  await assert.rejects(apiCall("/redirect"));
  assert.equal(redirectedRequestCount, 0);
});

test('sync API joins long base paths without quadratic trailing-slash scans', async () => {
  const pathname = `/prefix${'/'.repeat(60_000)}x`;
  let requestedPath = '';
  const apiCall = createApiCall(new URL(`https://api.example.com${pathname}`), 'key', async (input) => {
    requestedPath = new URL(String(input)).pathname;
    return new Response(null, { status: 204 });
  });
  const start = performance.now();
  await apiCall('/gene');
  assert.equal(requestedPath, `${pathname}/gene`);
  assert.ok(performance.now() - start < 1_000, 'path joining must not rescan long paths');
});

test('malformed remote gene collections cannot inject log lines', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ genes: { length: '1\nFORGED LOG ENTRY' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sync-genome-bidir.ts', 'synthetic-key', origin, 'download'], {
    env: { ...process.env, CODEATLAS_API_URL: origin, CODEATLAS_ALLOW_PRIVATE_API_URL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(code, 0);
  assert.doesNotMatch(output, /FORGED LOG ENTRY/);
});

test('remote upload errors cannot inject log lines', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: false, error: 'remote failure\nFORGED LOG ENTRY' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sync-genome-bidir.ts', 'synthetic-key', origin, 'upload'], {
    env: { ...process.env, CODEATLAS_API_URL: origin, CODEATLAS_ALLOW_PRIVATE_API_URL: '1', HOME: '/nonexistent-codeatlas-home' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.doesNotMatch(output, /\nFORGED LOG ENTRY/);
  assert.match(output, /remote failure FORGED LOG ENTRY/);
});

test('upload sends requests serially and prints skills in enumeration order', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-sync-home-'));
  const skillsDir = path.join(home, '.hermes', 'skills');
  for (const name of ['charlie', 'alpha', 'bravo']) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `description: "${name} description"\ncategory: workflow\n`);
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let activeRequests = 0;
  let maxActiveRequests = 0;
  const requestNames: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as { name: string };
      requestNames.push(payload.name);
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      setTimeout(() => {
        activeRequests--;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
      }, 15);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sync-genome-bidir.ts', 'synthetic-key', origin, 'upload'], {
    env: { ...process.env, HOME: home, CODEATLAS_API_URL: origin, CODEATLAS_ALLOW_PRIVATE_API_URL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  const expectedNames = fs.readdirSync(skillsDir).filter(name =>
    fs.existsSync(path.join(skillsDir, name, 'SKILL.md')),
  );
  assert.equal(code, 0);
  assert.deepEqual(requestNames, expectedNames);
  assert.equal(maxActiveRequests, 1);
  const outputPositions = expectedNames.map(name => output.indexOf(`  ${name}... OK`));
  assert.ok(outputPositions.every(position => position >= 0));
  assert.deepEqual(outputPositions, [...outputPositions].sort((a, b) => a - b));
});
