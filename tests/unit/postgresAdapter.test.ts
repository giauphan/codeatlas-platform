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

  mock.module(specifier, opts);

  const specs = new Set<string>([specifier]);

  if (!specifier.startsWith('/') && !specifier.startsWith('.')) {
    specs.add(specifier);
    specs.add(specifier + '/index.js');
    specs.add(specifier + '/lib/index.js');
  } else if (specifier.startsWith('/')) {
    const rawBasePath = specifier.endsWith('.js')
      ? specifier.slice(0, -3)
      : specifier.endsWith('.ts')
        ? specifier.slice(0, -2)
        : specifier;

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

    const lastSegment = path.basename(rawBasePath);
    let subPathBase = lastSegment;
    if (rawBasePath.includes('/src/')) {
      const srcIdx = rawBasePath.indexOf('/src/');
      subPathBase = rawBasePath.slice(srcIdx + 5);
    }

    for (const name of new Set([subPathBase, lastSegment])) {
      for (const prefix of ['', './', '../', '../../', '../../../', '../../../../', 'src/']) {
        for (const ext of ['', '.js', '.ts']) {
          const spec = prefix + name + ext;
          specs.add(spec);
          if (spec.startsWith('./') || spec.startsWith('../')) {
            const resolvedAbs = path.resolve(import.meta.dirname, spec);
            specs.add(resolvedAbs);
            specs.add(pathToFileURL(resolvedAbs).href);
          }
        }
      }
    }
  }

  for (const s of specs) {
    try {
      mock.module(s, opts);
    } catch {}
  }
}

const mockPgClient = {
  query: mock.fn(async () => ({ rowCount: 1, rows: [] })),
  release: mock.fn(),
};

const mockPgPoolInstance = {
  connect: mock.fn(async () => mockPgClient),
  query: mock.fn(async () => ({ rows: [], rowCount: 1 })),
  end: mock.fn(async () => {}),
};

class MockPool {
  async connect() {
    return mockPgPoolInstance.connect();
  }
  async query(sql: string, params?: unknown[]) {
    return mockPgPoolInstance.query(sql, params);
  }
  async end() {
    return mockPgPoolInstance.end();
  }
}

const pgMock = { default: { Pool: MockPool }, Pool: MockPool };
safeMockModule('pg', pgMock);

const pgvectorMock = { default: { toSql: (arr: number[]) => `[${arr.join(',')}]` }, toSql: (arr: number[]) => `[${arr.join(',')}]` };
safeMockModule('pgvector/pg', pgvectorMock);
safeMockModule('pgvector', pgvectorMock);

const { PostgresAdapter } = await import(path.join(srcDir, 'database/adapters/postgresAdapter.js'));

describe('PostgresAdapter', () => {
  let adapter: InstanceType<typeof PostgresAdapter>;

  beforeEach(() => {
    mockPgPoolInstance.query.mock.resetCalls();
    mockPgPoolInstance.end.mock.resetCalls();
    mockPgClient.query.mock.resetCalls();
    mockPgClient.release.mock.resetCalls();
    adapter = new PostgresAdapter();
  });

  test('connect, initializeSchema, checkColumnExists', async () => {
    await adapter.connect();

    mockPgPoolInstance.query.mock.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ column_name: 'id' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await adapter.initializeSchema();

    const exists = await adapter.checkColumnExists('ai_dreaming_memory', 'id');
    assert.strictEqual(exists, true);
  });

  test('query, execute, executeMany CRUD operations', async () => {
    await adapter.connect();

    mockPgPoolInstance.query.mock.mockImplementation(async () => ({
      rows: [{ id: 'pg-1', name: 'Postgres Test' }],
      rowCount: 1,
    }));

    const rows = await adapter.query<{ id: string; name: string }>('SELECT * FROM test WHERE id = $1', ['pg-1']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Postgres Test');

    const execRes = await adapter.execute('UPDATE test SET name = $1 WHERE id = $2', ['New Name', 'pg-1']);
    assert.strictEqual(execRes.rowsAffected, 1);

    const manyRes = await adapter.executeMany('INSERT INTO test (id) VALUES ($1)', [{ id: 'pg-2' }, { id: 'pg-3' }]);
    assert.strictEqual(manyRes.rowsAffected, 2);
  });

  test('searchVector', async () => {
    await adapter.connect();

    mockPgPoolInstance.query.mock.mockImplementation(async () => ({
      rows: [{ id: 'doc-1', score: 0.92 }],
      rowCount: 1,
    }));

    const searchRes = await adapter.searchVector('ai_dreaming_memory', [0.1, 0.2, 0.3], 5, 'tenant-1');
    assert.strictEqual(searchRes.length, 1);
    assert.strictEqual(searchRes[0].id, 'doc-1');
  });

  test('graph operations (detectCircularDependencies, detectGodObjects, detectDeadCode)', async () => {
    await adapter.connect();

    mockPgPoolInstance.query.mock.mockImplementation(async () => ({
      rows: [{ entity_name: 'fn1', file_path: 'src/fn1.ts' }],
      rowCount: 1,
    }));

    const circular = await adapter.detectCircularDependencies('proj1', 't1');
    assert.strictEqual(circular.length, 1);

    const godObjects = await adapter.detectGodObjects('proj1', 't1');
    assert.strictEqual(godObjects.length, 1);

    const deadCode = await adapter.detectDeadCode('proj1', 't1');
    assert.strictEqual(deadCode.length, 1);
  });

  test('disconnect ends pool', async () => {
    await adapter.connect();
    await adapter.disconnect();
    assert.strictEqual(mockPgPoolInstance.end.mock.calls.length, 1);
  });
});
