import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCanaryReconciliationPayload, buildCanaryRequestHeaders, loadCompiledProjectIdentity, validateRuntimeCanaryInput } from '../../scripts/memory-pipeline-runtime-canary.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/memory-pipeline-runtime-canary.mjs');
const platformRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mcpRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../codeatlas-mcp-server');

test('runtime canary refuses to run without explicit opt-in before doing target work', () => {
  assert.throws(() => validateRuntimeCanaryInput({}), /CODEATLAS_MEMORY_RUNTIME_CANARY=1/);
  const child = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/tmp' },
    timeout: 5_000,
  });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /explicit opt-in/);
  assert.doesNotMatch(child.stderr, /api[_-]?key|https?:\/\/|token/i);
});

test('runtime canary accepts only the selected loopback endpoint and exact project identity', () => {
  const valid = validateRuntimeCanaryInput({
    optIn: '1',
    targetUrl: 'http://localhost:3381',
    apiKey: 'synthetic-test-key',
    projectDir: '/workspace/project',
    projectId: 'project_expected',
    derivedProjectId: 'project_expected',
  });
  assert.equal(valid.targetUrl, 'http://localhost:3381/');
  assert.equal(valid.projectId, 'project_expected');
  for (const targetUrl of [
    'http://example.com:3381',
    'http://127.0.0.1:8088',
    'http://user:password@localhost:3381',
    'http://localhost:3381/private',
    'http://localhost:3381/?key=value',
  ]) {
    assert.throws(() => validateRuntimeCanaryInput({
      optIn: '1', targetUrl, apiKey: 'synthetic-test-key', projectDir: '/workspace/project',
      projectId: 'project_expected', derivedProjectId: 'project_expected',
    }), /target must be http loopback on port 3381/);
  }
  assert.throws(() => validateRuntimeCanaryInput({
    optIn: '1', targetUrl: 'http://localhost:3381', apiKey: 'synthetic-test-key', projectDir: '/workspace/project',
    projectId: 'project_other', derivedProjectId: 'project_expected',
  }), /does not match the derived canonical project identity/);
  assert.throws(() => validateRuntimeCanaryInput({
    optIn: '1', targetUrl: 'http://localhost:3381', apiKey: '', projectDir: '/workspace/project',
    projectId: 'project_expected', derivedProjectId: 'project_expected',
  }), /authenticated API key is required/);
});

test('real isolated native installer registers quoted compiled CLI routes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-canary-installer-test-'));
  try {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const setup = path.join(mcpRepo, 'scripts', 'setup-hooks.js');
    const cli = path.join(mcpRepo, 'dist', 'index.js');
    const { status, stderr } = spawnSync(process.execPath, [setup, settingsPath], {
      encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: root },
    });
    assert.equal(status, 0, stderr);
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const [event, route] of Object.entries({
      SessionStart: 'brain-context', UserPromptSubmit: 'brain-context', PostToolUse: 'brain-save',
      PostToolUseFailure: 'brain-save', Stop: 'brain-save', PreCompact: 'brain-save',
    })) {
      const commands = installed.hooks[event].flatMap(group => group.hooks || []).map(hook => hook.command || '');
      assert.ok(commands.some(command => command.includes(cli) && new RegExp(`\\bhook\\s+${route}$`).test(command)), `${event} did not register ${route}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canary loads canonical identity from the real compiled MCP artifact path', async () => {
  const identity = await loadCompiledProjectIdentity(mcpRepo, platformRepo);
  assert.equal(identity.canonical_root, platformRepo);
  assert.match(identity.project_id, /^project_[a-f0-9]{64}$/);
  assert.equal((await loadCompiledProjectIdentity(mcpRepo, platformRepo)).project_id, identity.project_id);
});

test('canary reconciliation is restricted to its exact Stop marker and one event', () => {
  assert.deepEqual(buildCanaryReconciliationPayload('project_expected', 'claude_stop_marker'), {
    project_id: 'project_expected', event_id: 'claude_stop_marker', limit: 1,
  });
  assert.throws(() => buildCanaryReconciliationPayload('project_expected', ''), /exact event ID/);
  assert.throws(() => buildCanaryReconciliationPayload('project_expected', 'x'.repeat(256)), /exact event ID/);
});

test('canary API requests close idle connections before long hook work can stale them', () => {
  assert.deepEqual(buildCanaryRequestHeaders('synthetic-test-key'), {
    'x-api-key': 'synthetic-test-key', connection: 'close',
  });
  assert.deepEqual(buildCanaryRequestHeaders('synthetic-test-key', true), {
    'x-api-key': 'synthetic-test-key', connection: 'close', 'content-type': 'application/json',
  });
});
