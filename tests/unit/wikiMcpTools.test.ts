import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/presentation/mcpTools.js';
import { SQLiteAdapter } from '../../src/database/adapters/sqliteAdapter.js';
import { setDatabaseAdapter, resetDatabaseAdapter } from '../../src/database/factory.js';
import { WikiService } from '../../src/services/wikiService.js';

describe('DeepWiki MCP Tools', () => {
  let adapter: SQLiteAdapter;
  let registeredTools: Map<string, { description: string; schema: any; handler: Function }>;
  let mockServer: McpServer;

  beforeEach(async () => {
    adapter = new SQLiteAdapter(':memory:');
    if (adapter.initialize) {
      await adapter.initialize();
    } else {
      await adapter.connect();
      await adapter.initializeSchema();
    }
    setDatabaseAdapter(adapter);
    WikiService.resetInstance();

    registeredTools = new Map();
    mockServer = {
      tool: (name: string, description: string, schema: any, handler: Function) => {
        registeredTools.set(name, { description, schema, handler });
      }
    } as unknown as McpServer;

    registerTools(mockServer, { tier: 'premium', uid: 'test-user', keyId: 'test-key' });
  });

  afterEach(async () => {
    if (adapter.close) {
      await adapter.close();
    } else {
      await adapter.disconnect();
    }
    resetDatabaseAdapter();
    WikiService.resetInstance();
  });

  test('should register generate_project_wiki, get_wiki_page, and query_project_wiki', () => {
    assert.ok(registeredTools.has('generate_project_wiki'), 'generate_project_wiki tool should be registered');
    assert.ok(registeredTools.has('get_wiki_page'), 'get_wiki_page tool should be registered');
    assert.ok(registeredTools.has('query_project_wiki'), 'query_project_wiki tool should be registered');
  });

  test('generate_project_wiki tool handler should generate wiki pages and return success summary', async () => {
    const tool = registeredTools.get('generate_project_wiki');
    assert.ok(tool, 'generate_project_wiki must be found');

    const result = await tool.handler({
      project: 'sample-project',
      provider: 'template',
      exportToDisk: false
    });

    assert.ok(result);
    assert.ok(Array.isArray(result.content));
    assert.strictEqual(result.content[0].type, 'text');

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.projectName, 'sample-project');
    assert.ok(parsed.totalPages >= 3);
  });

  test('get_wiki_page tool handler should return content when page exists and error when page does not exist', async () => {
    // Generate wiki first
    const genTool = registeredTools.get('generate_project_wiki');
    assert.ok(genTool);
    await genTool.handler({
      project: 'sample-project',
      provider: 'template'
    });

    const getTool = registeredTools.get('get_wiki_page');
    assert.ok(getTool);

    // Existing page
    const existingResult = await getTool.handler({
      project: 'sample-project',
      path: '/overview'
    });
    assert.ok(existingResult);
    assert.strictEqual(existingResult.content[0].type, 'text');
    const existingPage = JSON.parse(existingResult.content[0].text);
    assert.strictEqual(existingPage.title, 'Overview');
    assert.strictEqual(existingPage.path, '/overview');
    assert.ok(existingPage.content.includes('Overview'));

    // Non-existent page
    const missingResult = await getTool.handler({
      project: 'sample-project',
      path: '/not-real'
    });
    assert.ok(missingResult);
    assert.strictEqual(missingResult.isError, true);
    const missingPage = JSON.parse(missingResult.content[0].text);
    assert.strictEqual(missingPage.error, 'Wiki page not found');
  });

  test('query_project_wiki tool handler should return answers and references', async () => {
    // Generate wiki first
    const genTool = registeredTools.get('generate_project_wiki');
    assert.ok(genTool);
    await genTool.handler({
      project: 'sample-project',
      provider: 'template'
    });

    const queryTool = registeredTools.get('query_project_wiki');
    assert.ok(queryTool);

    const result = await queryTool.handler({
      project: 'sample-project',
      query: 'What is the architecture of the system?'
    });

    assert.ok(result);
    assert.strictEqual(result.content[0].type, 'text');
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.answer);
    assert.ok(Array.isArray(parsed.references));
  });

  test('search_project_wiki tool should be registered', () => {
    assert.ok(registeredTools.has('search_project_wiki'), 'search_project_wiki tool should be registered');
  });

  test('search_project_wiki tool handler should return matching pages', async () => {
    // Generate wiki first
    const genTool = registeredTools.get('generate_project_wiki');
    assert.ok(genTool);
    await genTool.handler({
      project: 'sample-project',
      provider: 'template'
    });

    const searchTool = registeredTools.get('search_project_wiki');
    assert.ok(searchTool);

    const result = await searchTool.handler({
      project: 'sample-project',
      query: 'architecture overview',
      limit: 3
    });

    assert.ok(result);
    assert.strictEqual(result.content[0].type, 'text');
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(parsed.pages));
    assert.ok(parsed.pages.length >= 0);
    assert.ok(parsed.pages.length <= 3);

    for (const page of parsed.pages) {
      assert.ok(page.path);
      assert.ok(page.title);
      assert.ok(page.excerpt);
    }
  });

  test('search_project_wiki handler should respect limit', async () => {
    const genTool = registeredTools.get('generate_project_wiki');
    assert.ok(genTool);
    await genTool.handler({
      project: 'sample-project',
      provider: 'template'
    });

    const searchTool = registeredTools.get('search_project_wiki');
    assert.ok(searchTool);

    const result = await searchTool.handler({
      project: 'sample-project',
      query: 'overview',
      limit: 1
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.pages.length <= 1);
  });
});