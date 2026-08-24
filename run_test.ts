import assert from 'node:assert/strict';

function normalizeVectorInPlace(embedding: Float32Array): Float32Array {
    const vec = embedding.slice();
    let norm = 0;
    const len = vec.length;
    for (let k = 0; k < len; k++) {
      norm += vec[k] * vec[k];
    }
    if (norm > 0) {
      const denom = Math.sqrt(norm);
      for (let k = 0; k < len; k++) {
        vec[k] /= denom;
      }
    }
    return vec;
}

const vec1 = new Float32Array([3, 4]); // Norm = 5
const norm1 = normalizeVectorInPlace(vec1);
console.log(norm1[0], 3 / 5);
assert.equal(norm1[0], 3 / 5);
