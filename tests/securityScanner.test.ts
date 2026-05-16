import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SecurityScanner } from '../src/securityScanner.js';
import { AnalysisResult } from '../src/analyzer/types.js';

describe('SecurityScanner', () => {
  test('should detect hardcoded secrets', () => {
    const mockAnalysis: any = {
      graph: {
        nodes: [
          { type: 'variable', label: 'AWS_SECRET_KEY', filePath: 'config.ts', line: 10 },
          { type: 'variable', label: 'userName', filePath: 'user.ts', line: 5 }
        ],
        links: []
      }
    };

    const findings = SecurityScanner.scan(mockAnalysis as AnalysisResult);
    const secretFinding = findings.find(f => f.type === 'HARDCODED_SECRET');
    
    assert.ok(secretFinding, 'Should have found a hardcoded secret');
    assert.strictEqual(secretFinding?.severity, 'HIGH');
    assert.strictEqual(findings.length, 1);
  });

  test('should detect unsafe functions', () => {
    const mockAnalysis: any = {
      graph: {
        nodes: [
          { type: 'function', label: 'eval', filePath: 'unsafe.ts', line: 20 },
          { type: 'function', label: 'safeFunction', filePath: 'safe.ts', line: 5 }
        ],
        links: []
      }
    };

    const findings = SecurityScanner.scan(mockAnalysis as AnalysisResult);
    const unsafeFinding = findings.find(f => f.type === 'UNSAFE_FUNCTION');
    
    assert.ok(unsafeFinding, 'Should have found an unsafe function');
    assert.strictEqual(unsafeFinding?.severity, 'CRITICAL');
  });

  test('should detect potential SQL injection', () => {
    const mockAnalysis: any = {
      graph: {
        nodes: [
          { type: 'function', label: 'executeQuery', filePath: 'db.ts', line: 30 }
        ],
        links: []
      }
    };

    const findings = SecurityScanner.scan(mockAnalysis as AnalysisResult);
    const sqlFinding = findings.find(f => f.type === 'SQL_INJECTION_RISK');
    
    assert.ok(sqlFinding, 'Should have flagged SQL injection risk');
  });
});
