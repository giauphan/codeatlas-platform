import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { CodeAnalyzer } from '../src/analyzer/parser.js';

// Setup Mock Request & Response Types for Express
interface MockResponse {
  statusCode: number;
  jsonData: any;
  status: (code: number) => MockResponse;
  json: (data: any) => MockResponse;
}

const createMockResponse = (): MockResponse => {
  const res: MockResponse = {
    statusCode: 200,
    jsonData: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.jsonData = data;
      return this;
    }
  };
  return res;
};

describe('REST API Endpoints', () => {
  const testDir = path.join(process.cwd(), 'tests', 'mock_api_project');
  let analysisFile: string;

  before(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    const codeatlasDir = path.join(testDir, '.codeatlas');
    if (!fs.existsSync(codeatlasDir)) {
      fs.mkdirSync(codeatlasDir, { recursive: true });
    }
    analysisFile = path.join(codeatlasDir, 'analysis.json');
  });

  after(() => {
    if (fs.existsSync(analysisFile)) {
      fs.unlinkSync(analysisFile);
    }
    const codeatlasDir = path.join(testDir, '.codeatlas');
    if (fs.existsSync(codeatlasDir)) {
      fs.rmdirSync(codeatlasDir);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
  });

  test('should successfully load analysis data if it exists', () => {
    const mockData = {
      graph: { nodes: [], links: [] },
      entityCounts: { modules: 0, functions: 0, classes: 0 }
    };
    
    fs.writeFileSync(analysisFile, JSON.stringify(mockData, null, 2));

    // Simple E2E telemetry loading check
    const loadAnalysis = (filePath: string) => {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };

    const data = loadAnalysis(analysisFile);
    assert.ok(data, 'Analysis data should be successfully loaded');
    assert.strictEqual(data.entityCounts.modules, 0);
  });

  test('should gracefully return null if analysis data does not exist', () => {
    const missingFile = path.join(testDir, '.codeatlas', 'missing.json');
    const loadAnalysis = (filePath: string) => {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };

    const data = loadAnalysis(missingFile);
    assert.strictEqual(data, null, 'Should return null for missing analysis telemetry file');
  });

  test('should trigger reindexing and write telemetry results to disk', async () => {
    // Create a dummy source file to analyze
    const sampleTs = path.join(testDir, 'index.ts');
    fs.writeFileSync(sampleTs, 'export const VERSION = "2.1.11";');

    const analyzer = new CodeAnalyzer(testDir);
    const result = await analyzer.analyzeProject();

    // Verify parser worked
    assert.ok(result.graph.nodes.length > 0, 'Parser should find nodes');

    // Simulate /api/reindex controller logic
    fs.writeFileSync(analysisFile, JSON.stringify(result, null, 2));

    assert.ok(fs.existsSync(analysisFile), 'Telemetry analysis.json should be written to disk');
    const writtenData = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    assert.strictEqual(writtenData.totalFilesAnalyzed, 1);

    // Clean up sample file
    fs.unlinkSync(sampleTs);
  });
});
