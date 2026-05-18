import { parse } from 'py-ast';

export class PythonParser {
  public parseFile(filePath: string, code: string): {
    classes: { name: string; parents: string[]; line: number }[];
    functions: { name: string; line: number; indent?: number }[];
    variables: { name: string; line: number }[];
    imports: { source: string; names: string[]; line: number }[];
    calls: { name: string; line: number }[];
  } {
    const classes: { name: string; parents: string[]; line: number }[] = [];
    const functions: { name: string; line: number; indent?: number }[] = [];
    const variables: { name: string; line: number }[] = [];
    const imports: { source: string; names: string[]; line: number }[] = [];
    const calls: { name: string; line: number }[] = [];

    try {
      const ast = parse(code);

      const traverse = (node: any) => {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'ClassDef') {
          classes.push({
            name: node.name,
            parents: node.bases.map((b: any) => b.id || 'object'),
            line: node.lineno
          });
        }

        if (node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef') {
          functions.push({
            name: node.name,
            line: node.lineno,
            indent: node.col_offset
          });
        }

        if (node.type === 'Assign') {
          node.targets.forEach((target: any) => {
            if (target.type === 'Name') {
              variables.push({ name: target.id, line: node.lineno });
            }
          });
        }

        if (node.type === 'Import' || node.type === 'ImportFrom') {
          imports.push({
            source: node.module || '',
            names: node.names.map((n: any) => n.name),
            line: node.lineno
          });
        }

        if (node.type === 'Call') {
          if (node.func.type === 'Name') {
            calls.push({ name: node.func.id, line: node.lineno });
          } else if (node.func.type === 'Attribute') {
            calls.push({ name: node.func.attr, line: node.lineno });
          }
        }

        Object.values(node).forEach(child => {
          if (Array.isArray(child)) {
            child.forEach(c => traverse(c));
          } else {
            traverse(child);
          }
        });
      };

      traverse(ast);
    } catch (e) {
      console.warn(`[PythonParser] AST parse failed for ${filePath}, using robust regex fallback.`, e);
      
      const lines = code.split('\n');
      let inMultilineString = false;
      let multilineQuoteChar = '';

      for (let i = 0; i < lines.length; i++) {
        let lineContent = lines[i];
        const lineNum = i + 1;
        
        // Handle multiline comments / strings in Python (''' or """)
        if (inMultilineString) {
          const endQuoteIdx = lineContent.indexOf(multilineQuoteChar);
          if (endQuoteIdx !== -1) {
            lineContent = lineContent.substring(endQuoteIdx + 3);
            inMultilineString = false;
          } else {
            continue; // Skip the entire line as it is inside a multiline string
          }
        }

        const tripleSingleIdx = lineContent.indexOf("'''");
        const tripleDoubleIdx = lineContent.indexOf('"""');
        if (tripleSingleIdx !== -1) {
          inMultilineString = true;
          multilineQuoteChar = "'''";
          lineContent = lineContent.substring(0, tripleSingleIdx);
        } else if (tripleDoubleIdx !== -1) {
          inMultilineString = true;
          multilineQuoteChar = '"""';
          lineContent = lineContent.substring(0, tripleDoubleIdx);
        }

        const trimmed = lineContent.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Strip inline comments
        const commentIdx = lineContent.indexOf('#');
        let codePart = commentIdx !== -1 ? lineContent.substring(0, commentIdx) : lineContent;
        const codeTrimmed = codePart.trim();
        if (!codeTrimmed) continue;

        // 1. Detect Class declarations
        const classMatch = codePart.match(/^\s*class\s+([a-zA-Z0-9_]+)(?:\(([^)]+)\))?\s*:/);
        if (classMatch) {
          const className = classMatch[1];
          const parentsStr = classMatch[2] || '';
          const parents = parentsStr.split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0 && !p.startsWith('*'));
          classes.push({
            name: className,
            parents: parents.length > 0 ? parents : ['object'],
            line: lineNum
          });
          continue;
        }

        // 2. Detect Function declarations
        const funcMatch = codePart.match(/^(\s*)(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/);
        if (funcMatch) {
          const indentStr = funcMatch[1] || '';
          const funcName = funcMatch[2];
          functions.push({
            name: funcName,
            line: lineNum,
            indent: indentStr.length
          });
          continue;
        }

        // 3. Detect Imports
        const importFromMatch = codePart.match(/^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/);
        if (importFromMatch) {
          const source = importFromMatch[1];
          const namesStr = importFromMatch[2];
          const names = namesStr.split(',')
            .map(n => n.trim().split(/\s+as\s+/)[0].trim())
            .filter(n => n.length > 0 && n !== '*' && !n.startsWith('(') && !n.endsWith(')'));
          imports.push({
            source,
            names,
            line: lineNum
          });
          continue;
        }
        
        const importMatch = codePart.match(/^\s*import\s+(.+)$/);
        if (importMatch) {
          const namesStr = importMatch[1];
          const names = namesStr.split(',')
            .map(n => n.trim().split(/\s+as\s+/)[0].trim())
            .filter(n => n.length > 0);
          imports.push({
            source: '',
            names,
            line: lineNum
          });
          continue;
        }

        // 4. Detect Variables (Top-level uppercase constants)
        const varMatch = codePart.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*/);
        if (varMatch) {
          variables.push({
            name: varMatch[1],
            line: lineNum
          });
        }

        // 5. Detect Calls
        const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
        let match;
        const keywords = new Set(['if', 'elif', 'while', 'for', 'def', 'class', 'with', 'assert', 'return', 'raise', 'and', 'or', 'not', 'in', 'is', 'try', 'except', 'finally']);
        while ((match = callRegex.exec(codePart)) !== null) {
          const callName = match[1];
          if (!keywords.has(callName)) {
            calls.push({
              name: callName,
              line: lineNum
            });
          }
        }
      }
    }

    return { classes, functions, variables, imports, calls };
  }
}
