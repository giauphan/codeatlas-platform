import { PythonParser } from '../codeatlas-mcp-enterprise/src/analyzer/pythonParser.ts';
import * as fs from 'fs';

const filePath = './sample_python_file.py';
const code = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : 'def hello(): pass';

console.log('Starting parse...');
try {
  const parser = new PythonParser();
  const res = parser.parseFile(filePath, code);
  console.log('Parse successful! Statistics:');
  console.log(`Classes: ${res.classes.length}`);
  console.log(`Functions: ${res.functions.length}`);
  console.log(`Variables: ${res.variables.length}`);
  console.log(`Imports: ${res.imports.length}`);
  console.log(`Calls: ${res.calls.length}`);
} catch (e) {
  console.error('Parse failed with error:', e);
}
