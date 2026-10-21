/** Run with npm run test:memory-pipeline after building the sibling MCP repo. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const repo = path.resolve(import.meta.dirname, '../..');
const mcpRepo = process.env.CODEATLAS_MCP_REPO || path.resolve(repo, '../codeatlas-mcp-server');
const cli = path.join(mcpRepo, 'dist/index.js');
const temp = mkdtempSync(path.join(tmpdir(), 'codeatlas-memory-canary-'));
const originalCwd = process.cwd();
// Preserve only provider authentication in memory before isolating HOME. Loading
// the operator's complete settings would also enable their production hooks.
const providerEnv: NodeJS.ProcessEnv = {};
let providerModel = 'haiku';
if (process.env.CODEATLAS_LIVE_HOST_TEST === '1') {
  let hostSettings: { env?: Record<string, string>; model?: string } = {};
  try {
    hostSettings = JSON.parse(readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'), 'settings.json'), 'utf8'));
  } catch { /* Process authentication can be sufficient. */ }
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    const value = process.env[name] || hostSettings.env?.[name];
    if (typeof value === 'string' && value) providerEnv[name] = value;
  }
  const configuredModel = process.env.CODEATLAS_LIVE_HOST_MODEL || hostSettings.model || providerEnv.ANTHROPIC_MODEL || providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  if (typeof configuredModel === 'string' && /^[A-Za-z0-9._:/-]+$/.test(configuredModel)) providerModel = configuredModel;
}
const project = path.join(temp, 'project-a');
const home = path.join(temp, 'home');
mkdirSync(project);
mkdirSync(home);
execFileSync('git', ['init', '--quiet', project]);
process.env.HOME = home;
process.env.CODEATLAS_SQLITE_PATH = path.join(temp, 'canary.db');
process.env.CODEATLAS_DB_TYPE = 'sqlite';
process.env.CODEATLAS_USE_FIRESTORE = 'false';
process.env.CODEATLAS_PROJECTS_ROOT = path.join(temp, 'tenants');
process.env.CODEATLAS_API_KEY = 'synthetic-canary-key';
process.env.API_KEY_PEPPER = 'synthetic-canary-pepper';
for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[name];
process.chdir(temp);

const express = (await import('express')).default;
const { SQLiteAdapter } = await import('../../src/database/adapters/sqliteAdapter.js');
const { setDatabaseAdapter } = await import('../../src/database/factory.js');
const { DreamingService } = await import('../../src/services/dreamingService.js');
const { registerDreamingRoutes } = await import('../../src/presentation/dreamingRoutes.js');
const db = new SQLiteAdapter(process.env.CODEATLAS_SQLITE_PATH);
setDatabaseAdapter(db);
let server: Server | undefined;
let baseUrl = '';
let failIngestion = false;
let dropIngestAck = false;
let holdIngestAck = false;
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
const configuredHookBudgetMs = Number(process.env.CODEATLAS_CANARY_HOOK_BUDGET_MS);
const hookCompletionBudgetMs = Number.isFinite(configuredHookBudgetMs) && configuredHookBudgetMs > 0
  ? Math.min(60_000, Math.floor(configuredHookBudgetMs))
  : 20_000;
const hookLatencySamples: Array<{ command: string; event_type: string; elapsed_ms: number }> = [];
const safeHookEventTypes = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact']);

