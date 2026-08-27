const fs = require('fs');
let content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

content = content.replace(
  `private async attemptBatchUpdate(db: IDatabaseAdapter, updateSql: string, chunk: ConceptConfidenceUpdate[], batchId: string, fallbackState: { logCount: number } = { logCount: 0 }, maxRetries = this.initConfig().maxRetries): Promise<boolean> {`,
  `private async attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState = { logCount: 0 }, maxRetries = this.initConfig().maxRetries }: { db: IDatabaseAdapter; updateSql: string; chunk: ConceptConfidenceUpdate[]; batchId: string; fallbackState?: { logCount: number }; maxRetries?: number }): Promise<boolean> {`
);

content = content.replace(
  `success = await this.attemptBatchUpdate(txAdapter, updateSql, chunk, batchId, fallbackState);`,
  `success = await this.attemptBatchUpdate({ db: txAdapter, updateSql, chunk, batchId, fallbackState });`
);
content = content.replace(
  `success = await this.attemptBatchUpdate(db, updateSql, chunk, batchId, fallbackState);`,
  `success = await this.attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState });`
);
content = content.replace(
  `success = await this.attemptBatchUpdate(db, updateSql, chunk, batchId, fallbackState);`,
  `success = await this.attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState });`
);

fs.writeFileSync('src/services/consolidationEngine.ts', content);
