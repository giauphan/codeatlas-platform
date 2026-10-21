import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'codeatlas-platform-tests-'));
const home = path.join(scratchRoot, 'home');
const projectsRoot = path.join(scratchRoot, 'projects');
const sqlitePath = path.join(scratchRoot, 'platform-tests.sqlite');
const tempPath = path.join(scratchRoot, 'tmp');

await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(projectsRoot, { recursive: true }),
  mkdir(tempPath, { recursive: true }),
]);

// Keep only toolchain/runtime variables required by tests. In particular, do
// not inherit an operator database selector, provider credential, or API URL.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => new Set([
    'PATH', 'NODE_PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  ]).has(name)),
);
Object.assign(childEnv, {
  HOME: home,
  TMPDIR: tempPath,
  TMP: tempPath,
  TEMP: tempPath,
  NODE_ENV: 'test',
  CODEATLAS_DB_TYPE: 'sqlite',
  CODEATLAS_SQLITE_PATH: sqlitePath,
  CODEATLAS_USE_FIRESTORE: 'false',
  CODEATLAS_PROJECTS_ROOT: projectsRoot,
  CODEATLAS_PROJECT_DIR: projectsRoot,
  CODEATLAS_PROJECT_DIRS: JSON.stringify([projectsRoot]),
  CRON_SETTINGS_PATH: path.join(scratchRoot, 'cron-settings.json'),
  CODEATLAS_API_URL: 'http://127.0.0.1:1',
  CODEATLAS_API_KEY: 'synthetic-platform-test-key',
  API_KEY_PEPPER: 'synthetic-platform-test-pepper',
  PORT: '0',
});

// These opt-ins run deterministic local fixture evaluations only. Preserve
// them when explicitly enabled so `npm test` can include the full quality
// suite without admitting model/provider execution flags.
for (const name of [
  'RUN_MEMORY_EXTRACTION_HOLDOUT',
  'RUN_MEMORY_EXTRACTION_INDEPENDENT',
  'RUN_MEMORY_EXTRACTION_RELEASE',
  'RUN_MEMORY_EXTRACTION_FINAL',
]) {
  if (process.env[name] === '1') childEnv[name] = '1';
}

// Empty values are intentional: dotenv.config() uses override:false, so these
// sentinels also prevent repository/parent .env files from restoring secrets
// or enabling a real provider after the sanitized environment is created.
for (const name of [
  'A2A_MCP_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'EMBEDDING_MODELS', 'NVIDIA_EMBEDDING_MODELS',
  'EMBEDDING_DIM', 'NVIDIA_EMBEDDING_DIM', 'EMBEDDING_DEBUG',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY', 'FIREBASE_CONFIG', 'VITE_FIREBASE_PROJECT_ID',
  'CODEATLAS_ALLOWED_LLM_HOSTS',
  'CODEATLAS_MEMORY_EXTRACTION_API_KEY', 'CODEATLAS_MEMORY_EXTRACTION_MODEL', 'CODEATLAS_MEMORY_EXTRACTION_URL',
  'CODEATLAS_LIVE_HOST_TEST', 'CODEATLAS_LIVE_HOST_MODEL', 'CODEATLAS_POSTGRES_ACCEPTANCE',
  'RUN_MODEL_MEMORY_PIPELINE', 'RUN_MODEL_MEMORY_QUALITY',
  'DATABASE_URL', 'POSTGRES_DB', 'POSTGRES_HOST', 'POSTGRES_PASSWORD', 'POSTGRES_PORT', 'POSTGRES_USER',
  'MYSQL_DATABASE', 'MYSQL_HOST', 'MYSQL_PASSWORD', 'MYSQL_PORT', 'MYSQL_USER',
]) childEnv[name] = '';

const requestedArgs = process.argv.slice(2);
const explicitTestFiles = requestedArgs.filter((argument) => argument.endsWith('.test.ts'));
for (const file of explicitTestFiles) {
  const resolved = path.resolve(repositoryRoot, file);
  if (path.isAbsolute(file) || !resolved.startsWith(`${path.join(repositoryRoot, 'tests')}${path.sep}`)) {
    throw new Error(`Explicit test files must be relative paths under tests/: ${file}`);
  }
}
const testArguments = explicitTestFiles.length
  ? [...explicitTestFiles, ...requestedArgs.filter((argument) => !explicitTestFiles.includes(argument))]
  : ['tests/**/*.test.ts', ...requestedArgs];

const nodeArgs = [
  '--experimental-test-module-mocks',
  '--test-concurrency=1',
  '--import', 'tsx',
  '--test',
  ...testArguments,
];

let child;
let receivedSignal;
const onSignal = (signal) => {
  receivedSignal = signal;
  child?.kill(signal);
};

function signalExitCode(signal) {
  const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
  return 128 + (signals[signal] ?? 1);
}

async function inspectIsolatedStartupDatabase() {
  const info = await stat(sqlitePath).catch(() => null);
  if (!info || info.size === 0) {
    process.stdout.write('Test isolation diagnostic: no disposable SQLite database was observed.\n');
    return;
  }

  try {
    const require = createRequire(path.join(repositoryRoot, 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    let initializationRows = null;
    try {
      const hasMemoryTable = db.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = 'ai_episodic_memory'
      `).get();
      if (hasMemoryTable) {
        const result = db.prepare(`
          SELECT COUNT(*) AS count
          FROM ai_episodic_memory
          WHERE tenant_id = '_system'
            AND event_type = 'BUSINESS_RULE'
            AND event_data LIKE '%system_initialization%'
        `).get();
        initializationRows = Number(result?.count ?? 0);
      }
    } finally {
      db.close();
    }
    process.stdout.write(`Test isolation diagnostic: disposable SQLite observed; system initialization rows=${initializationRows ?? 'unavailable'}.\n`);
  } catch {
    // This is evidence only. Early failures, filtered tests, or future removal
    // of eager initialization must not change the test process exit status.
    process.stdout.write('Test isolation diagnostic: disposable SQLite observed; initialization row count unavailable.\n');
  }
}

let exitCode = 1;
try {
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  child = spawn(process.execPath, nodeArgs, {
    cwd: repositoryRoot,
    env: childEnv,
    stdio: 'inherit',
  });

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  if (receivedSignal || result.signal) exitCode = signalExitCode(receivedSignal || result.signal);
  else exitCode = Number.isInteger(result.code) ? result.code : 1;

  const runWasFiltered = process.argv.length > 2;
  if (!runWasFiltered && !receivedSignal) await inspectIsolatedStartupDatabase();
} catch (error) {
  process.stderr.write(`Isolated test runner failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  exitCode = 1;
} finally {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await rm(scratchRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;
