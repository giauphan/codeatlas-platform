import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnalysisResult, GraphData } from '../../src/types/index.js';

let loaded: { projectName: string; projectDir: string; analysis: AnalysisResult } | null;

mock.module('../../src/services/authService.js', {
  namedExports: {
    checkAuth: async () => ({ tier: 'premium', uid: 'graph-test', keyId: 'test-key' }),
    logActivity: async () => {},
  },
});
mock.module('../../src/services/projectService.js', {
  namedExports: {
    discoverProjectsAsync: async () => [],
    fileExists: async () => true,
    getStats: () => ({}),
    loadAnalysisAsync: async () => loaded,
  },
});

// Graph queries do not need the memory controller's import-time database initialization.
const previousAutoLoad = process.env.MEMORY_AUTO_LOAD;
process.env.MEMORY_AUTO_LOAD = 'false';
const { registerTools } = await import('../../src/presentation/mcpTools.js');
if (previousAutoLoad === undefined) delete process.env.MEMORY_AUTO_LOAD;
else process.env.MEMORY_AUTO_LOAD = previousAutoLoad;

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResult>;
const handlers = new Map<string, ToolHandler>();

function setGraph(graph: GraphData): void {
  loaded = {
    projectName: 'graph-fixture',
    projectDir: '/workspace/graph-fixture',
    analysis: {
      graph,
      insights: [],
      entityCounts: { modules: 0, functions: graph.nodes.length, classes: 0, dependencies: graph.links.length, circularDeps: 0 },
      totalFilesAnalyzed: 1,
      totalFilesSkipped: 0,
    },
  };
}

