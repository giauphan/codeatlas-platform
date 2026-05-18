import * as fs from "fs";
import * as path from "path";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { CodeAnalyzer } from "../analyzer/parser.js";
import { AnalysisResult } from "../analyzer/types.js";
import { authStorage } from "../context.js";

export interface AnalysisResultLocal extends AnalysisResult {
  stats?: { files: number; functions: number; classes: number; dependencies: number; circularDeps: number; deadCode: number };
}

/** Unified stats helper */
export function getStats(analysis: AnalysisResultLocal) {
  const ec = analysis.entityCounts;
  const st = analysis.stats;
  return {
    files: st?.files ?? analysis.totalFilesAnalyzed ?? ec?.modules ?? 0,
    modules: ec?.modules ?? st?.files ?? analysis.totalFilesAnalyzed ?? 0,
    functions: ec?.functions ?? st?.functions ?? 0,
    classes: ec?.classes ?? st?.classes ?? 0,
    dependencies: ec?.dependencies ?? st?.dependencies ?? 0,
    circularDeps: ec?.circularDeps ?? st?.circularDeps ?? 0,
    deadCode: ec?.deadCode ?? st?.deadCode ?? 0,
  };
}

export function isProjectDirectory(dir: string): boolean {
  if (dir === process.cwd() || dir === process.env.CODEATLAS_PROJECT_DIR || dir.includes("/tenants/")) {
    return true;
  }
  try {
    return (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "composer.json")) ||
      fs.existsSync(path.join(dir, "requirements.txt")) ||
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, ".codeatlas")) ||
      fs.existsSync(path.join(dir, "README.md"))
    );
  } catch {
    return false;
  }
}

