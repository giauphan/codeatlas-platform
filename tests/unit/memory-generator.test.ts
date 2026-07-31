import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { generateMemory } from '../../src/services/memoryGenerator.js';
import { AnalysisResult, GraphData } from '../../src/types/index.js';

describe('Memory Generator', () => {
  const workspaceRoot = path.join(process.cwd(), 'tests', 'mock_workspace');
  const memoryDir = path.join(workspaceRoot, '.agents', 'memory');
  const rulesDir = path.join(workspaceRoot, '.agents', 'rules');

  const mockGraphData: GraphData = {
    nodes: [
      { id: 'moduleA', label: 'moduleA.ts', type: 'module', filePath: path.join(workspaceRoot, 'src', 'moduleA.ts') },
      { id: 'moduleB', label: 'moduleB.ts', type: 'module', filePath: path.join(workspaceRoot, 'src', 'moduleB.ts') },
      { id: 'func1', label: 'func1', type: 'function' },
      { id: 'class1', label: 'class1', type: 'class' },
    ],
    links: [
      { source: 'moduleA', target: 'moduleB', type: 'import' },
      { source: 'moduleA', target: 'func1', type: 'contains' },
      { source: 'moduleB', target: 'class1', type: 'contains' },
    ],
  };

  const mockAnalysisResult: AnalysisResult = {
    graph: mockGraphData,
    insights: [],
    entityCounts: {
      modules: 2,
      functions: 1,
      classes: 1,
      dependencies: 1,
      circularDeps: 0,
    },
    totalFilesAnalyzed: 2,
    totalFilesSkipped: 0,
  };

  before(() => {
    // Ensure the workspace root exists and is clean
    if (fs.existsSync(workspaceRoot)) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  after(() => {
    // Cleanup workspace root
    if (fs.existsSync(workspaceRoot)) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('should create .agents/rules directory', () => {
    generateMemory(workspaceRoot, mockAnalysisResult);

    assert.ok(fs.existsSync(rulesDir), '.agents/rules directory should be created');
  });

  test('should generate IDE specific rules', () => {
     generateMemory(workspaceRoot, mockAnalysisResult);

     const cursorRulePath = path.join(workspaceRoot, '.cursor', 'rules', 'codeatlas.mdc');
     const claudeRulePath = path.join(workspaceRoot, 'CLAUDE.md');
     const windsurfRulePath = path.join(workspaceRoot, '.windsurfrules');

     assert.ok(fs.existsSync(cursorRulePath), '.cursor/rules/codeatlas.mdc should be created');
     assert.ok(fs.existsSync(claudeRulePath), 'CLAUDE.md should be created');
     assert.ok(fs.existsSync(windsurfRulePath), '.windsurfrules should be created');
  });
});