before(async () => {
  assert.ok(readFileSync(cli).length > 0, 'Build sibling MCP CLI before running this acceptance suite');
  execFileSync(process.execPath, [path.join(mcpRepo, 'scripts/verify-build.js')], { cwd: mcpRepo, stdio: 'pipe' });
  await DreamingService.initialize();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path === '/api/dreams/ingest-session' && failIngestion) {
      res.status(503).json({ success: false, status: 'error', persisted: false, acknowledged: false });
      return;
    }
    if (req.path === '/api/dreams/ingest-session' && dropIngestAck) {
      res.json = (() => { res.destroy(); return res; }) as typeof res.json;
    }
    if (req.path === '/api/dreams/ingest-session' && holdIngestAck) {
      res.json = (() => res) as typeof res.json;
    }
    requests.push({ path: req.path, body: req.body as Record<string, unknown> });
    next();
  });
  registerDreamingRoutes(app);
  server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(JSON.stringify({ build_sha256: createHash('sha256').update(readFileSync(cli)).digest('hex'), build_manifest_sha256: createHash('sha256').update(readFileSync(path.join(mcpRepo, 'dist/build-manifest.json'))).digest('hex'), database: 'disposable SQLite', timezone: 'UTC', timestamp: new Date().toISOString() }));
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
  await DreamingService.waitForBackgroundTasks();
  await db.disconnect();
  setDatabaseAdapter(null);
  process.chdir(originalCwd);
  rmSync(temp, { recursive: true, force: true });
  const elapsed = hookLatencySamples.map(sample => sample.elapsed_ms).sort((a, b) => a - b);
  const p95Index = elapsed.length ? Math.min(elapsed.length - 1, Math.ceil(elapsed.length * 0.95) - 1) : 0;
  console.log(JSON.stringify({
    metric: 'synthetic_compiled_cli_hook_latency_observation',
    production_slo: false,
    budget_source: process.env.CODEATLAS_CANARY_HOOK_BUDGET_MS ? 'CODEATLAS_CANARY_HOOK_BUDGET_MS override; installer declares no route timeout' : 'existing runHook 20-second deadline; installer declares no route timeout',
    budget_ms: hookCompletionBudgetMs,
    completion_count: hookLatencySamples.length,
    max_elapsed_ms: elapsed.length ? elapsed[elapsed.length - 1] : null,
    p95_elapsed_ms: elapsed.length ? elapsed[p95Index] : null,
    completed_calls: hookLatencySamples,
  }));
});

async function runHook(command: string, event: Record<string, unknown>, overrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const eventType = typeof event.hook_event_name === 'string' && safeHookEventTypes.has(event.hook_event_name) ? event.hook_event_name : 'unknown';
    const child = spawn(process.execPath, [cli, command], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'test', CODEATLAS_API_URL: baseUrl, CODEATLAS_API_KEY: 'synthetic-canary-key', CODEATLAS_INJECT_BRAIN_CONTEXT: '1', ...overrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += String(value); });
    child.stderr.on('data', value => { stderr += String(value); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Compiled hook exceeded ${hookCompletionBudgetMs} ms canary completion budget`)); }, hookCompletionBudgetMs);
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr}`));
      else {
        const elapsedMs = Math.round(performance.now() - startedAt);
        assert.ok(elapsedMs <= hookCompletionBudgetMs, `Compiled ${command} hook exceeded the ${hookCompletionBudgetMs} ms canary completion budget`);
        hookLatencySamples.push({ command: command === 'brain-context' ? 'brain-context' : command === 'brain-save' ? 'brain-save' : 'unknown', event_type: eventType, elapsed_ms: elapsedMs });
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

const content = 'Validated resolver.ts regression: canonical project identity preserves worktree memory across sessions; npm test passed 42 tests.';
const event = { hook_event_name: 'PostToolUse', session_id: 'canary-session-a', cwd: project, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: content, stderr: '', exitCode: 0 } };

test('compiled PostToolUse persists a real memory and same-project query returns its stable ID', async () => {
  await runHook('brain-save', event);
  const rows = await db.query<{ id: string; project: string; content: string }>('SELECT id, project, content FROM ai_dreaming_memory WHERE tenant_id = :tenant', { tenant: 'admin' });
  assert.equal(rows.length, 1, 'Native tool_response must reach actual storage');
  assert.ok(rows[0].content.includes('resolver.ts'));
  const response = await fetch(`${baseUrl}/api/dreams/query?${new URLSearchParams({ project: rows[0].project, query: 'resolver.ts', limit: '10' })}`, { headers: { 'x-api-key': 'synthetic-canary-key' } });
  assert.equal(response.status, 200);
  const result = await response.json() as { memories: Array<{ id: string }> };
  assert.ok(result.memories.some(memory => memory.id === rows[0].id));
});

test('replaying compiled tool delivery preserves one durable memory and its ID', async () => {
  const before = await db.query<{ id: string }>('SELECT id FROM ai_dreaming_memory');
  await runHook('brain-save', event);
  const after = await db.query<{ id: string }>('SELECT id FROM ai_dreaming_memory');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0]?.id);
});

test('compiled failure event stores a classified mistake without a normal response', async () => {
  await runHook('brain-save', { hook_event_name: 'PostToolUseFailure', cwd: project, session_id: 'canary-session-a', tool_name: 'Bash', error: 'Synthetic regression failure: resolver.ts rejected a valid worktree alias in the canonical project mapping test.' });
  const rows = await db.query<{ memory_type: string; content: string }>("SELECT memory_type, content FROM ai_dreaming_memory WHERE memory_type = 'MISTAKE'");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].content.includes('worktree alias'));
});