export async function isProjectDirectoryAsync(dir: string): Promise<boolean> {
  if (dir === process.cwd() || dir === process.env.CODEATLAS_PROJECT_DIR || dir.includes("/tenants/")) {
    return true;
  }
  try {
    const checks = [
      fileExists(path.join(dir, "package.json")),
      fileExists(path.join(dir, "composer.json")),
      fileExists(path.join(dir, "requirements.txt")),
      fileExists(path.join(dir, ".git")),
      fileExists(path.join(dir, ".codeatlas")),
      fileExists(path.join(dir, "README.md"))
    ];
    const results = await Promise.all(checks);
    return results.some(r => r === true);
  } catch {
    return false;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function discoverProjects(tenantId?: string): { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const searchDirs: string[] = [];

  // Multi-Tenant Isolation
  if (process.env.CODEATLAS_MULTI_TENANT === "true") {
    const auth = authStorage.getStore();
    const isSystemAdmin = auth
      ? (auth.uid === "admin" || auth.role === "admin" || auth.email === "admin@genrostore.com")
      : (tenantId === "admin");

    if (tenantId && !isSystemAdmin) {
      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      const userDir = path.join(tenantRoot, tenantId);
      if (fs.existsSync(userDir)) {
        try {
          const userProjects = fs.readdirSync(userDir);
          for (const p of userProjects) {
            const fullPath = path.join(userDir, p);
            if (fs.statSync(fullPath).isDirectory()) {
              searchDirs.push(fullPath);
            }
          }
        } catch { /* skip */ }
      }
    } else if (isSystemAdmin) {
      if (process.env.CODEATLAS_PROJECT_DIR) {
        searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
      }
      searchDirs.push(process.cwd());
    } else {
      return [];
    }
  } else {
    if (process.env.CODEATLAS_PROJECT_DIR) {
      searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
    }
    searchDirs.push(process.cwd());
  }

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    if (isProjectDirectory(dir)) {
      try {
        const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
        let modifiedAt: Date;
        if (fs.existsSync(analysisPath)) {
          modifiedAt = fs.statSync(analysisPath).mtime;
        } else {
          modifiedAt = fs.statSync(dir).mtime;
        }
        projects.push({
          name: path.basename(dir),
          dir,
          analysisPath,
          modifiedAt,
        });
      } catch { /* skip */ }
    }
  }

  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

export function loadAnalysis(projectDir?: string): { analysis: AnalysisResult; projectName: string; projectDir: string } | null {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;
  
  const projects = discoverProjects(tenantId);
  if (projects.length === 0) return null;

  let target: { name: string; dir: string; analysisPath: string; modifiedAt: Date } | undefined = projects[0];

  if (projectDir) {
    const match = projects.find(
      (p) => p.dir === projectDir || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) {
      target = match;
    } else {
      return null;
    }
  }

  try {
    const codeatlasDir = path.dirname(target.analysisPath);
    if (!fs.existsSync(target.analysisPath)) {
      if (!fs.existsSync(codeatlasDir)) {
        fs.mkdirSync(codeatlasDir, { recursive: true });
      }
      console.log(`[Auto-Scan] 🔄 Creating .codeatlas directory and scanning project dynamically (sync): ${target.dir}`);
      const indexingScript = path.join(process.cwd(), 'run_indexing.ts');
      // Import child_process dynamically
      import("child_process").then(({ execSync }) => {
        execSync(`npx tsx "${indexingScript}"`, { cwd: target!.dir, stdio: 'inherit' });
      });
    }
    const data = fs.readFileSync(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    console.error(`[Auto-Scan] ❌ Dynamic sync scanning failed: ${err}`);
    return null;
  }
}

export async function discoverProjectsAsync(tenantId?: string): Promise<{ name: string; dir: string; analysisPath: string; modifiedAt: Date }[]> {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const searchDirs: string[] = [];

  // Multi-Tenant Isolation
  if (process.env.CODEATLAS_MULTI_TENANT === "true") {
    const auth = authStorage.getStore();
    const isSystemAdmin = auth
      ? (auth.uid === "admin" || auth.role === "admin" || auth.email === "admin@genrostore.com")
      : (tenantId === "admin");

    if (tenantId && !isSystemAdmin) {
      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      const userDir = path.join(tenantRoot, tenantId);
      if (await fileExists(userDir)) {
        try {
          const userProjects = await fs.promises.readdir(userDir);
          for (const p of userProjects) {
            const fullPath = path.join(userDir, p);
            try {
              const stat = await fs.promises.stat(fullPath);
              if (stat.isDirectory()) {
                searchDirs.push(fullPath);
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } else if (isSystemAdmin) {
      if (process.env.CODEATLAS_PROJECT_DIR) {
        searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
      }
      searchDirs.push(process.cwd());
    } else {
      return [];
    }
  } else {
    if (process.env.CODEATLAS_PROJECT_DIR) {
      searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
    }
    searchDirs.push(process.cwd());
  }

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    if (await isProjectDirectoryAsync(dir)) {
      try {
        const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
        let modifiedAt: Date;
        if (await fileExists(analysisPath)) {
          modifiedAt = (await fs.promises.stat(analysisPath)).mtime;
        } else {
          modifiedAt = (await fs.promises.stat(dir)).mtime;
        }
        projects.push({
          name: path.basename(dir),
          dir,
          analysisPath,
          modifiedAt,
        });
      } catch { /* skip */ }
    }
  }

  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

export async function loadAnalysisAsync(projectDir?: string): Promise<{ analysis: AnalysisResult; projectName: string; projectDir: string } | null> {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;
  
  const projects = await discoverProjectsAsync(tenantId);
  if (projects.length === 0) return null;

  let target: { name: string; dir: string; analysisPath: string; modifiedAt: Date } | undefined = projects[0];

  if (projectDir) {
    const match = projects.find(
      (p) => p.dir === projectDir || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) {
      target = match;
    } else {
      return null;
    }
  }

  try {
    const codeatlasDir = path.dirname(target.analysisPath);
    if (!await fileExists(target.analysisPath)) {
      if (!await fileExists(codeatlasDir)) {
        await fs.promises.mkdir(codeatlasDir, { recursive: true });
      }
      console.log(`[Auto-Scan] 🔄 Scanning project dynamically (async): ${target.dir}`);
      const analyzer = new CodeAnalyzer(target.dir, 5000);
      const result = await analyzer.analyzeProject();
      
      // Save locally
      await fs.promises.writeFile(
        target.analysisPath,
        JSON.stringify(result, null, 2)
      );
      
      // Sync to Firestore in the background asynchronously
      try {
        const apps = getApps();
        if (apps.length) {
          const db = getFirestore();
          await db.collection('projects').doc(target.name).set({
            name: target.name,
            path: target.dir,
            stats: (result as any).stats || result.entityCounts || {},
            lastIndexed: new Date().toISOString(),
            nodesCount: result.graph.nodes.length,
            linksCount: result.graph.links.length,
            status: 'synced'
          }, { merge: true });
          console.log(`[Auto-Scan] ✅ Synced ${target.name} to Firestore.`);
        }
      } catch (e) {
        console.error(`[Auto-Scan] ❌ Firestore Sync Failed: ${e}`);
      }
      
      return { analysis: result, projectName: target.name, projectDir: target.dir };
    }

    const data = await fs.promises.readFile(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    console.error(`[Auto-Scan] ❌ Dynamic async scanning failed: ${err}`);
    return null;
  }
}
