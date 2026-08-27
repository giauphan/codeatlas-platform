const fs = require('fs');
let content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

content = content.replace(
  `const sampleIds = chunk.slice(0, 3).map((c: ConceptConfidenceUpdate) => c.id).join(', ');`,
  `const sampleIds = chunk.slice(0, 3).map((c: any) => c.id).join(', ');`
);

fs.writeFileSync('src/services/consolidationEngine.ts', content);
