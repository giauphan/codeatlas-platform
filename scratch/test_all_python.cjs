const { PythonParser } = require('../../codeatlas-mcp-enterprise/dist/src/analyzer/pythonParser.js');
const fs = require('fs');
const path = require('path');

const dir = '/home/biibon/auto-edit-video-reup-tool';
const files = [
  'worker/voice_translator.py',
  'worker/topic_classifier.py',
  'worker/drive_uploader.py',
  'worker/metrics.py',
  'worker/rate_limiter.py',
  'worker/monitoring/firestore_logger.py',
  'worker/monitoring/oracle_warehouse.py',
  'redub_unpublished.py'
];

const parser = new PythonParser();

for (const rel of files) {
  const full = path.join(dir, rel);
  console.log(`\n--- Parsing: ${rel} ---`);
  try {
    const code = fs.readFileSync(full, 'utf-8');
    const res = parser.parseFile(full, code);
    console.log(`✅ Success: classes=${res.classes.length}, functions=${res.functions.length}`);
  } catch (e) {
    console.log(`❌ Failed:`, e);
  }
}
