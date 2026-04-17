/**
 * Python file parser that uses regular expressions to extract AST-like structure
 * from Python code. Since a full Python AST parser is not available in TypeScript,
 * this provides a heuristic-based approach to finding classes, functions, variables,
 * and imports.
 */
export class PythonParser {
  private static readonly pythonKeywords = new Set([
    'if', 'for', 'while', 'with', 'class', 'def', 'return', 'print',
    'elif', 'except', 'assert', 'yield', 'and', 'or', 'not', 'in', 'is',
    'try', 'finally', 'raise', 'import', 'from', 'as', 'pass', 'break', 'continue',
    'global', 'nonlocal', 'del', 'lambda', 'async', 'await'
  ]);

  /**
   * Parses Python code to extract classes, functions, variables, imports, and function calls.
   *
   * @param filePath The path of the Python file being parsed
   * @param code The contents of the Python file
   * @returns An object containing arrays of extracted entities
   */
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

    const lines = code.split(/\r?\n/);

    // Process line by line to accurately capture line numbers
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Match Classes
      // /^class\s+(\w+)(?:\(([^)]+)\))?\s*:/
      const classMatch = /^class\s+(\w+)(?:\(([^)]+)\))?\s*:/.exec(line);
      if (classMatch) {
        const className = classMatch[1];
        const parents = classMatch[2] ? classMatch[2].split(',').map(p => p.trim()) : [];
        classes.push({ name: className, parents, line: lineNumber });
      }

      // Match Functions (including indented class methods)
      // /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/
      const funcMatch = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
      if (funcMatch) {
        const indent = funcMatch[1].length;
        const funcName = funcMatch[2];
        functions.push({ name: funcName, line: lineNumber, indent });
      }

      // Match Variables (top-level)
      // /^([A-Z_][A-Z0-9_]*)\s*[:=]/
      const varMatch = /^([A-Z_][A-Z0-9_]*)\s*[:=]/.exec(line);
      if (varMatch) {
        variables.push({ name: varMatch[1], line: lineNumber });
      }

      // Match Imports
      // /^(?:from\s+(\S+)\s+)?import\s+(.+)/
      const importMatch = /^(?:from\s+(\S+)\s+)?import\s+(.+)/.exec(line);
      if (importMatch) {
        const source = importMatch[1] || '';
        const names = importMatch[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
        imports.push({ source, names, line: lineNumber });
      }

      // Match Function Calls
      // /(\w+)\s*\(/g
      const callRegex = /(\w+)\s*\(/g;
      let callMatch;
      while ((callMatch = callRegex.exec(line)) !== null) {
        const callName = callMatch[1];
        if (!PythonParser.pythonKeywords.has(callName)) {
          calls.push({ name: callName, line: lineNumber });
        }
      }
    }

    return { classes, functions, variables, imports, calls };
  }
}
