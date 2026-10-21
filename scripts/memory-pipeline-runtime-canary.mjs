#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_HOOK_BUDGET_MS = 30_000;
const MAX_HOOK_BUDGET_MS = 60_000;

function fail(message) { throw new Error(message); }

export function validateRuntimeCanaryInput(input = {}) {
  if (input.optIn !== '1') fail('Refusing live writes: set CODEATLAS_MEMORY_RUNTIME_CANARY=1 for explicit opt-in.');
  let target;
  try { target = new URL(input.targetUrl); } catch { fail('CODEATLAS_CANARY_API_URL must be the selected loopback API URL.'); }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (target.protocol !== 'http:' || !loopback.has(target.hostname.toLowerCase()) || target.port !== '3381' ||
      target.username || target.password || (target.pathname !== '/' && target.pathname !== '') || target.search || target.hash) {
    fail('The target must be http loopback on port 3381 with no path or credentials.');
  }
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096) {
    fail('An authenticated API key is required via the process environment.');
  }
  if (typeof input.projectDir !== 'string' || !path.isAbsolute(input.projectDir) || !input.projectId || !input.derivedProjectId || input.projectId !== input.derivedProjectId) {
    fail('The explicit project ID does not match the derived canonical project identity.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(input.projectId)) fail('The explicit project ID is invalid.');
  return { targetUrl: target.toString(), projectDir: input.projectDir, projectId: input.projectId };
}

export function buildCanaryReconciliationPayload(projectId, eventId) {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 255 ||
      typeof eventId !== 'string' || !eventId.trim() || eventId.length > 255) {
    fail('Canary reconciliation requires a valid project and exact event ID.');
  }
  return { project_id: projectId, event_id: eventId, limit: 1 };
}

export function buildCanaryRequestHeaders(apiKey, hasBody = false) {
  return {
    'x-api-key': apiKey,
    connection: 'close',
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  };
}

export async function loadCompiledProjectIdentity(mcpRepo, projectDir) {
  const identityModulePath = path.join(mcpRepo, 'dist', 'src', 'services', 'projectIdentity.js');
  const identityModule = await import(pathToFileURL(identityModulePath).href);
  return identityModule.resolveProjectIdentity(projectDir, '', '');
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) fail(`Missing required setting: ${name}.`);
  return value;
}

