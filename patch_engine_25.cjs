const fs = require('fs');
let content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

content = content.replace(
  `private getBatchChunkSize(): number {
    const chunkSize = this.initConfig().batchSize;
    if (process.env.CODEATLAS_BATCH_VERBOSE_LOGGING === 'true') {
      logger.info(\`[Consolidation] Using batch chunk size of \${chunkSize}\`);
    }
    return chunkSize;
  }`,
  `private getBatchChunkSize(): number {
    const chunkSize = this.initConfig().batchSize;
    if (this._configCache.get('_chunkSizeLogged') !== true && this.getEnvVarNumber('CODEATLAS_BATCH_VERBOSE_LOGGING', 0, EnvVarType.INT, 1) === 1) {
      logger.info(\`[Consolidation] Using batch chunk size of \${chunkSize}\`);
      this._configCache.set('_chunkSizeLogged', true);
    }
    return chunkSize;
  }`
);

fs.writeFileSync('src/services/consolidationEngine.ts', content);
