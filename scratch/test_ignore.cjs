const ignore = require('../../codeatlas-mcp-enterprise/node_modules/ignore');
const fs = require('fs');
const path = require('path');

const ig = ignore();
const excludedDirectories = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'venv', 'env', '.env', 'vendor', 'build', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.next', '.nuxt'];
const excludedFiles = ['_ide_helper.php', '_ide_helper_models.php', '.phpstorm.meta.php'];

ig.add(excludedDirectories);
ig.add(excludedFiles);

const gitignorePath = '/home/biibon/auto-edit-video-reup-tool/.gitignore';
if (fs.existsSync(gitignorePath)) {
  const content = fs.readFileSync(gitignorePath, 'utf-8');
  ig.add(content);
}

const files = [
  'worker/voice_translator.py',
  'worker/topic_classifier.py',
  'worker/drive_uploader.py',
  'worker/metrics.py',
  'worker/rate_limiter.py',
  'worker/monitoring/firestore_logger.py',
  'worker/monitoring/oracle_warehouse.py',
  'redub_unpublished.py',
  'video_processor/processor.py'
];

for (const f of files) {
  console.log(`${f}: ignored = ${ig.ignores(f)}`);
}
