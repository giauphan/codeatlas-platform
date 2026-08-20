const fs = require('fs');
const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

// I see that `scoreDreams` is still missing the call to `this.normalizeEmbedding(embedding);`.
let modified = content.replace(
`        const rawEmb = this.getVal(row, SCORE_IDX.EMBEDDING, 'EMBEDDING');
        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;

        if (!groups.has(key)) groups.set(key, []);`,
`        const rawEmb = this.getVal(row, SCORE_IDX.EMBEDDING, 'EMBEDDING');
        const embedding = this.parseEmbedding(rawEmb);

        if (!embedding) continue;
        this.normalizeEmbedding(embedding);

        if (!groups.has(key)) groups.set(key, []);`);

// Also change the type of `parseEmbedding` back to match `any` where needed if `any` is needed, but the reviewer suggested:
// Float32Array | number[] | Uint8Array | Buffer | string | null | undefined
// Let's make sure it satisfies the PR reviewer.

// Now fix the `cosineSimilarity` function.
// The reviewer said: `Removing the normalization computation (normA, normB, denom) means the function now returns a raw dot product. This is only correct if every caller first passes vectors through parseEmbedding... Consider adding an assertion or documenting this as a strict precondition.`

modified = modified.replace(
`  private cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }

    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
    }

    // Vectors are already normalized to unit length in parseEmbedding,
    // so the dot product is exactly the cosine similarity.
    return dot;
  }`,
`  /**
   * Computes the cosine similarity of two vectors using only their dot product.
   * PRECONDITION: vecA and vecB must be pre-normalized to unit length (L2 norm = 1).
   * Calling this with unnormalized vectors will return an incorrect result.
   */
  private cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }

    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
    }

    return dot;
  }`);

fs.writeFileSync('src/services/consolidationEngine.ts', modified);
