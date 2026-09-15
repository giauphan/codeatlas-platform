import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const { SQLiteAdapter } = await import(path.join(srcDir, 'database/adapters/sqliteAdapter.js'));

describe('Wiki DB', () => {
  let adapter: InstanceType<typeof SQLiteAdapter>;

  beforeEach(() => {
    process.env.CODEATLAS_SQLITE_PATH = ':memory:';
    adapter = new SQLiteAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  test('save/get/list/delete wiki pages', async () => {
    await adapter.connect();
    await adapter.initializeSchema();

    await adapter.saveWikiPage({
      id: 'w1',
      project_name: 'p1',
      path: '/intro',
      title: 'Intro',
      content: 'hello',
      tenant_id: 't1'
    });

    const fetched = await adapter.getWikiPage('p1', '/intro', 't1');
    assert.ok(fetched);
    assert.strictEqual(fetched!.title, 'Intro');

    const list = await adapter.listWikiPages('p1', 't1');
    assert.strictEqual(list.length, 1);

    await adapter.deleteWikiPages('p1', 't1');
    assert.strictEqual(await adapter.getWikiPage('p1', '/intro', 't1'), null);
  });
});
