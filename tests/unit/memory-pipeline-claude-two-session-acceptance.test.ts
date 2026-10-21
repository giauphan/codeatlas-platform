import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaudeAcceptanceRequestHeaders, buildClaudeArgs, CLAUDE_SESSION_BUDGET_USD, selectClaudeAcceptanceModel, validateClaudeAcceptanceInput } from '../../scripts/memory-pipeline-claude-two-session-acceptance.mjs';

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
  assert.equal(CLAUDE_SESSION_BUDGET_USD, '1.00');
  assert.equal(first[first.indexOf('--max-budget-usd') + 1], '1.00');
  assert.ok(first.includes('--allowedTools'));
  assert.equal(second[second.indexOf('--max-budget-usd') + 1], '1.00');
  assert.equal(second.includes('--allowedTools'), false);
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