test('secrets are redacted before the compiled hook sends content to the API', async () => {
  const secret = 'sk-syntheticPrivateToken12345678901234567890';
  await runHook('brain-save', { ...event, session_id: 'canary-secret-session', tool_response: { stdout: `Configuration diagnosis for resolver.ts: API_KEY=${secret}; credentials must be redacted before storing diagnostic evidence.` } });
  assert.ok(requests.filter(request => ['/api/dreams/save', '/api/dreams/ingest-session'].includes(request.path)).length > 0);
  assert.ok(requests.every(request => !JSON.stringify(request.body).includes(secret)), 'Secret must never reach API');
  const rows = await db.query<{ content: string }>('SELECT content FROM ai_dreaming_memory');
  assert.ok(rows.every(row => !row.content.includes(secret)));
});

function transcriptPath(sessionId: string): string {
  const directory = path.join(home, '.claude/projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${sessionId}.jsonl`);
}
function transcriptLine(sessionId: string, index: number): string {
  return JSON.stringify({ uuid: `${sessionId}-${index}`, sessionId, cwd: project, type: 'user', message: { role: 'user', content: `We prefer resolver-${index}.ts explicit canonical mapping because session continuity requires durable event ${index} and separate project scope.` } }) + '\n';
}
async function captureRows(sessionId: string): Promise<Array<{ event_id: string; content_redacted: string }>> {
  return db.query("SELECT event_id, content_redacted FROM dream_capture_events WHERE session_id = :sessionId AND actor_role = 'USER' ORDER BY event_id", { sessionId });
}

test('compiled transcript capture advances 7 -> 8 -> 9 -> 50 events and replay stores no duplicates', async () => {
  const sessionId = 'canary-transcript-session';
  const file = transcriptPath(sessionId);
  writeFileSync(file, '');
  let previous = 0;
  for (const total of [7, 8, 9, 50]) {
    for (let index = previous + 1; index <= total; index++) appendFileSync(file, transcriptLine(sessionId, index));
    await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file });
    assert.equal((await captureRows(sessionId)).length, total, `Every source event through ${total} must be durably acknowledged`);
    previous = total;
  }
  await runHook('brain-save', { hook_event_name: 'PreCompact', cwd: project, session_id: sessionId, transcript_path: file });
  assert.equal((await captureRows(sessionId)).length, 50);
});

test('network failure preserves pending events and a new process retries without advancing past storage', async () => {
  const sessionId = 'canary-retry-session';
  const file = transcriptPath(sessionId);
  writeFileSync(file, transcriptLine(sessionId, 1));
  failIngestion = true;
  try {
    await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file }, { CODEATLAS_API_TIMEOUT_MS: '200' });
    assert.equal((await captureRows(sessionId)).length, 0);
  } finally { failIngestion = false; }
  appendFileSync(file, transcriptLine(sessionId, 2));
  await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file });
  assert.equal((await captureRows(sessionId)).length, 2, 'Replay pending event and capture newly appended event after restart');
});

test('lost acknowledgement after server commit replays exactly once from the storage perspective', async () => {
  const sessionId = 'canary-lost-ack-session';
  const file = transcriptPath(sessionId);
  writeFileSync(file, transcriptLine(sessionId, 1));
  dropIngestAck = true;
  try { await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file }, { CODEATLAS_API_TIMEOUT_MS: '200' }); }
  finally { dropIngestAck = false; }
  assert.equal((await captureRows(sessionId)).length, 1);
  await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file });
  assert.equal((await captureRows(sessionId)).length, 1);
});

