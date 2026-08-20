import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../src');

function safeMockModule(specifier: string, mockObj: Record<string, unknown>) {
  const exportsObj = {
    __esModule: true,
    default: 'default' in mockObj ? mockObj.default : mockObj,
    ...mockObj,
  };
  const opts = { exports: exportsObj };

  const specs = new Set<string>([specifier]);

  if (!specifier.startsWith('/') && !specifier.startsWith('.')) {
    specs.add(specifier);
    specs.add(specifier + '/index.js');
    specs.add(specifier + '/lib/index.js');
    try {
      const resolvedPkg = import.meta.resolve(specifier);
      specs.add(resolvedPkg);
      specs.add(pathToFileURL(resolvedPkg).href);
    } catch {}
  } else {
    const absPath = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(import.meta.dirname, specifier);

    const rawBasePath = absPath.endsWith('.js')
      ? absPath.slice(0, -3)
      : absPath.endsWith('.ts')
        ? absPath.slice(0, -2)
        : absPath;

    const basePaths = new Set<string>([rawBasePath]);
    if (rawBasePath.includes('/src/')) {
      basePaths.add(rawBasePath.replace('/src/', '/dist/'));
      basePaths.add(rawBasePath.replace('/src/', '/dist/src/'));
    }
    if (rawBasePath.includes('/dist/src/')) {
      basePaths.add(rawBasePath.replace('/dist/src/', '/src/'));
    }
    if (rawBasePath.includes('/dist/')) {
      basePaths.add(rawBasePath.replace('/dist/', '/src/'));
    }

    for (const b of basePaths) {
      for (const ext of ['', '.js', '.ts']) {
        const p = b + ext;
        specs.add(p);
        specs.add(pathToFileURL(p).href);
        try {
          if (fs.existsSync(p)) {
            const realP = fs.realpathSync(p);
            specs.add(realP);
            specs.add(pathToFileURL(realP).href);
          }
        } catch {}
      }
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

const mockConnection = {
  execute: mock.fn(async () => ({ rows: [], rowsAffected: 1 })),
  executeMany: mock.fn(async () => ({ rowsAffected: 2 })),
  close: mock.fn(async () => {}),
};

const mockPool = {
  getConnection: mock.fn(async () => mockConnection),
  close: mock.fn(async () => {}),
};

const mockOracledbFn = {
  createPool: mock.fn(() => Promise.resolve(mockPool)),
  initOracleClient: mock.fn(),
};

safeMockModule('oracledb', mockOracledbFn);

const mockConnectionModule = {
  initPool: mock.fn(() => Promise.resolve(mockPool)),
  setSessionContext: mock.fn(() => Promise.resolve()),
};

safeMockModule(path.join(srcDir, 'database/connection.js'), mockConnectionModule);

const mockAuthStore = {
  getStore: mock.fn(() => ({ uid: 'test-user' })),
};

const contextMock = { authStorage: mockAuthStore };

safeMockModule(path.join(srcDir, 'utils/context.js'), contextMock);

const { OracleAdapter } = await import(path.join(srcDir, 'database/adapters/oracleAdapter.js'));

describe('OracleAdapter', () => {
  let adapter: InstanceType<typeof OracleAdapter>;

  beforeEach(() => {
    mockConnection.execute.mock.resetCalls();
    mockConnection.executeMany.mock.resetCalls();
    mockConnection.close.mock.resetCalls();
    mockPool.getConnection.mock.resetCalls();
    adapter = new OracleAdapter();
  });

  test('connect, query, execute, executeMany', async () => {
    await adapter.connect();

    mockConnection.execute.mock.mockImplementation(async () => ({
      rows: [{ id: '1', name: 'Item 1' }],
      rowsAffected: 1,
    }));

    const rows = await adapter.query<{ id: string; name: string }>('SELECT * FROM test WHERE id = :id', { id: '1' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Item 1');

    const execRes = await adapter.execute('UPDATE test SET name = :name WHERE id = :id', { id: '1', name: 'New Name' });
    assert.strictEqual(execRes.rowsAffected, 1);

    const manyRes = await adapter.executeMany('INSERT INTO test (id) VALUES (:id)', [{ id: '2' }, { id: '3' }]);
    assert.strictEqual(manyRes.rowsAffected, 2);
  });

  test('searchVector and checkColumnExists', async () => {
    mockConnection.execute.mock.mockImplementation(async () => ({
      rows: [{ id: 'doc-1', score: 0.95 }],
      rowsAffected: 1,
    }));

    const results = await adapter.searchVector('ai_dreaming_memory', [0.1, 0.2, 0.3], 5, 'test-user');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'doc-1');

    mockConnection.execute.mock.mockImplementation(async () => ({
      rows: [{ cnt: 1 }],
      rowsAffected: 1,
    }));

    const exists = await adapter.checkColumnExists('ai_dreaming_memory', 'id');
    assert.strictEqual(exists, true);
  });

  test('graph operations (detectCircularDependencies, detectGodObjects, detectDeadCode)', async () => {
    mockConnection.execute.mock.mockImplementation(async () => ({
      rows: [{ entity_name: 'fn1', file_path: 'src/fn1.ts' }],
      rowsAffected: 1,
    }));

    const circular = await adapter.detectCircularDependencies('proj', 'test-user');
    assert.strictEqual(circular.length, 1);

    const godObjects = await adapter.detectGodObjects('proj', 'test-user');
    assert.strictEqual(godObjects.length, 1);

    const deadCode = await adapter.detectDeadCode('proj', 'test-user');
    assert.strictEqual(deadCode.length, 1);
  });

  test('disconnect closes pool', async () => {
    await adapter.connect();
    await adapter.disconnect();
    assert.strictEqual(mockPool.close.mock.calls.length, 1);
  });
});
