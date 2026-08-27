const fs = require('fs');
const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

let newContent = content.replace(
  `  private computeConfidence(currentConf: number, evidenceCount: number, customDecay?: number): number {
    const decayConstant = customDecay !== undefined ? customDecay : this.getEnvVarNumber('CODEATLAS_CONFIDENCE_DECAY_CONSTANT', DEFAULTS.DECAY_CONSTANT, EnvVarType.FLOAT, DEFAULTS.MAX_DECAY);
    const ceiling = this.getEnvVarNumber('CODEATLAS_CONFIDENCE_CEILING', DEFAULTS.CONFIDENCE_CEILING, EnvVarType.FLOAT, 1.0);
    return Math.min(ceiling, currentConf + (1 - currentConf) * (1 - Math.exp(-decayConstant * evidenceCount)));
  }`,
  `  private computeConfidence(currentConf: number, evidenceCount: number, customDecay?: number): number {
    let decayConstant = customDecay !== undefined ? customDecay : this.getEnvVarNumber('CODEATLAS_CONFIDENCE_DECAY_CONSTANT', DEFAULTS.DECAY_CONSTANT, EnvVarType.FLOAT, DEFAULTS.MAX_DECAY);

    // Safety guard against invalid negative decay constants
    if (decayConstant < 0) {
       logger.warn(\`[Consolidation] Negative decay constant provided (\${decayConstant}). Clamping to 0 to prevent algorithm corruption.\`);
       decayConstant = 0;
    }

    const ceiling = this.getEnvVarNumber('CODEATLAS_CONFIDENCE_CEILING', DEFAULTS.CONFIDENCE_CEILING, EnvVarType.FLOAT, 1.0);
    return Math.min(ceiling, currentConf + (1 - currentConf) * (1 - Math.exp(-decayConstant * evidenceCount)));
  }`
);

fs.writeFileSync('src/services/consolidationEngine.ts', newContent);
