const fs = require('fs');
let content = fs.readFileSync('tests/unit/consolidation-engine.test.ts', 'utf8');

content = content.replace(
  `const result = await attemptBatchUpdate({ db: mockDb, updateSql: 'SQL', chunk: [{ id: '1' }], batchId: 'test-batch', fallbackState: { logCount: 0 }, maxRetries: 2 }); // 2 retries`,
  `const result = await attemptBatchUpdate({ db: mockDb, updateSql: 'SQL', chunk: [{ id: '550e8400-e29b-41d4-a716-446655440000' }], batchId: 'test-batch', fallbackState: { logCount: 0 }, maxRetries: 2 }); // 2 retries`
);

fs.writeFileSync('tests/unit/consolidation-engine.test.ts', content);
