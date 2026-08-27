const fs = require('fs');
let content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

content = content.replace(
  `private async executeRowFallback(db: IDatabaseAdapter, updateSql: string, chunk: ConceptConfidenceUpdate[], batchId: string, fallbackState: { logCount: number }): Promise<boolean> {`,
  `private async executeRowFallback(db: IDatabaseAdapter, updateSql: string, chunk: ConceptConfidenceUpdate[] | Record<string, unknown>[], batchId: string, fallbackState: { logCount: number }): Promise<boolean> {
    if (!Array.isArray(chunk)) {
      this.logBatchDetails('error', 'Fallback', \`Chunk is not an array, cannot execute row fallback.\`, { txId: batchId });
      return false;
    }`
);

content = content.replace(
  `private async attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState = { logCount: 0 }, maxRetries = this.initConfig().maxRetries }: { db: IDatabaseAdapter; updateSql: string; chunk: ConceptConfidenceUpdate[]; batchId: string; fallbackState?: { logCount: number }; maxRetries?: number }): Promise<boolean> {`,
  `private async attemptBatchUpdate({ db, updateSql, chunk, batchId, fallbackState = { logCount: 0 }, maxRetries = this.initConfig().maxRetries }: { db: IDatabaseAdapter; updateSql: string; chunk: ConceptConfidenceUpdate[] | Record<string, unknown>[]; batchId: string; fallbackState?: { logCount: number }; maxRetries?: number }): Promise<boolean> {
    if (!Array.isArray(chunk)) {
      this.logBatchDetails('error', 'Attempt', \`Chunk is not an array, cannot attempt batch update.\`, { txId: batchId });
      return false;
    }`
);

fs.writeFileSync('src/services/consolidationEngine.ts', content);
