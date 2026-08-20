const fs = require('fs');

const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');
let modified = content;

// Change type signature for parseEmbedding
modified = modified.replace('private parseEmbedding(rawEmb: any): Float32Array | null {', 'private parseEmbedding(rawEmb: Float32Array | number[] | Uint8Array | Buffer | string | null | undefined): Float32Array | null {');

// Remove empty comment in catch block
modified = modified.replace('catch {\n        // null\n      }', 'catch {\n      }');

// Change parseEmbedding to not normalize automatically.
modified = modified.replace(
`    if (result) {
      let norm = 0;
      for (let i = 0; i < result.length; i++) {
        norm += result[i] * result[i];
      }
      if (norm > 0) {
        const len = Math.sqrt(norm);
        for (let i = 0; i < result.length; i++) {
          result[i] /= len;
        }
      }
    }

    return result;`,
`    return result;`);

// Create a new normalize function
modified = modified.replace(
`  private parseEmbedding(`,
`  private normalizeEmbedding(result: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < result.length; i++) {
      norm += result[i] * result[i];
    }
    if (norm > 0) {
      const len = Math.sqrt(norm);
      for (let i = 0; i < result.length; i++) {
        result[i] /= len;
      }
    }
    return result;
  }

  private parseEmbedding(`);

// Change deduplicateDreams to call normalize
modified = modified.replace(
`const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;`,
`const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;
        this.normalizeEmbedding(embedding);`);

// Change scoreDreams to call normalize
modified = modified.replace(
`const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;`,
`const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;
        this.normalizeEmbedding(embedding);`);

fs.writeFileSync('src/services/consolidationEngine.ts', modified);
