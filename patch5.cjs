const fs = require('fs');
const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

let modified = content.replace(
`  private parseEmbedding(rawEmb: any): Float32Array | null {`,
`  private parseEmbedding(rawEmb: Float32Array | number[] | Uint8Array | Buffer | string | null | undefined): Float32Array | null {`);

// Also fix `rawEmb instanceof Buffer` by checking if it's an object first, or just drop `instanceof Buffer` since `Buffer` extends `Uint8Array` as noted by the reviewer!
// "rawEmb instanceof Buffer is redundant — Buffer extends Uint8Array, so rawEmb instanceof Uint8Array already covers it."

modified = modified.replace(
`} else if (rawEmb instanceof Uint8Array || rawEmb instanceof Buffer) {`,
`} else if (rawEmb instanceof Uint8Array) {`);

fs.writeFileSync('src/services/consolidationEngine.ts', modified);
