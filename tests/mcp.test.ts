import { test, describe } from 'node:test';
import assert from 'node:assert';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { server, getStats, discoverProjects } from '../index.js';

describe('Model Context Protocol (MCP) Server Integration', () => {
  test('should be a valid McpServer instance', () => {
    assert.ok(server, 'MCP Server should be defined');
    assert.ok(server instanceof McpServer, 'Server should be an instance of McpServer');
  });

  test('should have all 12 CodeAtlas enterprise tools registered', () => {
    // Access internal registered tools on the McpServer instance
    const registeredTools = (server as any)._registeredTools;
    assert.ok(registeredTools, 'Registered tools map/object should exist');

    const expectedTools = [
      'analyze',
      'list_projects',
      'get_project_structure',
      'get_dependencies',
      'get_insights',
      'search_entities',
      'get_file_entities',
      'generate_system_flow',
      'sync_system_memory',
      'trace_feature_flow',
      'generate_feature_flow_diagram',
      'detect_architectural_smells',
      'scan_enterprise_vulnerabilities'
    ];

    // Check if each tool is registered and has a description
    expectedTools.forEach(toolName => {
      const tool = registeredTools[toolName];
      assert.ok(tool, `Tool '${toolName}' should be registered`);
      assert.ok(tool.description, `Tool '${toolName}' should have a description`);
    });
  });

  test('should correctly normalize entity counts with getStats helper', () => {
    // Test empty/undefined stats
    const emptyStats = getStats({
      graph: { nodes: [], links: [] },
      totalFilesAnalyzed: 0,
      totalFilesSkipped: 0,
      entityCounts: { modules: 0, functions: 0, classes: 0, dependencies: 0, circularDeps: 0, deadCode: 0 },
      insights: []
    });

    assert.strictEqual(emptyStats.modules, 0);
    assert.strictEqual(emptyStats.functions, 0);

    // Test stats object populated (old structure)
    const oldStats = getStats({
      graph: { nodes: [], links: [] },
      totalFilesAnalyzed: 5,
      totalFilesSkipped: 0,
      stats: { files: 5, functions: 15, classes: 3, dependencies: 10, circularDeps: 1, deadCode: 2 } as any,
      insights: []
    } as any);

    assert.strictEqual(oldStats.modules, 5);
    assert.strictEqual(oldStats.functions, 15);
    assert.strictEqual(oldStats.classes, 3);
    assert.strictEqual(oldStats.circularDeps, 1);

    // Test entityCounts populated (new structure)
    const newStats = getStats({
      graph: { nodes: [], links: [] },
      totalFilesAnalyzed: 10,
      totalFilesSkipped: 0,
      entityCounts: { modules: 10, functions: 30, classes: 5, dependencies: 25, circularDeps: 0, deadCode: 0 },
      insights: []
    });

    assert.strictEqual(newStats.modules, 10);
    assert.strictEqual(newStats.functions, 30);
    assert.strictEqual(newStats.classes, 5);
  });

  test('should discover project analysis folder if present', () => {
    const discovered = discoverProjects();
    assert.ok(Array.isArray(discovered), 'discoverProjects should return an array');
  });
});
