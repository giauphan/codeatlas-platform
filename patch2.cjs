const fs = require('fs');
const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

// There's a duplicate `this.normalizeEmbedding(embedding);` in the deduplicateDreams method.
let modified = content.replace(
`        this.normalizeEmbedding(embedding);
        this.normalizeEmbedding(embedding);`,
`        this.normalizeEmbedding(embedding);`);

// In `scoreDreams`, we need to make sure the same thing was done correctly.
// Oh wait, `scoreDreams` is using `SCORE_IDX.EMBEDDING` but in the earlier patch it might have gotten duplicated too.

modified = modified.replace(
`        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;
        this.normalizeEmbedding(embedding);
        this.normalizeEmbedding(embedding);`,
`        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;
        this.normalizeEmbedding(embedding);`);

fs.writeFileSync('src/services/consolidationEngine.ts', modified);
