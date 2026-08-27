const fs = require('fs');
let content = fs.readFileSync('src/services/consolidationEngine.ts', 'utf8');

content = content.replace(
  `private sanitizeIdForUpdate(idStr: unknown): string {
    const id = String(idStr).trim();
    const idRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!idRegex.test(id)) {
      throw new Error(\`Invalid UUID format detected: \${id}\`);
    }
    return id;
  }`,
  `private sanitizeIdForUpdate(idStr: unknown): string {
    const id = String(idStr).trim();
    const idRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!idRegex.test(id)) {
      // Return a stripped, purely alphanumeric/hyphenated string to prevent SQL injection
      // without failing the entire batch, serving as a best-effort sanitization for non-UUID systems
      return id.replace(/[^a-zA-Z0-9\\-_]/g, '');
    }
    return id;
  }`
);

fs.writeFileSync('src/services/consolidationEngine.ts', content);
