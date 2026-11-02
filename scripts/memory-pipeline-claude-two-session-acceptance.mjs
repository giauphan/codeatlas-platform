#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const mcpRepository = path.resolve(repositoryRoot, '..', 'codeatlas-mcp-server');
const SELECTED_API = 'http://localhost:3381';
export const CLAUDE_SESSION_BUDGET_USD = '1.00';
const SESSION_TIMEOUT_MS = 60_000;
const PROVIDER_ENV_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
];

function fail() { throw new Error('Claude two-session acceptance preflight or execution failed.'); }

export function validateClaudeAcceptanceInput(input = {}) {
  if (input.optIn !== '1') fail();
  let target;
  try { target = new URL(input.targetUrl); } catch { fail(); }
  if (target.origin !== SELECTED_API || target.pathname !== '/' || target.username || target.password || target.search || target.hash) fail();
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096) fail();
  if (typeof input.projectDir !== 'string' || !path.isAbsolute(input.projectDir) || input.projectId !== input.derivedProjectId) fail();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(input.projectId || '')) fail();
  if (typeof input.sqlitePath !== 'string' || !path.isAbsolute(input.sqlitePath) || input.sqlitePath !== input.expectedSqlitePath) fail();
  return { targetUrl: SELECTED_API, projectDir: input.projectDir, projectId: input.projectId, sqlitePath: input.sqlitePath };
}

export function buildClaudeArgs({ model, settingsPath, tools, prompt, debug = false }) {
  return [
    '--print', '--model', model, '--max-budget-usd', CLAUDE_SESSION_BUDGET_USD,
    '--output-format', 'json', '--setting-sources', '', '--settings', settingsPath,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    ...(debug ? ['--debug=hooks,mcp'] : []),
    '--tools', tools, ...(tools ? ['--allowedTools', 'Bash(node *)'] : []), '--', prompt,
  ];
}

export function buildClaudeAcceptanceRequestHeaders(apiKey, hasBody = false) {
  return {
    'x-api-key': apiKey,
    connection: 'close',
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  };
}

function safeOutput(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function selectClaudeAcceptanceModel(env = {}, settings = {}) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-\[\]]{0,127}$/.test(value);
  const explicit = env.CODEATLAS_CLAUDE_ACCEPTANCE_MODEL;
  if (explicit !== undefined && !valid(explicit)) fail();
  const configured = settings.env || {};
  return [
    explicit,
    settings.model,
    env.ANTHROPIC_MODEL,
    configured.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    configured.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    configured.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    configured.ANTHROPIC_DEFAULT_OPUS_MODEL,
    'haiku',
  ].find(valid);
}

function loadTrustedProviderSettings(env) {
  let settings = {};
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  try { settings = JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')); } catch { /* Process env may hold the provider credentials. */ }
  const providerEnv = {};
  for (const name of PROVIDER_ENV_NAMES) {
    const value = env[name] || settings.env?.[name];
    if (typeof value === 'string' && value) providerEnv[name] = value;
  }
  const hasProviderAuth = Boolean(providerEnv.CLAUDE_CODE_OAUTH_TOKEN || providerEnv.ANTHROPIC_API_KEY || providerEnv.ANTHROPIC_AUTH_TOKEN);
  const configuredModel = selectClaudeAcceptanceModel(env, settings);
  if (!hasProviderAuth || !configuredModel) fail();
  return { providerEnv, model: configuredModel };
}

function runQuiet(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 256 * 1024, ...options });
  if (result.error || result.status !== 0 || result.signal) fail();
  return result.stdout.trim();
}

async function loadProjectIdentity(projectDir) {
  const compiledIdentityPath = path.join(mcpRepository, 'dist', 'src', 'services', 'projectIdentity.js');
  const identity = await import(pathToFileURL(compiledIdentityPath).href);
  return identity.resolveProjectIdentity(projectDir, '', '');
}

function openReadOnlyDatabase(file, projectDir) {
  const expected = realpathSync(path.join(projectDir, 'data', 'codeatlas.db'));
  if (realpathSync(file) !== expected) fail();
  const require = createRequire(path.join(projectDir, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(expected, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tables.has('dream_capture_events') || !tables.has('dream_session_checkpoints')) { db.close(); fail(); }
  return db;
}

async function requestJson(url, apiKey, route, options = {}) {
  const response = await fetch(new URL(route, url), {
    method: options.method || 'GET',
    headers: buildClaudeAcceptanceRequestHeaders(apiKey, options.body !== undefined),
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs || 8_000),
  });
  let value;
  try { value = await response.json(); } catch { fail(); }
  if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
}

function walkJsonl(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkJsonl(file));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(file);
  }
  return found;
}