test('fresh compiled SessionStart automatically restores a prior checkpoint before any prompt', async () => {
  const sessionId = 'canary-bootstrap-source';
  const file = transcriptPath(sessionId);
  const task = 'Decision: preserve nebula-worker.ts tenant isolation in the ingestion pipeline because separate projects must not share memory; next action is rerun the checkpoint regression.';
  writeFileSync(file, JSON.stringify({ uuid: 'bootstrap-user-event', sessionId, cwd: project, type: 'user', message: { role: 'user', content: task } }) + '\n');
  await runHook('brain-save', { hook_event_name: 'PreCompact', cwd: project, session_id: sessionId, transcript_path: file });
  const restored = await runHook('brain-context', { hook_event_name: 'SessionStart', cwd: project, session_id: 'canary-bootstrap-new-session', source: 'startup' });
  let packet: { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } } | undefined;
  try { packet = JSON.parse(restored.stdout); } catch { /* Legacy hosts accept plain text context. */ }
  if (packet) assert.equal(packet.hookSpecificOutput?.hookEventName, 'SessionStart');
  const context = packet ? packet.hookSpecificOutput?.additionalContext || '' : restored.stdout;
  assert.ok(context.includes('nebula-worker.ts'), 'Startup must restore the latest checkpoint without relying on a semantic query');
  assert.ok(context.includes(sessionId), 'Restored context must cite its source session');
  assert.match(context, /untrusted|historical|reference only/i);
});

