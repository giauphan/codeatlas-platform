import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { LLMProviderService } from '../../src/services/llmProviderService.js';
import { WikiService } from '../../src/services/wikiService.js';
import { createWikiRouter } from '../../src/presentation/routes/wikiRoutes.js';

describe('Wiki Routes Integration Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  let adapter: SQLiteAdapter;
  let wikiService: WikiService;

  before(async () => {
    adapter = new SQLiteAdapter();
    await adapter.connect();
    await adapter.initializeSchema();

    const llmProvider = new LLMProviderService({ provider: 'mock' });
    wikiService = new WikiService(adapter, llmProvider);

    const app = express();
    app.use(express.json());
    app.use('/api/wiki', createWikiRouter(wikiService));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (adapter) {
      await adapter.disconnect();
    }
  });

  test('POST /api/wiki/:project/generate generates wiki pages', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'mock',
        exportToDisk: false
      })
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { projectName: string; root: any[]; totalPages: number };
    assert.strictEqual(body.projectName, 'test-proj');
    assert.ok(Array.isArray(body.root));
  });

  test('GET /api/wiki/:project/tree retrieves the wiki tree hierarchy', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/tree`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { projectName: string; root: any[]; totalPages: number };
    assert.strictEqual(body.projectName, 'test-proj');
    assert.ok(Array.isArray(body.root));
    assert.ok(body.totalPages > 0);
  });

  test('GET /api/wiki/:project/page retrieves specific page', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/page?path=/overview`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { title: string; path: string; content: string };
    assert.strictEqual(body.path, '/overview');
    assert.ok(body.content.length > 0);
  });

  test('GET /api/wiki/:project/page returns 404 when page does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/page?path=/non-existent`);
    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error);
  });

  test('GET /api/wiki/:project/page returns 400 when path query is missing', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/page`);
    assert.strictEqual(res.status, 400);
  });

  test('POST /api/wiki/:project/query performs Q&A on wiki pages', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'What is the architecture of this project?'
      })
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { answer: string; references: string[] };
    assert.ok(typeof body.answer === 'string');
    assert.ok(Array.isArray(body.references));
  });

  test('POST /api/wiki/:project/query returns 400 if query is missing', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/test-proj/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.strictEqual(res.status, 400);
  });
});
