const { CodeAnalyzer } = require('../../codeatlas-mcp-enterprise/dist/src/analyzer/parser.js');

async function main() {
  const analyzer = new CodeAnalyzer('/home/biibon/auto-edit-video-reup-tool');
  console.log('Starting analyzeProject...');
  const result = await analyzer.analyzeProject((percent, done, total, file) => {
    console.log(`Progress: ${percent}% (${done}/${total}) - ${file}`);
  });
  console.log('Result totalFilesAnalyzed:', result.totalFilesAnalyzed);
  console.log('Result totalFilesSkipped:', result.totalFilesSkipped);
  console.log('Modules:');
  result.graph.nodes
    .filter(n => n.type === 'module')
    .forEach(n => console.log(`  - ${n.id} (label: ${n.label}, file: ${n.filePath})`));
}

main().catch(console.error);