function sessionIdFromTranscript(file) {
  const first = readFileSync(file, 'utf8').split('\n').find(Boolean);
  if (!first) return null;
  try {
    const parsed = JSON.parse(first);
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  } catch { return null; }
}

function runClaude({ prompt, tools, settingsPath, env }) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      PATH: env.PATH || '/usr/bin:/bin',
      HOME: env.HOME,
      TMPDIR: env.TMPDIR,
      LANG: env.LANG || 'C.UTF-8',
      TERM: env.TERM || 'dumb',
      CLAUDE_CONFIG_DIR: path.dirname(settingsPath),
      CODEATLAS_API_URL: SELECTED_API,
      CODEATLAS_API_KEY: env.CODEATLAS_CLAUDE_ACCEPTANCE_API_KEY || env.CODEATLAS_API_KEY,
      CODEATLAS_PROJECT_ID: env.CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_ID,
      CODEATLAS_INJECT_BRAIN_CONTEXT: '1',
      CODEATLAS_MEMORY_SPOOL_DIR: path.join(env.HOME, '.codeatlas', 'memory-spool'),
      CODEATLAS_CONTEXT_CACHE_DIR: path.join(env.HOME, '.codeatlas', 'context-cache'),
      ...env.providerEnv,
    };
    const child = spawn('claude', buildClaudeArgs({ model: env.providerModel, settingsPath, tools, prompt, debug: env.debug === true }), {
      cwd: env.CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve({ result, stdoutBytes, stderrBytes });
    };
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= 2 * 1024 * 1024) stdout += String(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      if (env.debug === true) process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error('Claude session timed out.');
      error.code = 'claude_session_timeout';
      finish(error);
    }, SESSION_TIMEOUT_MS);
    child.once('error', cause => {
      const error = new Error('Claude process could not start.');
      error.code = cause?.code || 'claude_spawn_error';
      finish(error);
    });
    child.once('close', code => {
      if (code !== 0 || stdoutBytes > 2 * 1024 * 1024) {
        const error = new Error('Claude session returned an unsuccessful exit.');
        error.code = `claude_exit_${code ?? 'unknown'}`;
        return finish(error);
      }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {
        const error = new Error('Claude session returned invalid structured output.');
        error.code = 'claude_invalid_output';
        return finish(error);
      }
      if (parsed.is_error || typeof parsed.result !== 'string') {
        const error = new Error('Claude session reported an error.');
        error.code = 'claude_model_error';
        return finish(error);
      }
      finish(null, parsed.result);
    });
  });
}

function pendingCount(db, projectId) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM dream_capture_events WHERE project_id=? AND status='pending'").get(projectId).count);
}

function sessionCaptureRows(db, projectId, sessionId) {
  return db.prepare(`SELECT actor_role, status, checkpoint_json, content_redacted FROM dream_capture_events
    WHERE project_id=? AND session_id=? ORDER BY capture_sequence, event_id`).all(projectId, sessionId);
}

function validateInstalledHooks(settingsPath, cliPath) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const required = { SessionStart: 'brain-context', UserPromptSubmit: 'brain-context', PostToolUse: 'brain-save', PostToolUseFailure: 'brain-save', Stop: 'brain-save', PreCompact: 'brain-save' };
  for (const [event, route] of Object.entries(required)) {
    const commands = (settings.hooks?.[event] || []).flatMap(group => group?.hooks || []).map(hook => hook?.command || '');
    if (!commands.some(command => command.includes(cliPath) && new RegExp(`\\bhook\\s+${route}$`).test(command))) fail();
  }
}

