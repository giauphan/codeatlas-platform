import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';

describe('SQLiteAdapter boolean binding (sanitizeParam)', () => {
  test('array params: true -> 1, false -> 0', async () => {
    const a = new SQLiteAdapter();
    await a.connect();
    await a.initializeSchema();
    await a.execute('DELETE FROM activity_log');
    await a.execute('INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (?, ?, ?, ?)', ['t1', 'ten1', 'x', true]);
    await a.execute('INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (?, ?, ?, ?)', ['t2', 'ten1', 'x', false]);
    const rows = await a.query<{ id: string; success: number }>('SELECT id, success FROM activity_log ORDER BY id');
    assert.equal(rows.find(r => r.id === 't1')!.success, 1);
    assert.equal(rows.find(r => r.id === 't2')!.success, 0);
    await a.disconnect();
  });

  test('named params: true -> 1, false -> 0', async () => {
    const a = new SQLiteAdapter();
    await a.connect();
    await a.initializeSchema();
    await a.execute('DELETE FROM activity_log');
    await a.execute('INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (:id, :tid, :tool, :success)', { id: 'n1', tid: 'ten1', tool: 'x', success: true });
    await a.execute('INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (:id, :tid, :tool, :success)', { id: 'n2', tid: 'ten1', tool: 'x', success: false });
    const rows = await a.query<{ id: string; success: number }>('SELECT id, success FROM activity_log ORDER BY id');
    assert.equal(rows.find(r => r.id === 'n1')!.success, 1);
    assert.equal(rows.find(r => r.id === 'n2')!.success, 0);
    await a.disconnect();
  });

  test('activity_log success column stores integer not boolean string', async () => {
    const a = new SQLiteAdapter();
    await a.connect();
    await a.initializeSchema();
    await a.execute('DELETE FROM activity_log');
    await a.execute('INSERT INTO activity_log (id, tenant_id, tool, success) VALUES (:id, :tid, :tool, :success)', { id: 'c1', tid: 'ten1', tool: 'x', success: true });
    const row = await a.query<{ success: unknown }>('SELECT success, typeof(success) as t FROM activity_log WHERE id = :id', { id: 'c1' });
    assert.equal((row[0] as any).success, 1);
    await a.disconnect();
  });
});