function realDirectory(value, name) {
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute directory path.`);
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory()) fail(`${name} must be a directory.`);
  return resolved;
}

function safeResultPath(value) {
  if (!path.isAbsolute(value)) fail('CODEATLAS_CANARY_RESULT_PATH must be an absolute path under the temporary directory.');
  const resultPath = path.resolve(value);
  const tempRoot = realpathSync(os.tmpdir());
  const parent = realpathSync(path.dirname(resultPath));
  const relative = path.relative(tempRoot, parent);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CODEATLAS_CANARY_RESULT_PATH must be strictly inside the real temporary directory.');
  }
  if (existsSync(resultPath)) fail('CODEATLAS_CANARY_RESULT_PATH already exists; choose a new report file.');
  return resultPath;
}

function runFile(executable, args, options, label) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 256 * 1024, ...options });
  if (result.error || result.status !== 0 || result.signal) fail(`${label} failed (exit ${result.status ?? 'unknown'}).`);
  return result;
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function derivedEventId(projectId, sessionId, uuid) {
  return `claude_${createHash('sha256').update(`${projectId}\0${sessionId}\0${uuid}`).digest('hex')}`;
}

function checkpointEventId(projectId, sessionId, trigger, cursor) {
  return `claude_${createHash('sha256').update(`${projectId}\0${sessionId}\0checkpoint\0${trigger}\0${cursor}`).digest('hex')}`;
}

function transcriptRow(uuid, sessionId, cwd, type, content) {
  return JSON.stringify({ uuid, sessionId, cwd, type, message: { role: type, content } });
}

function useReadOnlyDatabase(projectDir, suppliedPath) {
  if (!path.isAbsolute(suppliedPath)) fail('CODEATLAS_CANARY_SQLITE_PATH must be an absolute path.');
  const configured = realpathSync(suppliedPath);
  const expected = realpathSync(path.join(projectDir, 'data', 'codeatlas.db'));
  if (configured !== expected) fail('Canary SQLite path must resolve to this project’s data/codeatlas.db.');
  const require = createRequire(path.join(projectDir, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(configured, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (!tables.has('dream_capture_events') || !tables.has('ai_dreaming_memory')) {
    db.close();
    fail('The selected read-only SQLite database is missing memory pipeline tables.');
  }
  return db;
}

function captureRows(db, projectId, sessionId, eventIds) {
  const placeholders = eventIds.map(() => '?').join(',');
  if (!placeholders) return [];
  return db.prepare(`SELECT event_id, actor_role, status, memory_ids_json FROM dream_capture_events
    WHERE project_id = ? AND session_id = ? AND event_id IN (${placeholders}) ORDER BY event_id`)
    .all(projectId, sessionId, ...eventIds);
}

function pendingEventIds(db, projectId) {
  return db.prepare("SELECT event_id FROM dream_capture_events WHERE project_id = ? AND status = 'pending' ORDER BY event_id")
    .all(projectId).map(row => row.event_id);
}

function openMemoryRows(db, projectId, marker) {
  return db.prepare(`SELECT id, project_id FROM ai_dreaming_memory
    WHERE project_id = ? AND content LIKE ? ORDER BY id`).all(projectId, `%${marker}%`);
}

async function requestJson(baseUrl, route, apiKey, { method = 'GET', body, timeoutMs = 5_000 } = {}) {
  let response;
  try {
    response = await fetch(new URL(route, baseUrl), {
      method,
      headers: buildCanaryRequestHeaders(apiKey, body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error('Canary API transport failed.');
    error.code = cause?.cause?.code || cause?.code || cause?.name || 'unknown';
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch { fail(`API request failed with HTTP ${response.status} and invalid JSON.`); }
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail(`API request failed with HTTP ${response.status}.`);
  return payload;
}

function hookBudget(env) {
  const requested = Number(env.CODEATLAS_CANARY_HOOK_BUDGET_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_HOOK_BUDGET_MS;
  return Math.min(MAX_HOOK_BUDGET_MS, Math.floor(requested));
}

function runNativeHook({ cli, route, event, projectDir, env, timeoutMs }) {
  const result = spawnSync(process.execPath, [cli, 'hook', route], {
    cwd: projectDir,
    env,
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) {
    const error = new Error(`Native ${route} hook failed or exceeded its deadline.`);
    error.code = result.error?.code || (result.signal ? 'signaled' : 'nonzero_exit');
    error.signal = result.signal || undefined;
    error.status = result.status ?? undefined;
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function writeReport(file, report) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); }
  finally { closeSync(fd); }
  chmodSync(file, 0o600);
}

async function runCanary(env) {
  const apiKey = env.CODEATLAS_CANARY_API_KEY || required(env, 'CODEATLAS_API_KEY');
  const targetUrl = required(env, 'CODEATLAS_CANARY_API_URL');
  const projectDir = realDirectory(required(env, 'CODEATLAS_CANARY_PROJECT_DIR'), 'CODEATLAS_CANARY_PROJECT_DIR');
  const projectId = required(env, 'CODEATLAS_CANARY_PROJECT_ID');
  const resultPath = safeResultPath(required(env, 'CODEATLAS_CANARY_RESULT_PATH'));
  const mcpRepo = realDirectory(env.CODEATLAS_MCP_REPO || path.resolve(repositoryRoot, '../codeatlas-mcp-server'), 'CODEATLAS_MCP_REPO');
  const cli = path.join(mcpRepo, 'dist', 'index.js');
  const manifestPath = path.join(mcpRepo, 'dist', 'build-manifest.json');
  const verifyBuild = path.join(mcpRepo, 'scripts', 'verify-build.js');
  if (!existsSync(cli) || !existsSync(manifestPath) || !existsSync(verifyBuild)) fail('Compiled MCP CLI or build manifest is unavailable.');

  const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  if (packageJson.name !== 'codeatlas-ai') fail('The selected project is not this CodeAtlas Platform checkout.');
  const gitRoot = runFile('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], { timeout: 2_000 }, 'Project git-root validation').stdout.trim();
  if (realpathSync(gitRoot) !== projectDir) fail('CODEATLAS_CANARY_PROJECT_DIR must be the canonical git root.');

  const identity = await loadCompiledProjectIdentity(mcpRepo, projectDir);
  const config = validateRuntimeCanaryInput({ optIn: env.CODEATLAS_MEMORY_RUNTIME_CANARY, targetUrl, apiKey, projectDir, projectId, derivedProjectId: identity.project_id });
  const db = useReadOnlyDatabase(projectDir, required(env, 'CODEATLAS_CANARY_SQLITE_PATH'));
  const budgetMs = hookBudget(env);
  const runId = randomUUID();
  const marker = `CODEATLAS_RUNTIME_CANARY_${runId.replaceAll('-', '').toUpperCase()}`;
  const sessionId = `runtimecanary_${runId}`;
  const freshSessionId = `runtimecanary_boot_${runId}`;
  const toolEventId = `runtime_canary_${runId}_tool`;
  const report = {
    schema_version: 1,
    kind: 'synthetic_authenticated_memory_pipeline_runtime_canary',
    production_slo: false,
    run_id: runId,
    started_at: new Date().toISOString(),
    target: { api_origin: config.targetUrl, project_id: identity.project_id, project_path: identity.canonical_root, identity_source: identity.identity_source },
    platform: { package_version: packageJson.version, git_head: runFile('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { timeout: 2_000 }, 'Platform version check').stdout.trim(), modified_path_count: runFile('git', ['-C', projectDir, 'status', '--porcelain'], { timeout: 2_000 }, 'Platform worktree check').stdout.split('\n').filter(Boolean).length },
    mcp: { cli_path: cli, cli_sha256: hashFile(cli), manifest_sha256: hashFile(manifestPath) },
    budget_ms: budgetMs,
    checks: {},
  };
  let privateRoot;
  let stage = 'preflight';
  const started = performance.now();
  try {
    stage = 'compiled_cli_verification';
    privateRoot = fsMkdtemp();
    const privateHome = path.join(privateRoot, 'home');
    const claudeDir = path.join(privateHome, '.claude');
    mkdirSync(path.join(claudeDir, 'projects'), { recursive: true, mode: 0o700 });
    chmodSync(privateRoot, 0o700);
    chmodSync(privateHome, 0o700);
    chmodSync(claudeDir, 0o700);
    const settingsPath = path.join(claudeDir, 'settings.json');
    writeFileSync(settingsPath, '{}\n', { mode: 0o600, flag: 'wx' });
    const installEnv = { PATH: env.PATH || '/usr/bin:/bin', HOME: privateHome };
    runFile(process.execPath, [verifyBuild], { cwd: mcpRepo, env: installEnv, timeout: 30_000 }, 'Compiled MCP build verification');
    runFile(process.execPath, [path.join(mcpRepo, 'scripts', 'setup-hooks.js'), settingsPath], { cwd: mcpRepo, env: installEnv, timeout: 15_000 }, 'Isolated native hook installation');
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const expectedRoutes = { SessionStart: 'brain-context', UserPromptSubmit: 'brain-context', PostToolUse: 'brain-save', PostToolUseFailure: 'brain-save', Stop: 'brain-save', PreCompact: 'brain-save' };
    for (const [eventName, route] of Object.entries(expectedRoutes)) {
      const command = installed.hooks?.[eventName]?.flatMap(group => group.hooks || []).map(hook => hook.command || '')
        .find(value => value.includes(cli) && new RegExp(`\\bhook\\s+${route}$`).test(value));
      if (!command) fail('The isolated native installer did not register the expected host event routes.');
    }
    report.checks.isolated_installer = { registered_events: Object.keys(expectedRoutes), operator_settings_read: false };

    stage = 'target_health_and_database_preflight';
    const health = await requestJson(config.targetUrl, '/api/health', apiKey, { timeoutMs: 5_000 });
    if (health.status !== 'ok') fail('Target API health check did not return ok.');
    const version = await requestJson(config.targetUrl, '/api/version', apiKey, { timeoutMs: 5_000 });
    const initialCheckpoint = await requestJson(config.targetUrl, `/api/dreams/checkpoints/latest?project_id=${encodeURIComponent(projectId)}`, apiKey, { timeoutMs: 5_000 });
    if (!['ok', 'empty'].includes(initialCheckpoint.retrieval_status)) fail('Target project checkpoint preflight returned an unexpected status.');
    const toolRowsBefore = db.prepare('SELECT COUNT(*) AS count FROM dream_capture_events WHERE project_id = ? AND session_id = ?').get(projectId, sessionId).count;
    if (toolRowsBefore !== 0) fail('Generated canary session ID unexpectedly already exists in target storage.');
    const projectPendingBefore = pendingEventIds(db, projectId);
    if (projectPendingBefore.length) fail('The selected project already has unrelated pending source events; refusing to run project-scoped reconciliation.');
    report.target.platform_version = typeof version.version === 'string' ? version.version : 'unknown';
    report.checks.target_preflight = { health: health.status, checkpoint_status: initialCheckpoint.retrieval_status, session_collision_count: toolRowsBefore, unrelated_pending_count: 0 };

    const childEnv = {
      PATH: env.PATH || '/usr/bin:/bin',
      HOME: privateHome,
      CODEATLAS_API_URL: config.targetUrl,
      CODEATLAS_API_KEY: apiKey,
      CODEATLAS_PROJECT_ID: projectId,
      CODEATLAS_PROJECT: identity.project,
      CODEATLAS_INJECT_BRAIN_CONTEXT: '1',
      CODEATLAS_MEMORY_SPOOL_DIR: path.join(privateHome, '.codeatlas', 'memory-spool'),
      CODEATLAS_CONTEXT_CACHE_DIR: path.join(privateHome, '.codeatlas', 'context-cache'),
      CODEATLAS_API_TIMEOUT_MS: '8000',
    };
    const checkSource = `const fs=require('node:fs'); const p=require('./package.json'); if(p.name!=='codeatlas-ai'||!fs.existsSync('src/index.ts')) process.exit(1); console.log(${JSON.stringify(marker)}+' verified package '+p.name+' and src/index.ts')`;
    const checkCommand = `node -e ${JSON.stringify(checkSource)}`;

    stage = 'actual_tool_execution_and_capture';
    const toolResult = runFile(process.execPath, ['-e', checkSource], {
      cwd: projectDir, env: { PATH: childEnv.PATH }, timeout: 5_000,
    }, 'Synthetic repository verification command').stdout.trim();
    if (!toolResult.includes(marker) || !toolResult.includes('verified package codeatlas-ai')) fail('The actual repository verification command returned an unexpected result.');
    const hookStarted = performance.now();
    runNativeHook({ cli, route: 'brain-save', projectDir, env: childEnv, timeoutMs: budgetMs, event: {
      hook_event_name: 'PostToolUse', session_id: sessionId, tool_use_id: toolEventId, cwd: projectDir, tool_name: 'Bash',
      tool_input: { command: checkCommand }, tool_response: { stdout: toolResult, exitCode: 0 },
    } });
    const captureMs = Math.round(performance.now() - hookStarted);
    const toolRows = captureRows(db, projectId, sessionId, [toolEventId]);
    if (toolRows.length !== 1 || toolRows[0].actor_role !== 'TOOL') fail('Native PostToolUse did not persist exactly one tool source event.');
    report.checks.post_tool_capture = { elapsed_ms: captureMs, event_id: toolRows[0].event_id, source_status: toolRows[0].status };

    stage = 'duplicate_delivery_check';
    const replayStarted = performance.now();
    const replayInput = {
      hook_event_name: 'PostToolUse', session_id: sessionId, tool_use_id: toolEventId, cwd: projectDir, tool_name: 'Bash',
      tool_input: { command: checkCommand }, tool_response: { stdout: toolResult, exitCode: 0 },
    };
    runNativeHook({ cli, route: 'brain-save', projectDir, env: childEnv, timeoutMs: budgetMs, event: replayInput });
    const replayRows = captureRows(db, projectId, sessionId, [toolEventId]);
    if (replayRows.length !== 1 || JSON.stringify(replayRows) !== JSON.stringify(toolRows)) fail('Replaying the identical tool event changed its durable source or memory acknowledgement.');
    report.checks.duplicate_delivery = { elapsed_ms: Math.round(performance.now() - replayStarted), exact_event_id: toolEventId, persisted_row_count: replayRows.length, acknowledgement_stable: true };

    stage = 'stop_hook_execution';
    const projectsRoot = path.join(privateHome, '.claude', 'projects');
    const encodedProject = projectDir.replace(/[^A-Za-z0-9]/g, '-');
    const transcriptDirectory = path.join(projectsRoot, encodedProject);
    mkdirSync(transcriptDirectory, { recursive: true, mode: 0o700 });
    chmodSync(transcriptDirectory, 0o700);
    const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
    const userUuid = `${sessionId}-user`;
    const userText = `Synthetic runtime canary ${marker}: verify the repository package identity and capture the actual command result. Next action: restore this project checkpoint in a fresh session.`;
    const transcriptText = `${transcriptRow(userUuid, sessionId, projectDir, 'user', userText)}\n`;
    writeFileSync(transcriptPath, transcriptText, { mode: 0o600, flag: 'wx' });
    const userEventId = derivedEventId(projectId, sessionId, userUuid);
    const cursor = Buffer.byteLength(transcriptText);
    const checkpointId = checkpointEventId(projectId, sessionId, 'Stop', cursor);
    const checkpointIds = [toolEventId, userEventId, checkpointId].sort();
    const stopStarted = performance.now();
    runNativeHook({ cli, route: 'brain-save', projectDir, env: childEnv, timeoutMs: budgetMs, event: {
      hook_event_name: 'Stop', session_id: sessionId, cwd: projectDir, transcript_path: transcriptPath,
    } });
    report.checks.stop_hook = { elapsed_ms: Math.round(performance.now() - stopStarted), completed: true };
    stage = 'stop_pending_marker_validation';
    const pendingBeforeReconcile = pendingEventIds(db, projectId);
    report.checks.stop_pending_marker = {
      pending_count: pendingBeforeReconcile.length,
      exact_marker_only: pendingBeforeReconcile.length === 1 && pendingBeforeReconcile[0] === checkpointId,
    };
    if (pendingBeforeReconcile.length !== 1 || pendingBeforeReconcile[0] !== checkpointId) {
      fail('The exact canary Stop marker is not the only pending event; refusing reconciliation.');
    }
    stage = 'stop_marker_reconciliation';
    const reconciliation = await requestJson(config.targetUrl, '/api/dreams/reconcile-pending', apiKey, {
      method: 'POST', body: buildCanaryReconciliationPayload(projectId, checkpointId), timeoutMs: 30_000,
    });
    report.checks.explicit_reconciliation = {
      success: reconciliation.success === true,
      failed: Number.isSafeInteger(reconciliation.failed) ? reconciliation.failed : null,
      events_processed: Number.isSafeInteger(reconciliation.events_processed) ? reconciliation.events_processed : null,
      events_filtered: Number.isSafeInteger(reconciliation.events_filtered) ? reconciliation.events_filtered : null,
      skipped: reconciliation.skipped === true,
      pending_before: pendingBeforeReconcile.length,
      scope: 'exact_canary_stop_event',
    };
    if (reconciliation.success !== true || reconciliation.failed !== 0 || reconciliation.skipped === true) {
      fail('Explicit canary reconciliation did not complete successfully with processing enabled.');
    }
    stage = 'stop_checkpoint_verification';
    const checkpointRows = captureRows(db, projectId, sessionId, [toolEventId, userEventId, checkpointId]);
    if (checkpointRows.length !== checkpointIds.length || checkpointRows.some(row => !checkpointIds.includes(row.event_id))) {
      fail('Stop transcript capture did not persist the exact expected source event IDs.');
    }
    if (checkpointRows.some(row => row.status === 'pending')) fail('Explicit reconciliation left a canary source event pending.');
    if (!checkpointRows.some(row => row.event_id === checkpointId && ['processed', 'filtered'].includes(row.status))) {
      fail('Explicit reconciliation did not process or filter the canary checkpoint marker.');
    }
    report.checks.explicit_reconciliation.canary_pending_count = 0;
    const checkpoint = await requestJson(config.targetUrl, `/api/dreams/checkpoints/latest?project_id=${encodeURIComponent(projectId)}`, apiKey, { timeoutMs: 5_000 });
    const savedCheckpoint = checkpoint.checkpoint;
    if (checkpoint.retrieval_status !== 'ok' || !savedCheckpoint || savedCheckpoint.project_id !== projectId || savedCheckpoint.session_id !== sessionId ||
        !String(savedCheckpoint.active_task || '').includes(marker) || checkpointIds.some(id => !savedCheckpoint.source_event_ids?.includes(id))) {
      fail('Stop did not materialize a same-project checkpoint with the complete canary source ID set.');
    }
    report.checks.stop_checkpoint = { elapsed_ms: Math.round(performance.now() - stopStarted), checkpoint_id: savedCheckpoint.id, source_event_ids: [...savedCheckpoint.source_event_ids] };

    stage = 'same_project_exact_query';
    const exactQuery = await requestJson(config.targetUrl,
      `/api/dreams/query?${new URLSearchParams({ project: identity.project, project_id: projectId, query: marker, limit: '100' })}`,
      apiKey, { timeoutMs: 8_000 });
    const memories = Array.isArray(exactQuery.memories) ? exactQuery.memories : [];
    const matchingMemories = memories.filter(memory => typeof memory?.id === 'string' && typeof memory?.content === 'string' && memory.content.includes(marker));
    const exactRows = openMemoryRows(db, projectId, marker);
    const exactIds = new Set(exactRows.map(row => row.id));
    const matchingIds = matchingMemories.map(memory => memory.id).filter(id => exactIds.has(id));
    if (!matchingIds.length) fail('Same-project exact query did not return a persisted canary memory ID.');
    report.checks.same_project_query = { retrieval_status: exactQuery.retrieval_status || 'ok', exact_memory_ids: matchingIds };

    stage = 'other_project_isolation';
    const otherIdentity = await loadCompiledProjectIdentity(mcpRepo, mcpRepo);
    if (otherIdentity.project_id === projectId) fail('The independent-project isolation control resolved to the canary project ID.');
    const otherProject = await requestJson(config.targetUrl, `/api/dreams/checkpoints/latest?project_id=${encodeURIComponent(otherIdentity.project_id)}`, apiKey, { timeoutMs: 5_000 });
    const otherCheckpoint = otherProject.checkpoint;
    const leaked = Boolean(otherCheckpoint && (String(otherCheckpoint.active_task || '').includes(marker) || checkpointIds.some(id => otherCheckpoint.source_event_ids?.includes(id))));
    if (leaked) fail('Canary source evidence appeared in the independent project checkpoint.');
    const otherQuery = await requestJson(config.targetUrl,
      `/api/dreams/query?${new URLSearchParams({ project: otherIdentity.project, project_id: otherIdentity.project_id, query: marker, limit: '100' })}`,
      apiKey, { timeoutMs: 8_000 });
    const otherMemories = Array.isArray(otherQuery.memories) ? otherQuery.memories : [];
    const canaryMemoryIds = new Set(matchingIds);
    if (otherMemories.some(memory => canaryMemoryIds.has(memory?.id) || (typeof memory?.content === 'string' && memory.content.includes(marker)))) {
      fail('Canary memory evidence appeared in the independent project query.');
    }
    report.checks.other_project_isolation = { project_id: otherIdentity.project_id, checkpoint_status: otherProject.retrieval_status || 'unknown', query_status: otherQuery.retrieval_status || 'ok', canary_sources_leaked: false, canary_memories_leaked: false };

    stage = 'fresh_session_start';
    const startStarted = performance.now();
    const startup = runNativeHook({ cli, route: 'brain-context', projectDir, env: childEnv, timeoutMs: budgetMs, event: {
      hook_event_name: 'SessionStart', session_id: freshSessionId, cwd: projectDir, source: 'startup',
    } });
    let packet;
    try { packet = JSON.parse(startup.stdout); } catch { fail('Fresh SessionStart did not produce a JSON host context packet.'); }
    const context = packet?.hookSpecificOutput?.additionalContext;
    const sourceIdsReadable = typeof context === 'string' && checkpointIds.every(id => context.includes(id));
    if (packet?.hookSpecificOutput?.hookEventName !== 'SessionStart' || !sourceIdsReadable || !context.includes(marker) ||
        !/untrusted|historical reference/i.test(context)) fail('Fresh SessionStart did not inject the canary checkpoint and its source citations.');
    report.checks.fresh_session_start = { elapsed_ms: Math.round(performance.now() - startStarted), session_id: freshSessionId, injected: true, source_ids_readable: true, context_chars: context.length };

    report.status = 'passed';
    report.finished_at = new Date().toISOString();
    report.elapsed_ms = Math.round(performance.now() - started);
    reportPathFromEnv(env, report, resultPath);
    return { report, resultPath };
  } catch (error) {
    report.status = 'failed';
    report.failed_stage = stage;
    const failure = error instanceof Error ? error : undefined;
    const httpStatus = failure?.message.match(/HTTP (\d{3})/)?.[1];
    report.failure = {
      category: httpStatus ? 'http_error' : failure?.message.startsWith('Native ') ? 'native_hook_error' : 'canary_step_error',
      ...(httpStatus ? { http_status: Number(httpStatus) } : {}),
      ...(failure?.name ? { error_type: String(failure.name).slice(0, 40) } : {}),
      ...(failure?.code ? { native_error_code: String(failure.code).slice(0, 40) } : {}),
      ...(failure?.signal ? { native_signal: String(failure.signal).slice(0, 20) } : {}),
      ...(Number.isInteger(failure?.status) ? { native_exit_status: failure.status } : {}),
    };
    report.finished_at = new Date().toISOString();
    report.elapsed_ms = Math.round(performance.now() - started);
    reportPathFromEnv(env, report, resultPath);
    throw new Error(`Runtime canary failed at ${stage}; safe result report written.`);
  } finally {
    db.close();
    if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
  }
}

function reportPathFromEnv(_env, report, file) {
  try { writeReport(file, report); } catch { fail('Could not write the protected canary result report.'); }
}

function fsMkdtemp() {
  return mkdtempSync(path.join(os.tmpdir(), 'codeatlas-runtime-canary-'), { mode: 0o700 });
}

async function main() {
  if (process.env.CODEATLAS_MEMORY_RUNTIME_CANARY !== '1') {
    console.error('Refusing live writes: explicit opt-in is required.');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runCanary(process.env);
    console.log(JSON.stringify({ status: result.report.status, run_id: result.report.run_id, report_path: result.resultPath, elapsed_ms: result.report.elapsed_ms }));
  } catch (error) {
    const safeMessage = error instanceof Error && /safe result report written/.test(error.message)
      ? error.message
      : 'Runtime canary preflight or execution failed; no sensitive details were emitted.';
    console.error(safeMessage);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) await main();
