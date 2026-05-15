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
      console.warn(`[PythonParser] Failed to parse AST for ${filePath}`, e);
    }

    return { classes, functions, variables, imports, calls };
  }
}