test('checkpoint API restores grounded evidence and rejects unsupported claims without a prompt', async () => {
  const headers = { 'x-api-key': 'synthetic-canary-key', 'content-type': 'application/json' };
  for (const body of [
    { event_id: 'checkpoint-api-task', actor_role: 'USER', content: 'Decision: retain arcturus.ts workspace isolation because test projects must remain separate.' },
    { event_id: 'checkpoint-api-marker', content: 'Session checkpoint (PreCompact)', checkpoint: { trigger: 'PreCompact' } },
  ]) {
    const saved = await fetch(`${baseUrl}/api/dreams/ingest-session`, { method: 'POST', headers, body: JSON.stringify({ ...body, project_id: 'checkpoint-api-project', project: 'checkpoint-api-display', session_id: 'checkpoint-api-session' }) });
    assert.equal(saved.status, 200);
  }
  const restored = await fetch(`${baseUrl}/api/dreams/checkpoints/latest?project_id=checkpoint-api-project`, { headers });
  assert.equal(restored.status, 200);
  const body = await restored.json() as { retrieval_status: string; checkpoint: { active_task: string; source_event_ids: string[] } };
  assert.equal(body.retrieval_status, 'ok');
  assert.ok(body.checkpoint.active_task.includes('arcturus.ts'));
  assert.ok(body.checkpoint.source_event_ids.includes('checkpoint-api-task'));
  const rejected = await fetch(`${baseUrl}/api/dreams/checkpoints`, { method: 'POST', headers, body: JSON.stringify({ project_id: 'checkpoint-api-project', session_id: 'checkpoint-api-session', source_event_ids: ['checkpoint-api-task'], completed: ['Deployed every change to production'] }) });
  assert.equal(rejected.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/dreams/checkpoints/latest?project_id=checkpoint-api-project`)).status, 401);
  const empty = await fetch(`${baseUrl}/api/dreams/checkpoints/latest?project_id=empty-project`, { headers });
  assert.equal((await empty.json() as { retrieval_status: string }).retrieval_status, 'empty');
});

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function runClaude(prompt: string, settings: string, tools: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    NODE_ENV: 'test',
    CODEATLAS_API_URL: baseUrl,
    CODEATLAS_API_KEY: 'synthetic-canary-key',
    CODEATLAS_INJECT_BRAIN_CONTEXT: '1',
  };
  Object.assign(env, providerEnv);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--model', providerModel, '--max-budget-usd', '1.00', '--output-format', 'json', '--setting-sources', '', '--settings', settings, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', tools, '--allowedTools', 'Bash(node *)', '--', prompt], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrBytes = 0;
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Live Claude canary exceeded 120 seconds')); }, 120_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      let result: { is_error?: boolean; result?: string; subtype?: string; errors?: unknown[] };
      try { result = JSON.parse(stdout); } catch { reject(new Error(`Claude produced no JSON result (exit=${code}, stdout_bytes=${stdout.length}, stderr_bytes=${stderrBytes})`)); return; }
      if (code !== 0 || result.is_error || typeof result.result !== 'string') {
        const description = String(result.result || '') + JSON.stringify(result.errors || []);
        const reason = /login|authenticat|oauth|expired|credential|invalid.?token/i.test(description) ? 'authentication' : /credit|billing|balance|budget/i.test(description) ? 'billing_or_budget' : /network|connect|ENOTFOUND|fetch|timeout/i.test(description) ? 'transport' : /unknown option|invalid.*settings|configuration|permission|not allowed|model/i.test(description) ? 'configuration' : 'unclassified';
        const subtype = typeof result.subtype === 'string' && /^[a-zA-Z0-9_-]+$/.test(result.subtype) ? result.subtype : 'unknown';
        let safeDetail = description;
        for (const value of Object.values(providerEnv)) if (value) safeDetail = safeDetail.replaceAll(value, '[REDACTED]');
        safeDetail = safeDetail.replace(/https?:\/\/[^\s"']+/gi, '[PROVIDER_URL]').replace(/(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 500);
        reject(new Error(`Claude canary did not complete (exit=${code}, reason=${reason}, subtype=${subtype}, stderr_bytes=${stderrBytes}, detail=${safeDetail})`));
      }
      else resolve(result.result);
    });
  });
}

test('live Claude automatically captures a tool outcome and restores it in a fresh session', { skip: process.env.CODEATLAS_LIVE_HOST_TEST !== '1' }, async () => {
  const contextCommand = `${quoteShell(process.execPath)} ${quoteShell(cli)} brain-context`;
  const saveCommand = `${quoteShell(process.execPath)} ${quoteShell(cli)} brain-save`;
  const hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> = {};
  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact']) {
    hooks[eventName] = [{ ...(['PostToolUse', 'PostToolUseFailure'].includes(eventName) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: ['SessionStart', 'UserPromptSubmit'].includes(eventName) ? contextCommand : saveCommand, timeout: 30 }] }];
  }
  const settings = path.join(home, 'live-host-settings.json');
  writeFileSync(settings, JSON.stringify({ hooks }));
  const marker = 'CODEATLAS_CANARY_STARLING_42';
  const command = `node -e "require('node:assert/strict').equal(2+2,4); console.log('${marker}: 1 test passed')"`;
  await runClaude(`This is an isolated CodeAtlas memory canary. Decision: the acceptance token is ${marker}. Use Bash to run exactly this fixed arithmetic check once: ${command}. Finish with DONE after the command succeeds.`, settings, 'Bash');
  const tools = await db.query<{ event_id: string }>("SELECT event_id FROM dream_capture_events WHERE actor_role = 'TOOL' AND content_redacted LIKE :marker", { marker: `%${marker}%` });
  assert.ok(tools.length > 0, 'The real host PostToolUse hook must persist the observed tool outcome');
  const restored = await runClaude('What exact CodeAtlas acceptance token and passed-test count were recorded in the prior project session? Use only the historical context provided at startup. Return just the token and count. Do not run tools.', settings, '');
  assert.ok(restored.includes(marker), 'A fresh host session must recover a token absent from its prompt');
  assert.match(restored, /\b1\b/);
});

test('killing the compiled hook before ACK replays its durable batch on restart', async () => {
  const sessionId = 'process-kill-session';
  const file = transcriptPath(sessionId);
  writeFileSync(file, transcriptLine(sessionId, 1));
  holdIngestAck = true;
  const child = spawn(process.execPath, [cli, 'brain-save'], { cwd: project,
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'test', CODEATLAS_API_URL: baseUrl, CODEATLAS_API_KEY: 'synthetic-canary-key' },
    stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file }));
  try {
    let persisted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await captureRows(sessionId)).length === 1) { persisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(persisted, 'Server commit must occur while the ACK is held');
    child.kill('SIGKILL'); await closed;
  } finally { holdIngestAck = false; if (child.exitCode === null) child.kill('SIGKILL'); }
  appendFileSync(file, transcriptLine(sessionId, 2));
  await runHook('brain-save', { hook_event_name: 'Stop', cwd: project, session_id: sessionId, transcript_path: file });
  assert.equal((await captureRows(sessionId)).length, 2, 'Restart must retain both committed and newly appended sources exactly once');
});

test('same tool evidence in repositories with the same basename stays in distinct canonical scopes', async () => {
  await runHook('brain-save', event);
  const other = path.join(temp, 'another-parent', path.basename(project));
  mkdirSync(other, { recursive: true }); execFileSync('git', ['init', '--quiet', other]);
  await runHook('brain-save', { ...event, cwd: other });
  const rows = await db.query<{ id: string; project_id: string }>("SELECT id, project_id FROM ai_dreaming_memory WHERE content LIKE :content", { content: '%Validated resolver.ts regression:%' });
  assert.equal(new Set(rows.map(row => row.project_id)).size, 2);
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
});
