import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SecurityScanner } from '../../src/services/scanner/securityScanner.js';
import { AnalysisResult } from '../../src/types/index.js';

describe('SecurityScanner', () => {
    test('should identify hardcoded secrets', () => {
        const analysis: AnalysisResult = {
            graph: {
                nodes: [
                    { id: '1', label: 'apiKey', type: 'variable', filePath: 'src/config.ts' }
                ],
                links: []
            },
            stats: { totalNodes: 1, totalLinks: 0, fileCount: 1 }
        };
        const findings = SecurityScanner.scan(analysis);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].type, 'HARDCODED_SECRET');
    });
    test('should identify sql injection', () => {
        const analysis: AnalysisResult = {
            graph: {
                nodes: [
                    { id: '2', label: 'executeQuery', type: 'function', filePath: 'src/db.ts' }
                ],
                links: []
            },
            stats: { totalNodes: 1, totalLinks: 0, fileCount: 1 }
        };
        const findings = SecurityScanner.scan(analysis);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].type, 'SQL_INJECTION_RISK');
    });
});
