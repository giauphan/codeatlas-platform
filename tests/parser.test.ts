import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { CodeAnalyzer } from '../src/analyzer/parser.js';

describe('CodeAnalyzer Parser', () => {
  const testDir = path.join(process.cwd(), 'tests', 'mock_parser_project');
  let testFile: string;

  before(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    testFile = path.join(testDir, 'sample.ts');
    
    // Write sample TypeScript code with distinct nodes for module, class, functions, variables
    const sampleCode = `
      import { otherFunc } from './other.js';
      
      export class Calculator {
        private lastResult: number = 0;
        
        public add(a: number, b: number): number {
          return a + b;
        }
      }
      
      export function helper(): string {
        return "ready";
      }
      
      const configValue = 42;
    `;
    fs.writeFileSync(testFile, sampleCode);
  });

  after(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
  });

  test('should parse typescript structures and construct a comprehensive graph', async () => {
    const analyzer = new CodeAnalyzer(testDir);
    const result = await analyzer.analyzeProject();

    assert.ok(result, 'Analysis result should be defined');
    assert.ok(result.graph, 'Graph data should be present');
    assert.ok(result.graph.nodes.length > 0, 'Nodes should be populated');

    // Verify module node exists
    const moduleNode = result.graph.nodes.find(n => n.type === 'module');
    assert.ok(moduleNode, 'Should have generated a module node');
    assert.strictEqual(moduleNode?.label, 'sample.ts');

    // Verify class node
    const classNode = result.graph.nodes.find(n => n.type === 'class');
    assert.ok(classNode, 'Should have parsed the ClassDeclaration');
    assert.strictEqual(classNode?.label, 'Calculator');

    // Verify function node
    const functionNode = result.graph.nodes.find(n => n.type === 'function' && n.label === 'helper');
    assert.ok(functionNode, 'Should have parsed the FunctionDeclaration');

    // Verify variable node
    const variableNode = result.graph.nodes.find(n => n.type === 'variable');
    assert.ok(variableNode, 'Should have parsed top-level variable declarators');
    assert.strictEqual(variableNode?.label, 'configValue');

    console.log("PARSED NODES:", result.graph.nodes.map(n => ({ type: n.type, label: n.label })));
    assert.strictEqual(result.entityCounts.classes, 1);
    assert.strictEqual(result.entityCounts.functions, 2); // Calculator.add & helper()
    assert.strictEqual(result.entityCounts.modules, 2); // sample.ts and external other.js
  });
});
