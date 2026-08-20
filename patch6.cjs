const fs = require('fs');
const content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

let modified = content.replace(
`        // Deep copy the buffer to avoid mutating shared internal memory pools
        const copy = rawEmb.buffer.slice(rawEmb.byteOffset, rawEmb.byteOffset + rawEmb.byteLength);
        result = new Float32Array(copy);`,
`        // Deep copy the buffer to avoid mutating shared internal memory pools.
        // Guard against SharedArrayBuffer which lacks .slice()
        if (rawEmb.buffer instanceof ArrayBuffer) {
          const copy = rawEmb.buffer.slice(rawEmb.byteOffset, rawEmb.byteOffset + rawEmb.byteLength);
          result = new Float32Array(copy);
        } else {
          // Fallback for SharedArrayBuffer
          result = new Float32Array(new Uint8Array(rawEmb.buffer, rawEmb.byteOffset, rawEmb.byteLength).slice().buffer);
        }`);

fs.writeFileSync('src/services/consolidationEngine.ts', modified);
