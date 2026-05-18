import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { generateMemory } from '../src/memoryGenerator.js';
import { AnalysisResult, GraphData } from '../src/analyzer/types.js';

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
      deadCode: 0,
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

  test('should create .agents/memory and .agents/rules directories', () => {
    generateMemory(workspaceRoot, mockAnalysisResult);

    assert.ok(fs.existsSync(memoryDir), '.agents/memory directory should be created');
    assert.ok(fs.existsSync(rulesDir), '.agents/rules directory should be created');
  });

  test('should generate expected regenerated files', () => {
    generateMemory(workspaceRoot, mockAnalysisResult);

    const systemMapPath = path.join(memoryDir, 'system-map.md');
    const modulesJsonPath = path.join(memoryDir, 'modules.json');
    const featureFlowsPath = path.join(memoryDir, 'feature-flows.json');
    const conventionsPath = path.join(memoryDir, 'conventions.md');

    assert.ok(fs.existsSync(systemMapPath), 'system-map.md should be created');
    assert.ok(fs.existsSync(modulesJsonPath), 'modules.json should be created');
    assert.ok(fs.existsSync(featureFlowsPath), 'feature-flows.json should be created');
    assert.ok(fs.existsSync(conventionsPath), 'conventions.md should be created');

    const systemMapContent = fs.readFileSync(systemMapPath, 'utf8');
    assert.ok(systemMapContent.includes('# System Map'), 'system-map.md should contain the correct header');
    assert.ok(systemMapContent.includes('**Modules**: 2'), 'system-map.md should contain module stats');

    const modulesJsonContent = JSON.parse(fs.readFileSync(modulesJsonPath, 'utf8'));
    assert.strictEqual(modulesJsonContent.length, 2, 'modules.json should contain 2 modules');
    assert.strictEqual(modulesJsonContent[0].name, 'moduleA.ts', 'modules.json should have correct data for name');
    assert.strictEqual(modulesJsonContent[0].path, 'src/moduleA.ts', 'modules.json should have correct relative path');
  });

  test('should preserve existing business-rules.json and change-log.json', () => {
    // Write initial files
    const businessRulesPath = path.join(memoryDir, 'business-rules.json');
    const changeLogPath = path.join(memoryDir, 'change-log.json');

    // Create the directory if it doesn't exist yet from a previous test run
    if (!fs.existsSync(memoryDir)) {
       fs.mkdirSync(memoryDir, { recursive: true });
    }

    fs.writeFileSync(businessRulesPath, JSON.stringify([{ id: 1, rule: 'Original Rule' }]));
    fs.writeFileSync(changeLogPath, JSON.stringify([{ id: 1, change: 'Original Change' }]));

    // Run generateMemory again
    generateMemory(workspaceRoot, mockAnalysisResult);

    const businessRulesContent = JSON.parse(fs.readFileSync(businessRulesPath, 'utf8'));
    const changeLogContent = JSON.parse(fs.readFileSync(changeLogPath, 'utf8'));

    assert.strictEqual(businessRulesContent.length, 1, 'business-rules.json should be preserved');
    assert.strictEqual(businessRulesContent[0].rule, 'Original Rule', 'business-rules.json content should be preserved');

    assert.strictEqual(changeLogContent.length, 1, 'change-log.json should be preserved');
    assert.strictEqual(changeLogContent[0].change, 'Original Change', 'change-log.json content should be preserved');
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