async function main() {
  const started = performance.now();
  const result = { status: 'failed', checks: {}, counts: {}, timings_ms: {} };
  let db;
  let privateRoot;
  let stage = 'preflight';
  try {
    const targetUrl = process.env.CODEATLAS_CLAUDE_ACCEPTANCE_API_URL || SELECTED_API;
    const projectDir = realpathSync(process.env.CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_DIR || repositoryRoot);
    const projectId = process.env.CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_ID || '';
    const sqlitePath = process.env.CODEATLAS_CLAUDE_ACCEPTANCE_SQLITE_PATH || path.join(projectDir, 'data', 'codeatlas.db');
    const apiKey = process.env.CODEATLAS_CLAUDE_ACCEPTANCE_API_KEY || process.env.CODEATLAS_API_KEY;
    const projectPackage = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (projectPackage.name !== 'codeatlas-ai') fail();
    const gitRoot = realpathSync(runQuiet('git', ['-C', projectDir, 'rev-parse', '--show-toplevel']));
    if (gitRoot !== projectDir) fail();
    stage = 'project_identity_preflight';
    const identity = await loadProjectIdentity(projectDir);
    const config = validateClaudeAcceptanceInput({
      optIn: process.env.CODEATLAS_MEMORY_CLAUDE_TWO_SESSION_ACCEPTANCE,
      targetUrl, apiKey, projectDir, projectId, derivedProjectId: identity.project_id,
      sqlitePath, expectedSqlitePath: path.join(projectDir, 'data', 'codeatlas.db'),
    });
    stage = 'provider_configuration_preflight';
    const provider = loadTrustedProviderSettings(process.env);
    const cliPath = path.join(mcpRepository, 'dist', 'index.js');
    const installerPath = path.join(mcpRepository, 'scripts', 'setup-hooks.js');
    const verifyPath = path.join(mcpRepository, 'scripts', 'verify-build.js');
    if (![cliPath, installerPath, verifyPath].every(existsSync)) fail();
    stage = 'database_preflight';
    db = openReadOnlyDatabase(config.sqlitePath, projectDir);
    if (pendingCount(db, projectId) !== 0) fail();
    const runId = randomUUID();
    const seed = randomUUID();
    const toolToken = `CA${createHash('sha256').update(`codeatlas-tool-receipt:${seed}`).digest('hex').slice(0, 20).toUpperCase()}`;
    const toolCommandSource = `const a=require('node:assert/strict');a.equal(2+2,4);const c=require('node:crypto');const t='CA'+c.createHash('sha256').update('codeatlas-tool-receipt:${seed}').digest('hex').slice(0,20).toUpperCase();console.log('accepted receipt '+t+'; checks=1')`;
    const toolCommand = `node -e "${toolCommandSource.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const firstPrompt = `For the next project session, remember the exact receipt printed by the command result. Use Bash once to run this exact command, then say only that it completed: ${toolCommand}`;
    const secondPrompt = 'What exact receipt token and check count were printed by the command in the prior CodeAtlas project session? Use only startup historical context. Do not use tools. Return the receipt and count only.';
    if (firstPrompt.includes(toolToken) || secondPrompt.includes(toolToken)) fail();
    const tempRoot = realpathSync(os.tmpdir());
    privateRoot = mkdtempSync(path.join(tempRoot, 'codeatlas-claude-two-session-'), { mode: 0o700 });
    const privateHome = path.join(privateRoot, 'home');
    const privateTmp = path.join(privateRoot, 'tmp');
    const claudeDir = path.join(privateHome, '.claude');
    mkdirSync(path.join(claudeDir, 'projects'), { recursive: true, mode: 0o700 });
    mkdirSync(privateTmp, { recursive: true, mode: 0o700 });
    chmodSync(privateHome, 0o700); chmodSync(claudeDir, 0o700);
    const settingsPath = path.join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, '{}\n', { mode: 0o600, flag: 'wx' });
    const privateEnv = {
      ...process.env,
      HOME: privateHome,
      TMPDIR: privateTmp,
      CODEATLAS_CLAUDE_ACCEPTANCE_API_KEY: apiKey,
      CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_ID: projectId,
      CODEATLAS_CLAUDE_ACCEPTANCE_PROJECT_DIR: projectDir,
      providerEnv: provider.providerEnv,
      providerModel: provider.model,
      debug: process.env.CODEATLAS_CLAUDE_ACCEPTANCE_DEBUG === '1',
    };
    stage = 'compiled_cli_validation';
    runQuiet(process.execPath, [verifyPath], { cwd: mcpRepository, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: privateHome }, timeout: 30_000 });
    runQuiet(process.execPath, [installerPath, settingsPath], { cwd: mcpRepository, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: privateHome }, timeout: 15_000 });
    validateInstalledHooks(settingsPath, cliPath);
    result.checks = { target_guard_passed: true, derived_project_matches: true, read_only_db_preflight: true, isolated_hooks_installed: true, operator_settings_used: false, claude_debug_enabled: privateEnv.debug };

    stage = 'target_health';
    const healthStarted = performance.now();
    const health = await requestJson(config.targetUrl, apiKey, '/api/health');
    if (health.status !== 'ok') fail();
    result.timings_ms.api_health = Math.round(performance.now() - healthStarted);

    stage = 'first_claude_session';
    const firstStarted = performance.now();
    const first = await runClaude({ prompt: firstPrompt, tools: 'Bash', settingsPath, env: privateEnv });
    result.timings_ms.session_one = Math.round(performance.now() - firstStarted);
    if (!first.result.toLowerCase().includes('completed')) fail();

    stage = 'first_session_tool_capture';
    const projectsDir = path.join(claudeDir, 'projects');
    const transcriptFiles = walkJsonl(projectsDir);
    const firstSessionIds = [...new Set(transcriptFiles.map(sessionIdFromTranscript).filter(Boolean))];
    const toolCaptureRows = db.prepare(`SELECT session_id, content_redacted FROM dream_capture_events
      WHERE project_id=? AND actor_role='TOOL' AND content_redacted LIKE ? ORDER BY created_at`).all(projectId, `%${toolToken}%`);
    if (toolCaptureRows.length < 1 || firstSessionIds.length < 1 || !toolCaptureRows.some(row => firstSessionIds.includes(row.session_id))) fail();
    const firstSessionId = toolCaptureRows.find(row => firstSessionIds.includes(row.session_id)).session_id;
    const firstRows = sessionCaptureRows(db, projectId, firstSessionId);
    if (!firstRows.some(row => row.actor_role === 'TOOL' && row.content_redacted.includes(toolToken))) fail();
    const userPromptContainsToolToken = firstRows.some(row => row.actor_role === 'USER' && row.content_redacted.includes(toolToken));
    if (userPromptContainsToolToken) fail();
    const rowsBeforeReconcile = pendingCount(db, projectId);
    if (rowsBeforeReconcile > 0) {
      const pendingRows = db.prepare("SELECT DISTINCT session_id FROM dream_capture_events WHERE project_id=? AND status='pending'").all(projectId);
      if (pendingRows.some(row => row.session_id !== firstSessionId)) fail();
      stage = 'first_session_reconciliation';
      const reconcileStarted = performance.now();
      const reconciliation = await requestJson(config.targetUrl, apiKey, '/api/dreams/reconcile-pending', {
        method: 'POST', body: { project_id: projectId, limit: 100 }, timeoutMs: 30_000,
      });
      result.timings_ms.reconciliation = Math.round(performance.now() - reconcileStarted);
      if (reconciliation.success !== true || reconciliation.failed !== 0 || pendingCount(db, projectId) !== 0) fail();
      result.checks.reconciliation_succeeded = true;
    } else {
      result.checks.reconciliation_succeeded = true;
    }
    const checkpoint = await requestJson(config.targetUrl, apiKey, `/api/dreams/checkpoints/latest?project_id=${encodeURIComponent(projectId)}`);
    if (checkpoint.retrieval_status !== 'ok' || !checkpoint.checkpoint || checkpoint.checkpoint.session_id !== firstSessionId) fail();
    result.checks.checkpoint_available_before_session_two = true;
    result.counts.session_one_capture_rows = firstRows.length;
    result.counts.tool_token_capture_rows = toolCaptureRows.length;

    stage = 'second_claude_session';
    const secondStarted = performance.now();
    const sessionIdsBeforeSecond = new Set(walkJsonl(projectsDir).map(sessionIdFromTranscript).filter(Boolean));
    const second = await runClaude({ prompt: secondPrompt, tools: '', settingsPath, env: privateEnv });
    result.timings_ms.session_two = Math.round(performance.now() - secondStarted);
    result.checks.second_prompt_excluded_tool_token = !secondPrompt.includes(toolToken);
    result.checks.second_response_restored_tool_token = second.result.includes(toolToken);
    result.checks.second_response_restored_check_count = /\b1\b/.test(second.result);
    if (!result.checks.second_response_restored_tool_token || !result.checks.second_response_restored_check_count) fail();
    const secondSessionIds = [...new Set(walkJsonl(projectsDir).map(sessionIdFromTranscript).filter(Boolean))];
    if (!secondSessionIds.some(id => !sessionIdsBeforeSecond.has(id)) || secondSessionIds.every(id => id === firstSessionId)) fail();
    result.counts.fresh_claude_session_count = 2;
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.checks.completed = false;
    result.failed_stage = stage;
    result.failure_type = error instanceof Error ? String(error.name).slice(0, 40) : 'Error';
    if (error instanceof Error && typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(error.code)) {
      result.failure_code = error.code;
    }
  } finally {
    result.timings_ms.total = Math.round(performance.now() - started);
    try { db?.close(); } catch { /* Read-only handle cleanup. */ }
    if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
    safeOutput(result);
  }
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) await main();
