import chokidar from 'chokidar';
import { spawn } from 'child_process';
import * as path from 'path';
import { discoverProjects } from './projectService.js';

export let indexTimeout: NodeJS.Timeout | null = null;
export let watcher: any = null;
const projectRoot = process.cwd();

export function startWatcher() {
  const projects = discoverProjects();
  const watchPaths = projects.map(p => p.dir);

  if (watchPaths.length === 0) {
    watchPaths.push(process.cwd());
  }

  watcher = chokidar.watch(watchPaths, {
    ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
    persistent: true,
    ignoreInitial: true
  });

  watcher.on('change', (filePath: string) => {
    const project = projects.find(p => filePath.startsWith(p.dir));
    const projectName = project ? project.name : 'Unknown';
    
    console.log(`\n[Auto-Scan] ⚡ Change in [${projectName}]: ${filePath}`);
    
    if (indexTimeout) clearTimeout(indexTimeout);
    indexTimeout = setTimeout(() => {
      console.log(`[Auto-Scan] 🔄 Re-indexing [${projectName}]...`);
      
      const cwd = project?.dir || process.cwd();
      const indexingScript = path.join(projectRoot, 'run_indexing.ts');
      
      const child = spawn('npx', ['tsx', indexingScript], { cwd, shell: process.platform === 'win32' });
      child.on('error', (error) => {
        console.error(`[Auto-Index] ❌ Error indexing ${projectName}: ${error.message}`);
      });
      child.on('close', (code) => {
        if (code === 0) {
          console.log(`[Auto-Index] ✅ ${projectName} updated and synced to DB.`);
        } else {
          console.error(`[Auto-Index] ❌ Error indexing ${projectName}: Process exited with code ${code}`);
        }
      });
    }, 2000);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 CODEATLAS ENTERPRISE ONLINE`);
  console.log(`📡 Auto-Indexing: WATCHING ${watchPaths.length} PROJECTS`);
  watchPaths.forEach(p => console.log(`   - ${p}`));
  console.log(`🛡️  Security: FIREBASE ADMIN ACTIVE`);
  console.log(`${'='.repeat(50)}\n`);
}