async function callTool(name: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} must be registered`);
  return JSON.parse((await handler(params)).content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  handlers.clear();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(server, { tier: 'premium', uid: 'graph-test', keyId: 'test-key' });
  setGraph({
    nodes: [
      { id: 'id-hidden-source', label: 'Alpha', type: 'function' },
      { id: 'id-hidden-target', label: 'Beta', type: 'function' },
      { id: 'empty-label', label: '', type: 'function' },
    ],
    links: [
      { source: 'id-hidden-source', target: 'id-hidden-target', type: 'call' },
      { source: 'id-hidden-source', target: 'id-hidden-target', type: 'call' },
      { source: 'external:Alpha', target: 'id-hidden-target', type: 'import' },
      { source: 'empty-label', target: 'external:Beta', type: 'call' },
    ],
  });
});

describe('MCP graph queries', () => {
  test('system diagrams filter endpoints, scope and duplicate links without mutating cached graphs', async () => {
    const graph: GraphData = {
      nodes: [
        { id: 'a', label: 'A', type: 'module', filePath: 'a.ts' },
        { id: 'b', label: 'B', type: 'module', filePath: 'b.ts' },
        { id: 'fn', label: 'Run', type: 'function', filePath: 'a.ts' },
      ],
      links: [
        { source: 'a', target: 'b', type: 'import' },
        { source: 'a', target: 'b', type: 'import' },
        { source: 'a', target: 'b', type: 'call' },
        { source: 'a', target: 'fn', type: 'contains' },
        { source: 'a', target: 'missing', type: 'import' },
      ],
    };
    setGraph(graph);
    const modules = await callTool('generate_system_flow', { scope: 'modules-only' });
    assert.equal(modules.nodeCount, 2);
    assert.equal(modules.linkCount, 1);
    const full = await callTool('generate_system_flow', { scope: 'full' });
    assert.equal(full.nodeCount, 3);
    assert.equal(full.linkCount, 3);
    assert.equal((await callTool('generate_system_flow', { scope: 'modules-only', maxNodes: 1 })).linkCount, 0);
    assert.equal(graph.links.length, 5);
    assert.equal(graph.nodes.length, 3);
  });

  test('dependency filters match known labels and fall back to unresolved or empty labels', async () => {
    assert.deepEqual((await callTool('get_dependencies', { source: 'ALPHA', target: 'beta' })).dependencies, [
      { source: 'Alpha', target: 'Beta', type: 'call' },
      { source: 'external:Alpha', target: 'Beta', type: 'import' },
    ]);
    assert.equal((await callTool('get_dependencies', { source: 'id-hidden' })).showing, 0);
    assert.equal((await callTool('get_dependencies', { target: 'id-hidden' })).showing, 0);
    assert.deepEqual((await callTool('get_dependencies', { source: 'empty-label', target: 'external:BETA' })).dependencies, [
      { source: 'empty-label', target: 'external:Beta', type: 'call' },
    ]);
  });

  test('dependency filtering deduplicates before limiting and preserves cached graph order', async () => {
    const original = structuredClone(loaded!.analysis.graph);
    assert.deepEqual(await callTool('get_dependencies', { relationship: 'call', source: '', target: '', limit: 1 }), {
      total: 4,
      showing: 1,
      truncated: true,
      dependencies: [{ source: 'Alpha', target: 'Beta', type: 'call' }],
    });
    assert.deepEqual((await callTool('get_dependencies', { relationship: 'all' })).dependencies, [
      { source: 'Alpha', target: 'Beta', type: 'call' },
      { source: 'external:Alpha', target: 'Beta', type: 'import' },
      { source: 'empty-label', target: 'external:Beta', type: 'call' },
    ]);
    assert.deepEqual(loaded!.analysis.graph, original);
  });

  test('feature execution order handles branches, duplicates, disconnected nodes and cycles', async () => {
    setGraph({
      nodes: ['Entry', 'Left', 'Right', 'Join', 'Isolated', 'CycleA', 'CycleB'].map(name => ({
        id: name, label: `Flow${name}`, type: 'function', filePath: `/workspace/graph-fixture/${name}.ts`, line: 1,
      })),
      links: [
        { source: 'Entry', target: 'Left', type: 'call' },
        { source: 'Entry', target: 'Right', type: 'call' },
        { source: 'Left', target: 'Join', type: 'call' },
        { source: 'Right', target: 'Join', type: 'call' },
        { source: 'Left', target: 'Join', type: 'call' },
        { source: 'CycleA', target: 'CycleB', type: 'call' },
        { source: 'CycleB', target: 'CycleA', type: 'call' },
        { source: 'Entry', target: 'CycleA', type: 'contains' },
      ],
    });

    const flow = await callTool('generate_feature_flow_diagram', { keyword: 'Flow' });
    assert.equal(flow.callRelationships, 6);
    assert.deepEqual(flow.executionOrder, [
      { step: 1, name: 'FlowEntry', type: 'function', file: 'Entry.ts', line: 1, callsTo: ['FlowLeft', 'FlowRight'], calledBy: [] },
      { step: 2, name: 'FlowIsolated', type: 'function', file: 'Isolated.ts', line: 1, callsTo: [], calledBy: [] },
      { step: 3, name: 'FlowLeft', type: 'function', file: 'Left.ts', line: 1, callsTo: ['FlowJoin'], calledBy: ['FlowEntry'] },
      { step: 4, name: 'FlowRight', type: 'function', file: 'Right.ts', line: 1, callsTo: ['FlowJoin'], calledBy: ['FlowEntry'] },
      { step: 5, name: 'FlowJoin', type: 'function', file: 'Join.ts', line: 1, callsTo: [], calledBy: ['FlowLeft', 'FlowRight'] },
      { step: 6, name: 'FlowCycleA', type: 'function', file: 'CycleA.ts', line: 1, callsTo: ['FlowCycleB'], calledBy: ['FlowCycleB'] },
      { step: 7, name: 'FlowCycleB', type: 'function', file: 'CycleB.ts', line: 1, callsTo: ['FlowCycleA'], calledBy: ['FlowCycleA'] },
    ]);
    assert.deepEqual((await callTool('generate_feature_flow_diagram', { keyword: 'Flow', diagramType: 'sequence' })).executionOrder, flow.executionOrder);
  });
});
