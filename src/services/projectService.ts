import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as os from "os";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { AnalysisResult } from "./types.js";
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

let onProjectLoadedCallback: ((dir: string) => void) | null = null;
export function registerOnProjectLoaded(cb: (dir: string) => void) {
  onProjectLoadedCallback = cb;
}

export function registerProject(dir: string): void {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const regPath = path.join(configDir, "registered_projects.json");
    let projects: string[] = [];
    if (fs.existsSync(regPath)) {
      try {
        const data = fs.readFileSync(regPath, "utf-8");
        projects = JSON.parse(data);
      } catch {
        projects = [];
      }
    }
    if (!Array.isArray(projects)) {
      projects = [];
    }
    const absPath = path.resolve(dir);
    if (!projects.includes(absPath)) {
      projects.push(absPath);
      fs.writeFileSync(regPath, JSON.stringify(projects, null, 2));
      console.error(`[Project-Registry] 📝 Registered new project: ${absPath}`);
    }
  } catch (err) {
    console.error(`[Project-Registry] ❌ Failed to register project: ${err}`);
  }
}

export function scanForCodeatlasProjects(parentDir: string): string[] {
  const discovered: string[] = [];
  try {
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      return [];
    }
    
    // If the directory itself contains .codeatlas, it is a project
    if (fs.existsSync(path.join(parentDir, ".codeatlas"))) {
      discovered.push(path.resolve(parentDir));
      return discovered;
    }
    
    // Otherwise, scan subdirectories up to 2 levels deep
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        const subPath = path.join(parentDir, entry.name);
        if (fs.existsSync(path.join(subPath, ".codeatlas"))) {
          discovered.push(path.resolve(subPath));
        } else {
          // Check 2nd level
          try {
            const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
            for (const subEntry of subEntries) {
              if (subEntry.isDirectory() && subEntry.name !== "node_modules" && !subEntry.name.startsWith(".")) {
                const subSubPath = path.join(subPath, subEntry.name);
                if (fs.existsSync(path.join(subSubPath, ".codeatlas"))) {
                  discovered.push(path.resolve(subSubPath));
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch (err) {
    console.error(`[Project-Discovery] ❌ Failed to scan for .codeatlas projects: ${err}`);
  }
  return discovered;
}

export async function scanForCodeatlasProjectsAsync(parentDir: string): Promise<string[]> {
  const discovered: string[] = [];
  try {
    if (!(await fileExists(parentDir))) {
      return [];
    }
    const parentStat = await fs.promises.stat(parentDir);
    if (!parentStat.isDirectory()) {
      return [];
    }
    
    if (await fileExists(path.join(parentDir, ".codeatlas"))) {
      discovered.push(path.resolve(parentDir));
      return discovered;
    }
    
    const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        const subPath = path.join(parentDir, entry.name);
        if (await fileExists(path.join(subPath, ".codeatlas"))) {
          discovered.push(path.resolve(subPath));
        } else {
          // Check 2nd level
          try {
            const subEntries = await fs.promises.readdir(subPath, { withFileTypes: true });
            for (const subEntry of subEntries) {
              if (subEntry.isDirectory() && subEntry.name !== "node_modules" && !subEntry.name.startsWith(".")) {
                const subSubPath = path.join(subPath, subEntry.name);
                if (await fileExists(path.join(subSubPath, ".codeatlas"))) {
                  discovered.push(path.resolve(subSubPath));
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch (err) {
    console.error(`[Project-Discovery] ❌ Failed async scan for .codeatlas projects: ${err}`);
  }
  return discovered;
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

    // 1. If tenantId is provided, always add the tenant's own projects
    if (tenantId) {
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
    }

    // 2. If system admin, also add system-wide and all tenants' directories
    if (isSystemAdmin) {
      if (process.env.CODEATLAS_PROJECT_DIR) {
        searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
      }
      searchDirs.push(process.cwd());

      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      if (fs.existsSync(tenantRoot)) {
        try {
          const tenants = fs.readdirSync(tenantRoot);
          for (const t of tenants) {
            if (t === tenantId) continue;
            const tDir = path.join(tenantRoot, t);
            if (fs.statSync(tDir).isDirectory()) {
              const tProjects = fs.readdirSync(tDir);
              for (const p of tProjects) {
                const fullPath = path.join(tDir, p);
                if (fs.statSync(fullPath).isDirectory()) {
                  searchDirs.push(fullPath);
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    if (!tenantId && !isSystemAdmin) {
      return [];
    }
  } else {
    if (process.env.CODEATLAS_PROJECT_DIR) {
      searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
    }
    
    // Dynamically search process.cwd() for any projects configured with .codeatlas
    const localProjects = scanForCodeatlasProjects(process.cwd());
    searchDirs.push(...localProjects);
    
    // Fallback to process.cwd() if no subprojects were found with .codeatlas configuration
    if (!searchDirs.includes(process.cwd())) {
      searchDirs.push(process.cwd());
    }

    const projectsDir = path.join(process.cwd(), "projects");
    if (fs.existsSync(projectsDir)) {
      try {
        const subDirs = fs.readdirSync(projectsDir);
        for (const p of subDirs) {
          const fullPath = path.join(projectsDir, p);
          if (fs.statSync(fullPath).isDirectory()) {
            searchDirs.push(fullPath);
          }
        }
      } catch { /* skip */ }
    }

    // Load globally registered projects
    try {
      const homeDir = os.homedir();
      const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");
      if (fs.existsSync(regPath)) {
        const registered = JSON.parse(fs.readFileSync(regPath, "utf-8"));
        if (Array.isArray(registered)) {
          for (const dir of registered) {
            if (fs.existsSync(dir)) {
              searchDirs.push(dir);
            }
          }
        }
      }
    } catch { /* skip */ }
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

export function loadAnalysis(projectDir?: string, force = false): { analysis: AnalysisResult; projectName: string; projectDir: string } | null {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;
  
  const projects = discoverProjects(tenantId);
  if (projects.length === 0) return null;

  let target: { name: string; dir: string; analysisPath: string; modifiedAt: Date } | undefined = projects[0];

  if (projectDir) {
    const absPath = path.resolve(projectDir);
    let match = projects.find(
      (p) => p.dir === absPath || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) {
      target = match;
      registerProject(target.dir);
    } else if (fs.existsSync(absPath) && isProjectDirectory(absPath)) {
      registerProject(absPath);
      const reDiscovered = discoverProjects(tenantId);
      match = reDiscovered.find((p) => p.dir === absPath);
      if (match) {
        target = match;
      } else {
        return null;
      }
    } else {
      return null;
    }
  } else if (target) {
    registerProject(target.dir);
  }

  try {
    if (onProjectLoadedCallback) {
      onProjectLoadedCallback(target.dir);
    }
    if (!fs.existsSync(target.analysisPath)) {
      console.error(`[Auto-Scan] ❌ Dynamic sync scanning is not supported on the server repo. Please push analysis from MCP client: ${target.dir}`);
      return null;
    }
    const data = fs.readFileSync(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    console.error(`[Auto-Scan] ❌ Loading analysis failed: ${err}`);
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

    // 1. If tenantId is provided, always add the tenant's own projects
    if (tenantId) {
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
    }

    // 2. If system admin, also add system-wide and all tenants' directories
    if (isSystemAdmin) {
      if (process.env.CODEATLAS_PROJECT_DIR) {
        searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
      }
      searchDirs.push(process.cwd());

      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      if (await fileExists(tenantRoot)) {
        try {
          const tenants = await fs.promises.readdir(tenantRoot);
          for (const t of tenants) {
            if (t === tenantId) continue;
            const tDir = path.join(tenantRoot, t);
            try {
              const tStat = await fs.promises.stat(tDir);
              if (tStat.isDirectory()) {
                const tProjects = await fs.promises.readdir(tDir);
                for (const p of tProjects) {
                  const fullPath = path.join(tDir, p);
                  try {
                    const stat = await fs.promises.stat(fullPath);
                    if (stat.isDirectory()) {
                      searchDirs.push(fullPath);
                    }
                  } catch { /* skip */ }
                }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }

    if (!tenantId && !isSystemAdmin) {
      return [];
    }
  } else {
    if (process.env.CODEATLAS_PROJECT_DIR) {
      searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
    }
    
    // Dynamically search process.cwd() for any projects configured with .codeatlas
    const localProjects = await scanForCodeatlasProjectsAsync(process.cwd());
    searchDirs.push(...localProjects);
    
    // Fallback to process.cwd() if no subprojects were found with .codeatlas configuration
    if (!searchDirs.includes(process.cwd())) {
      searchDirs.push(process.cwd());
    }

    const projectsDir = path.join(process.cwd(), "projects");
    if (await fileExists(projectsDir)) {
      try {
        const subDirs = await fs.promises.readdir(projectsDir);
        for (const p of subDirs) {
          const fullPath = path.join(projectsDir, p);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
              searchDirs.push(fullPath);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    // Load globally registered projects
    try {
      const homeDir = os.homedir();
      const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");
      if (await fileExists(regPath)) {
        const data = await fs.promises.readFile(regPath, "utf-8");
        const registered = JSON.parse(data);
        if (Array.isArray(registered)) {
          for (const dir of registered) {
            if (await fileExists(dir)) {
              searchDirs.push(dir);
            }
          }
        }
      }
    } catch { /* skip */ }
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

export async function loadAnalysisAsync(projectDir?: string, force = false): Promise<{ analysis: AnalysisResult; projectName: string; projectDir: string } | null> {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;
  
  const projects = await discoverProjectsAsync(tenantId);
  if (projects.length === 0) return null;

  let target: { name: string; dir: string; analysisPath: string; modifiedAt: Date } | undefined = projects[0];

  if (projectDir) {
    const absPath = path.resolve(projectDir);
    let match = projects.find(
      (p) => p.dir === absPath || p.name.toLowerCase() === projectDir.toLowerCase()
    );
    if (match) {
      target = match;
      registerProject(target.dir);
    } else if (await fileExists(absPath) && await isProjectDirectoryAsync(absPath)) {
      registerProject(absPath);
      const reDiscovered = await discoverProjectsAsync(tenantId);
      match = reDiscovered.find((p) => p.dir === absPath);
      if (match) {
        target = match;
      } else {
        return null;
      }
    } else {
      return null;
    }
  } else if (target) {
    registerProject(target.dir);
  }

  try {
    if (onProjectLoadedCallback) {
      onProjectLoadedCallback(target.dir);
    }
    if (!await fileExists(target.analysisPath)) {
      console.error(`[Auto-Scan] ❌ Dynamic async scanning is not supported on the server repo. Please push analysis from MCP client: ${target.dir}`);
      return null;
    }

    const data = await fs.promises.readFile(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    console.error(`[Auto-Scan] ❌ Loading analysis failed: ${err}`);
    return null;
  }
}
