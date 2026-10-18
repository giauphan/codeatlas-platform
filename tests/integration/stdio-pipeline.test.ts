import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Removing authenticated stdio registration must break this real process flow.
test('configured stdio client can analyze a project and query its dependency graph', { timeout: 30_000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codeatlas-stdio-'));
  const project = path.join(workspace, 'sample');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"stdio-sample"}');
  await fs.writeFile(path.join(project, 'index.ts'), 'export function hello() { return "hello"; }');

  const client = new Client({ name: 'pipeline-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    cwd: workspace,
    env: {
      PATH: process.env.PATH || '',
      NODE_ENV: 'test',
      CODEATLAS_DB_TYPE: 'sqlite',
      CODEATLAS_SQLITE_PATH: path.join(workspace, 'pipeline.db'),
      CODEATLAS_USE_FIRESTORE: 'false',
      CODEATLAS_API_KEY: 'pipeline-regression-api-key',
      CODEATLAS_PROJECT_DIR: project,
      CODEATLAS_PROJECT_DIRS: project,
      CODEATLAS_MULTI_TENANT: 'false',
      MEMORY_AUTO_LOAD: 'false',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      PORT: '',
    },
    stderr: 'pipe',
  });
  // Drain diagnostic output without mixing it into the JSON-RPC channel.
  transport.stderr?.resume();

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'analyze'));

    const analysis = await client.callTool({ name: 'analyze', arguments: { projectDir: project } });
    assert.ok(!analysis.isError, JSON.stringify(analysis));
    const saved = JSON.parse(await fs.readFile(path.join(project, '.codeatlas', 'analysis.json'), 'utf8'));
    assert.equal(saved.totalFilesAnalyzed, 1);
    assert.ok(saved.graph.nodes.some((node: { label: string }) => node.label === 'hello'));

    const dependencies = await client.callTool({ name: 'get_dependencies', arguments: { project } });
    assert.ok(!dependencies.isError, JSON.stringify(dependencies));
    const graphText = (dependencies.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
    const graph = JSON.parse(graphText?.text || '{}');
    assert.ok(graph.dependencies.some((edge: { source: string; target: string }) => edge.source === 'index.ts' && edge.target === 'hello'));

    const memory = await client.callTool({ name: 'sync_system_memory', arguments: {
      project,
      changeDescription: 'Verified authenticated analysis and graph pipeline.',
    } });
    assert.ok(!memory.isError, JSON.stringify(memory));
    const memoryText = (memory.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
    const synced = JSON.parse(memoryText?.text || '{}');
    assert.equal(synced.success, true);
    assert.equal(synced.stats.changeDescriptionSaved, true);
  } finally {
    await client.close();
    await transport.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('MCP server without a validated session rejects tool execution', async () => {
  const originalAutoLoad = process.env.MEMORY_AUTO_LOAD;
  process.env.MEMORY_AUTO_LOAD = 'false';
  const { createMcpServer } = await import('../../src/presentation/mcpServer.js');
  const server = createMcpServer();
  const client = new Client({ name: 'unauthenticated-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await server.close();
    if (originalAutoLoad === undefined) delete process.env.MEMORY_AUTO_LOAD;
    else process.env.MEMORY_AUTO_LOAD = originalAutoLoad;
  }
});
