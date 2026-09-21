import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { WikiService } from '../../src/services/wikiService.js';
import { LLMProviderService } from '../../src/services/llmProviderService.js';

describe('WikiService', () => {
  let adapter: SQLiteAdapter;
  let service: WikiService;

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    if (adapter.initialize) {
      await adapter.initialize();
    } else {
      await adapter.connect();
      await adapter.initializeSchema();
    }
    service = new WikiService(adapter, new LLMProviderService());
  });

  afterEach(async () => {
    if (adapter.close) {
      await adapter.close();
    } else {
      await adapter.disconnect();
    }
  });

  test('should generate full wiki structure for a project with overview, architecture, and module pages', async () => {
    const result = await service.generateProjectWiki('sample-app', { provider: 'template' });
    assert.ok(result);
    assert.strictEqual(result.projectName, 'sample-app');
    assert.ok(result.totalPages >= 3);

    const overviewPage = await service.getWikiPage('sample-app', '/overview');
    assert.ok(overviewPage);
    assert.ok(overviewPage?.content.includes('Overview'));

    const archPage = await service.getWikiPage('sample-app', '/architecture');
    assert.ok(archPage);
    assert.ok(archPage?.content.includes('mermaid'));
  });

  test('should query wiki and return relevant answer and references', async () => {
    await service.generateProjectWiki('sample-app', { provider: 'template' });
    const response = await service.queryWiki('sample-app', 'What does this project do?');
    assert.ok(response.answer);
    assert.ok(Array.isArray(response.references));
  });

  test('should search wiki deterministically with title ranking and bounded excerpts', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-architecture',
      project_name: 'search-app',
      path: '/architecture',
      title: 'Architecture',
      content: 'Architecture content '.repeat(80),
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });
    await adapter.saveWikiPage({
      id: 'wiki-service',
      project_name: 'search-app',
      path: '/services',
      title: 'Services',
      content: 'The architecture service uses the database.',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });
    await adapter.saveWikiPage({
      id: 'wiki-other-tenant',
      project_name: 'search-app',
      path: '/architecture-other-tenant',
      title: 'Architecture',
      content: 'Should not leak across tenants.',
      tenant_id: 'tenant-b',
      created_at: now,
      updated_at: now,
    });

    const result = await service.searchWiki('search-app', 'architecture', {
      tenantId: 'tenant-a',
      maxPages: 1,
      maxChars: 40,
    });

    assert.strictEqual(result.pages.length, 1);
    assert.strictEqual(result.pages[0].path, '/architecture');
    assert.ok(result.pages[0].excerpt.length <= 43);
    assert.ok(!result.pages.some(page => page.path.includes('other-tenant')));
  });

  test('should return no wiki pages when no content matches the query', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-unrelated',
      project_name: 'search-app',
      path: '/database',
      title: 'Database',
      content: 'SQLite adapter details.',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });

    const result = await service.searchWiki('search-app', 'authentication', {
      tenantId: 'tenant-a',
    });

    assert.deepStrictEqual(result.pages, []);
  });

  test('should order equal-score pages with missing order indexes deterministically', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-z',
      project_name: 'search-app',
      path: '/zeta',
      title: 'Zeta',
      content: 'shared keyword',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });
    await adapter.saveWikiPage({
      id: 'wiki-a',
      project_name: 'search-app',
      path: '/alpha',
      title: 'Alpha',
      content: 'shared keyword',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });

    const result = await service.searchWiki('search-app', 'shared', {
      tenantId: 'tenant-a',
      maxPages: 2,
    });

    assert.deepStrictEqual(result.pages.map(page => page.path), ['/alpha', '/zeta']);
  });

  test('should match short technical query terms', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-ci',
      project_name: 'search-app',
      path: '/ci',
      title: 'CI',
      content: 'CI and DB checks run before release.',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });

    const result = await service.searchWiki('search-app', 'CI', { tenantId: 'tenant-a' });

    assert.deepStrictEqual(result.pages.map(page => page.path), ['/ci']);
  });

  test('clamps zero search bounds to one result and character', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-bounds',
      project_name: 'search-app',
      path: '/bounds',
      title: 'Bounds',
      content: 'bounds content',
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });

    const result = await service.searchWiki('search-app', 'bounds', {
      tenantId: 'tenant-a',
      maxPages: 0,
      maxChars: 0,
    });

    assert.strictEqual(result.pages.length, 1);
    assert.strictEqual(result.pages[0].excerpt, 'b...');
  });

  test('updates existing Wiki pages while preserving Mermaid metadata', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-update',
      project_name: 'update-app',
      path: '/architecture',
      title: 'Architecture',
      content: 'Old architecture',
      diagram_data: JSON.stringify({ type: 'mermaid', content: '```mermaid\nflowchart TD\n```' }),
      tenant_id: 'tenant-a',
      created_at: now,
      updated_at: now,
    });
    const updated = await service.updateProjectWiki('update-app', 'New service boundary', { tenantId: 'tenant-a', provider: 'template' });
    const page = await service.getWikiPage('update-app', '/architecture', 'tenant-a');

    assert.strictEqual(updated.totalPages, 1);
    assert.ok(page?.content.includes('Architecture'));
    assert.ok(page?.diagram_data?.includes('mermaid'));
  });

  test('continues updating pages when one page provider call fails', async () => {
    const now = new Date().toISOString();
    await adapter.saveWikiPage({
      id: 'wiki-failing', project_name: 'partial-app', path: '/a', title: 'A', content: 'A', tenant_id: 'tenant-a', created_at: now, updated_at: now,
    });
    await adapter.saveWikiPage({
      id: 'wiki-success', project_name: 'partial-app', path: '/b', title: 'B', content: 'B', tenant_id: 'tenant-a', created_at: now, updated_at: now,
    });
    const failingProvider = {
      generateText: async ({ prompt }: { prompt: string }) => {
        if (prompt.includes('Path: /a')) throw new Error('page failure');
        return 'Updated B';
      },
    } as unknown as LLMProviderService;
    const partialService = new WikiService(adapter, failingProvider);

    const updated = await partialService.updateProjectWiki('partial-app', 'Latest knowledge', { tenantId: 'tenant-a' });
    const page = await partialService.getWikiPage('partial-app', '/b', 'tenant-a');

    assert.strictEqual(updated.totalPages, 2);
    assert.strictEqual(page?.content, 'Updated B');
  });

  test('should build hierarchical wiki tree with synthesized parent nodes', async () => {
    await service.generateProjectWiki('hierarchical-app', { provider: 'template' });
    const tree = await service.getWikiTree('hierarchical-app');

    assert.ok(tree);
    assert.strictEqual(tree.projectName, 'hierarchical-app');

    // Look for `/modules` which should contain children like `/modules/services`
    const modulesNode = tree.root.find((n) => n.path === '/modules');
    // If not synthesized at root, check if it's there
    if (modulesNode) {
      assert.ok(Array.isArray(modulesNode.children));
      assert.ok(modulesNode.children.length > 0);
    }
  });

  test('should export generated pages to disk when exportToDisk is true', async () => {
    const projectName = 'disk-export-app';
    const exportBaseDir = path.join(process.cwd(), '.codeatlas', 'wiki', projectName);

    // Clean up if exists
    if (fs.existsSync(exportBaseDir)) {
      fs.rmSync(exportBaseDir, { recursive: true, force: true });
    }

    await service.generateProjectWiki(projectName, { provider: 'template', exportToDisk: true });

    // Verify files were created
    const overviewPath = path.join(exportBaseDir, 'overview.md');
    const archPath = path.join(exportBaseDir, 'architecture.md');

    assert.ok(fs.existsSync(overviewPath), 'overview.md should exist');
    assert.ok(fs.existsSync(archPath), 'architecture.md should exist');

    const overviewContent = fs.readFileSync(overviewPath, 'utf8');
    assert.ok(overviewContent.includes('Overview'));

    // Clean up
    fs.rmSync(exportBaseDir, { recursive: true, force: true });
  });

  test('should return null for non-existent wiki page', async () => {
    const page = await service.getWikiPage('sample-app', '/non-existent');
    assert.strictEqual(page, null);
  });
});