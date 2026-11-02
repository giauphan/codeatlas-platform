import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeAcceptanceRequestHeaders, buildClaudeArgs, CLAUDE_SESSION_BUDGET_USD, resolveClaudeAcceptanceExecutable, selectClaudeAcceptanceModel, validateClaudeAcceptanceInput } from '../../scripts/memory-pipeline-claude-two-session-acceptance.mjs';

const valid = {
  optIn: '1',
  targetUrl: 'http://localhost:3381',
  apiKey: 'synthetic-test-key',
  projectDir: '/workspace/codeatlas-platform',
  projectId: 'project_platform',
  derivedProjectId: 'project_platform',
  sqlitePath: '/workspace/codeatlas-platform/data/codeatlas.db',
  expectedSqlitePath: '/workspace/codeatlas-platform/data/codeatlas.db',
};

test('live Claude acceptance requires explicit opt-in and the exact selected loopback API', () => {
  assert.equal(validateClaudeAcceptanceInput(valid).targetUrl, 'http://localhost:3381');
  assert.throws(() => validateClaudeAcceptanceInput({ ...valid, optIn: '0' }));
  for (const targetUrl of [
    'http://127.0.0.1:3381', 'http://localhost:54321', 'https://localhost:3381',
    'http://localhost:3381/api', 'http://user@localhost:3381', 'http://localhost:3381/?x=1',
  ]) assert.throws(() => validateClaudeAcceptanceInput({ ...valid, targetUrl }));
});

test('live Claude acceptance requires a derived canonical project and its exact SQLite database', () => {
  assert.throws(() => validateClaudeAcceptanceInput({ ...valid, projectId: 'project_other' }));
  assert.throws(() => validateClaudeAcceptanceInput({ ...valid, sqlitePath: '/tmp/other.sqlite' }));
  assert.throws(() => validateClaudeAcceptanceInput({ ...valid, apiKey: '' }));
});

test('each fresh Claude invocation is capped at one dollar and session two has no tools', () => {
  const first = buildClaudeArgs({ model: 'haiku', settingsPath: '/tmp/private/settings.json', tools: 'Bash', prompt: 'first prompt' });
  const second = buildClaudeArgs({ model: 'haiku', settingsPath: '/tmp/private/settings.json', tools: '', prompt: 'second prompt' });
  const debug = buildClaudeArgs({ model: 'haiku', settingsPath: '/tmp/private/settings.json', tools: 'Bash', prompt: 'debug prompt', debug: true });
  assert.equal(CLAUDE_SESSION_BUDGET_USD, '1.00');
  assert.equal(first[first.indexOf('--max-budget-usd') + 1], '1.00');
  assert.ok(first.includes('--allowedTools'));
  assert.equal(first[first.indexOf('--allowedTools') + 1], `Bash(${process.execPath} *)`);
  assert.equal(second[second.indexOf('--max-budget-usd') + 1], '1.00');
  assert.equal(second.includes('--allowedTools'), false);
  assert.ok(debug.includes('--debug=hooks,mcp'));
});

test('Claude acceptance API calls close idle sockets before provider sessions run', () => {
  assert.deepEqual(buildClaudeAcceptanceRequestHeaders('synthetic-test-key'), {
    'x-api-key': 'synthetic-test-key', connection: 'close',
  });
  assert.deepEqual(buildClaudeAcceptanceRequestHeaders('synthetic-test-key', true), {
    'x-api-key': 'synthetic-test-key', connection: 'close', 'content-type': 'application/json',
  });
});

test('Claude acceptance skips malformed model aliases and respects a valid trusted fallback', () => {
  assert.equal(selectClaudeAcceptanceModel({}, { env: {
    ANTHROPIC_MODEL: 'unsupported alias',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
  } }), 'claude-sonnet-4-5');
  assert.equal(selectClaudeAcceptanceModel({ CODEATLAS_CLAUDE_ACCEPTANCE_MODEL: 'codex/gpt-6-luna' }, {}), 'codex/gpt-6-luna');
  assert.throws(() => selectClaudeAcceptanceModel({ CODEATLAS_CLAUDE_ACCEPTANCE_MODEL: 'unsafe model name' }, {}));
});

test('Claude acceptance selects an explicit absolute executable without searching PATH', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-acceptance-exec-'));
  try {
    const executable = path.join(dir, 'claude');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(resolveClaudeAcceptanceExecutable({ HOME: dir, CODEATLAS_CLAUDE_ACCEPTANCE_EXECUTABLE: executable, PATH: '/untrusted' }), executable);
    assert.throws(() => resolveClaudeAcceptanceExecutable({ HOME: dir, CODEATLAS_CLAUDE_ACCEPTANCE_EXECUTABLE: 'claude' }));
    assert.throws(() => resolveClaudeAcceptanceExecutable({ HOME: dir, CODEATLAS_CLAUDE_ACCEPTANCE_EXECUTABLE: dir }));
    const nonExecutable = path.join(dir, 'not-executable');
    writeFileSync(nonExecutable, 'not executable', { mode: 0o600 });
    assert.throws(() => resolveClaudeAcceptanceExecutable({ HOME: dir, CODEATLAS_CLAUDE_ACCEPTANCE_EXECUTABLE: nonExecutable }));
    const defaultDir = path.join(dir, '.local', 'bin');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(path.join(defaultDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(resolveClaudeAcceptanceExecutable({ HOME: dir }), path.join(defaultDir, 'claude'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
