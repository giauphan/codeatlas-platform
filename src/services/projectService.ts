import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as os from "os";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { AnalysisResult } from "../types/index.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";

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

export function isSystemIdeDirectory(dir: string): boolean {
  try {
    const absPath = path.resolve(dir.trim());
    if (absPath === "/config/Downloads/Antigravity" || absPath.startsWith("/config/Downloads/Antigravity/")) {
      return true;
    }
    
    // Dynamically resolve ~/.gemini/antigravity across operating systems
    const homeDir = os.homedir();
    const dynamicAntigravityPath = path.resolve(path.join(homeDir, ".gemini", "antigravity"));
    if (absPath === dynamicAntigravityPath || absPath.startsWith(dynamicAntigravityPath + path.sep)) {
      return true;
    }

    // Ignore home directory itself, system root, or /config root
    if (absPath === homeDir || absPath === "/" || absPath === "/config") {
      return true;
    }

    // Ignore system/IDE configuration folders starting with a dot (e.g. .codeium, .vscode, .cursor)
    // but allow double-dot prefixes (like ..projectA)
    const parts = absPath.split(path.sep);
    if (parts.some(part => part.startsWith('.') && !part.startsWith('..') && part !== '.codeatlas')) {
      return true;
    }

    // Check if it's the IDE resources directory
    if (fs.existsSync(path.join(absPath, "resources", "app", "extensions")) ||
        fs.existsSync(path.join(absPath, "resources", "app", "out", "vs"))) {
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
}

export function getOpenIdeForDir(dir: string): string | null {
  try {
    const absPath = path.resolve(dir.trim());
    if (!fs.existsSync('/proc')) return null;
    const files = fs.readdirSync('/proc');
    for (const file of files) {
      if (/^\d+$/.test(file)) {
        const pid = file;
        const cmdlinePath = `/proc/${pid}/cmdline`;
        try {
          if (fs.existsSync(cmdlinePath)) {
            const cmdline = fs.readFileSync(cmdlinePath, 'utf8');
            const args = cmdline.split('\0').filter(Boolean);
            if (args.length === 0) continue;
            
            const hasDirArg = args.some(arg => {
              try {
                return path.resolve(arg) === absPath;
              } catch {
                return false;
              }
            });
            
            if (hasDirArg) {
              const exePath = args[0].toLowerCase();
              const ideKeywords = ['code', 'vscode', 'cursor', 'windsurf', 'intellij', 'webstorm', 'phpstorm', 'idea', 'eclipse', 'sublime', 'gemini-cli'];
              for (const keyword of ideKeywords) {
                if (exePath.includes(keyword)) {
                  return path.basename(args[0]);
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function isProjectDirectory(dir: string): boolean {
  if (isSystemIdeDirectory(dir)) {
    return false;
  }
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return false;
    }
    const gitPath = path.join(dir, ".git");
    if (fs.existsSync(gitPath)) {
      return true;
    }
    const codeatlasPath = path.join(dir, ".codeatlas");
    if (fs.existsSync(codeatlasPath)) {
      // Must be a project .codeatlas (has analysis.json or settings.json),
      // not the global config directory at ~/.codeatlas/
      if (fs.existsSync(path.join(codeatlasPath, "analysis.json")) ||
          fs.existsSync(path.join(codeatlasPath, "settings.json"))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function isProjectDirectoryAsync(dir: string): Promise<boolean> {
  if (isSystemIdeDirectory(dir)) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) {
      return false;
    }
    const gitPath = path.join(dir, ".git");
    if (await fileExists(gitPath)) {
      return true;
    }
    const codeatlasPath = path.join(dir, ".codeatlas");
    if (await fileExists(codeatlasPath)) {
      // Must be a project .codeatlas (has analysis.json or settings.json),
      // not the global config directory at ~/.codeatlas/
      if (await fileExists(path.join(codeatlasPath, "analysis.json")) ||
          await fileExists(path.join(codeatlasPath, "settings.json"))) {
        return true;
      }
    }
    return false;
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
    if (isSystemIdeDirectory(absPath)) {
      return;
    }
    if (!projects.includes(absPath)) {
      projects.push(absPath);
      fs.writeFileSync(regPath, JSON.stringify(projects, null, 2));
      logger.info(`[Project-Registry] 📝 Registered new project: ${absPath}`);
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to register project: ${err}`);
  }
}

export function unregisterProject(dir: string): void {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    const regPath = path.join(configDir, "registered_projects.json");
    if (fs.existsSync(regPath)) {
      let projects: string[] = [];
      try {
        const data = fs.readFileSync(regPath, "utf-8");
        projects = JSON.parse(data);
      } catch {
        projects = [];
      }
      if (Array.isArray(projects)) {
        const absPath = path.resolve(dir);
        const filtered = projects.filter((p) => p !== absPath);
        if (filtered.length !== projects.length) {
          fs.writeFileSync(regPath, JSON.stringify(filtered, null, 2));
          logger.info(`[Project-Registry] 📝 Unregistered project: ${absPath}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to unregister project: ${err}`);
    throw err;
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
    logger.error(`[Project-Discovery] ❌ Failed to scan for .codeatlas projects: ${err}`);
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
    logger.error(`[Project-Discovery] ❌ Failed async scan for .codeatlas projects: ${err}`);
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
          let updated = false;
          const filtered = registered.filter((dir) => {
            if (isSystemIdeDirectory(dir)) {
              updated = true;
              return false;
            }
            return true;
          });
          if (updated) {
            fs.writeFileSync(regPath, JSON.stringify(filtered, null, 2));
          }
          for (const dir of filtered) {
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
    if (isSystemIdeDirectory(dir)) continue;

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
    if (isSystemIdeDirectory(absPath)) {
      logger.warn(`[Auto-Scan] 🛡️ Ignored IDE system/extensions directory from workspace indexing: ${absPath}`);
      return null;
    }
    let match = projects.find(
      (p) => p.dir === absPath || 
             p.name.toLowerCase() === projectDir.toLowerCase() ||
             path.relative(process.cwd(), p.dir).replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase()
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
      logger.error(`[Auto-Scan] ❌ Dynamic sync scanning is not supported on the server repo. Please push analysis from MCP client: ${target.dir}`);
      return null;
    }
    const data = fs.readFileSync(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    logger.error(`[Auto-Scan] ❌ Loading analysis failed: ${err}`);
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
          let updated = false;
          const filtered = registered.filter((dir) => {
            if (isSystemIdeDirectory(dir)) {
              updated = true;
              return false;
            }
            return true;
          });
          if (updated) {
            await fs.promises.writeFile(regPath, JSON.stringify(filtered, null, 2));
          }
          for (const dir of filtered) {
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
    if (isSystemIdeDirectory(dir)) continue;

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
    if (isSystemIdeDirectory(absPath)) {
      logger.warn(`[Auto-Scan] 🛡️ Ignored IDE system/extensions directory from workspace indexing: ${absPath}`);
      return null;
    }
    let match = projects.find(
      (p) => p.dir === absPath || 
             p.name.toLowerCase() === projectDir.toLowerCase() ||
             path.relative(process.cwd(), p.dir).replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase()
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
      logger.error(`[Auto-Scan] ❌ Dynamic async scanning is not supported on the server repo. Please push analysis from MCP client: ${target.dir}`);
      return null;
    }

    const data = await fs.promises.readFile(target.analysisPath, "utf-8");
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err) {
    logger.error(`[Auto-Scan] ❌ Loading analysis failed: ${err}`);
    return null;
  }
}

export async function resolveProjectDir(projectDir: string, tenantId?: string, requireExactPath = false): Promise<{ cleanProjectName: string; fullProjectDir: string } | null> {
  const projects = await discoverProjectsAsync(tenantId);
  const absPath = path.resolve(projectDir);
  const match = projects.find(
    (p) => p.dir === absPath || 
           path.relative(process.cwd(), p.dir).replace(/\\/g, "/").toLowerCase() === projectDir.replace(/\\/g, "/").toLowerCase() ||
           (!requireExactPath && p.name.toLowerCase() === projectDir.toLowerCase())
  );
  if (!match) return null;
  return {
    cleanProjectName: match.name,
    fullProjectDir: match.dir
  };
}

