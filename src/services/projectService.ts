import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as os from "os";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { AnalysisResult } from "../types/index.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { indexingService } from "./indexingService.js";

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

// ⚡ Bolt: Cache dynamic paths to avoid recomputing in tight loops
const cachedHomeDir = os.homedir();
const cachedDynamicAntigravityPath = path.join(cachedHomeDir, ".gemini", "antigravity");

// ⚡ Bolt: Bounded LRU cache to avoid redundant expensive fs.existsSync calls during project discovery
const ideDirCache = new Map<string, { isIde: boolean; timestamp: number }>();
const IDE_DIR_CACHE_MAX_SIZE = 1000;
// TTL ensures entries that haven't been accessed for 60s expire
const CACHE_TTL_MS = 60000;

export function isSystemIdeDirectory(dir: string): boolean {
  try {
    const trimmedDir = dir.trim();
    if (!trimmedDir) return false;
    const absPath = path.resolve(trimmedDir);
    const now = Date.now();
    
    // ⚡ Bolt: LRU-style access and TTL cache check
    if (ideDirCache.has(absPath)) {
      const entry = ideDirCache.get(absPath)!;
      if (now - entry.timestamp < CACHE_TTL_MS) {
        // Refresh access order by deleting and re-inserting
        ideDirCache.delete(absPath);
        ideDirCache.set(absPath, { isIde: entry.isIde, timestamp: now });
        return entry.isIde;
      }
      // Expired
      ideDirCache.delete(absPath);
    }

    let isIde = false;

    if (absPath === "/config/Downloads/Antigravity" || absPath.startsWith("/config/Downloads/Antigravity/")) {
      isIde = true;
    } else if (absPath === cachedDynamicAntigravityPath || absPath.startsWith(cachedDynamicAntigravityPath + path.sep)) {
      isIde = true;
    } else if (absPath === cachedHomeDir || absPath === "/" || absPath === "/config") {
      isIde = true;
    } else {
      const parts = absPath.split(path.sep);
      if (parts.some(part => part.startsWith('.') && !part.startsWith('..') && part !== '.codeatlas')) {
        isIde = true;
      } else if (
        fs.existsSync(path.join(absPath, "resources", "app", "extensions")) ||
        fs.existsSync(path.join(absPath, "resources", "app", "out", "vs"))
      ) {
        isIde = true;
      }
    }

    // ⚡ Bolt: Manage cache size (evict least recently used)
    if (ideDirCache.size > IDE_DIR_CACHE_MAX_SIZE) {
      // Because we delete/re-insert on access, Map's insertion order guarantees the first elements are the LRU
      const keysToDelete = Array.from(ideDirCache.keys()).slice(0, Math.floor(IDE_DIR_CACHE_MAX_SIZE / 10));
      for (const key of keysToDelete) ideDirCache.delete(key);
    }

    ideDirCache.set(absPath, { isIde, timestamp: now });
    return isIde;
  } catch {
    // Ignore errors
    return false;
  }
}

const IDE_KEYWORDS = ['code', 'vscode', 'cursor', 'windsurf', 'intellij', 'webstorm', 'phpstorm', 'idea', 'eclipse', 'sublime', 'gemini-cli'];
const IDE_REGEX = new RegExp(IDE_KEYWORDS.join('|'));

export async function getOpenIdeForDirAsync(dir: string): Promise<string | null> {
  try {
    const absPath = path.resolve(dir.trim());
    try {
      await fs.promises.access('/proc');
    } catch {
      return null;
    }

    const files = await fs.promises.readdir('/proc');
    const basename = path.basename(absPath);

    const checkPid = async (file: string): Promise<string | null> => {
      if (!/^\d+$/.test(file)) return null;
      const cmdlinePath = `/proc/${file}/cmdline`;
      try {
        const cmdline = await fs.promises.readFile(cmdlinePath, 'utf8');

        // Fast path: use Regex test instead of iterating keywords array
        if (!IDE_REGEX.test(cmdline)) return null;

        if (!cmdline.includes(basename) && !cmdline.includes(absPath)) {
            return null;
        }

        const args = cmdline.split('\0').filter(Boolean);
        if (args.length === 0) return null;

        const hasDirArg = args.some(arg => {
          try {
            return path.resolve(arg) === absPath;
          } catch {
            return false;
          }
        });

        if (hasDirArg) {
          const exePath = args[0].toLowerCase();
          if (IDE_REGEX.test(exePath)) {
            return path.basename(args[0]);
          }
        }
      } catch {
        // ignore
      }
      return null;
    };

    const pids = files.filter(f => /^\d+$/.test(f));
    const chunkSize = 50;

    for (let i = 0; i < pids.length; i += chunkSize) {
      const chunk = pids.slice(i, i + chunkSize);
      const results = await Promise.all(chunk.map(checkPid));
      for (const res of results) {
        if (res !== null) return res;
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


async function loadRegisteredProjectsAsync(regPath: string): Promise<string[]> {
  try {
    const data = await fs.promises.readFile(regPath, "utf-8");
    const projects = JSON.parse(data);
    if (!Array.isArray(projects)) {
      logger.warn(`[Project-Registry] ⚠️ Invalid JSON structure at ${regPath}. Expected array. Returning empty array.`);
      return [];
    }
    return projects;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return [];
    }
    if (err instanceof SyntaxError) {
      logger.warn(`[Project-Registry] ⚠️ Failed to parse JSON at ${regPath}. Returning empty array.`);
      return [];
    }
    throw err;
  }
}

export async function registerProjectAsync(dir: string): Promise<void> {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    await fs.promises.mkdir(configDir, { recursive: true });

    const regPath = path.join(configDir, "registered_projects.json");
    const projects = await loadRegisteredProjectsAsync(regPath);
    const absPath = path.resolve(dir);
    if (isSystemIdeDirectory(absPath)) {
      return;
    }
    if (!projects.includes(absPath)) {
      projects.push(absPath);
      await fs.promises.writeFile(regPath, JSON.stringify(projects, null, 2));
      logger.info(`[Project-Registry] 📝 Registered new project (async): ${absPath}`);
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to register project (async): ${err}`);
  }
}

export function unregisterProject(dir: string): void {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    const regPath = path.join(configDir, "registered_projects.json");

    let projects: string[] = [];
    try {
      const data = fs.readFileSync(regPath, "utf-8");
      projects = JSON.parse(data);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        projects = [];
      }
    }

    if (Array.isArray(projects) && projects.length > 0) {
      const absPath = path.resolve(dir);
      const filtered = projects.filter((p) => p !== absPath);
      if (filtered.length !== projects.length) {
        fs.writeFileSync(regPath, JSON.stringify(filtered, null, 2));
        logger.info(`[Project-Registry] 📝 Unregistered project: ${absPath}`);
      }
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to unregister project: ${err}`);
    throw err;
  }
}

export async function unregisterProjectAsync(dir: string): Promise<void> {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    const regPath = path.join(configDir, "registered_projects.json");

    const projects = await loadRegisteredProjectsAsync(regPath);
    if (projects.length === 0) return;

    const absPath = path.resolve(dir);
    const filtered = projects.filter((p) => p !== absPath);
    if (filtered.length !== projects.length) {
      await fs.promises.writeFile(regPath, JSON.stringify(filtered, null, 2));
      logger.info(`[Project-Registry] 📝 Unregistered project (async): ${absPath}`);
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to unregister project (async): ${err}`);
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
    let parentStat;
    try {
      parentStat = await fs.promises.stat(parentDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
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
      ? (auth.uid === "admin" || auth.role === "admin")
      : (tenantId === "admin");

    // 1. If tenantId is provided, always add the tenant's own projects
    if (tenantId) {
      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      const userDir = path.join(tenantRoot, tenantId);
      if (fs.existsSync(userDir)) {
        try {
          // ⚡ Bolt: Using { withFileTypes: true } to get fs.Dirent objects directly from readdir,
          // avoiding N separate expensive fs.stat() system calls to check for isDirectory().
          const userProjects = fs.readdirSync(userDir, { withFileTypes: true });
          for (const p of userProjects) {
            if (p.isDirectory()) {
              searchDirs.push(path.join(userDir, p.name));
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
      if (process.env.CODEATLAS_MULTI_TENANT !== "true") {
        searchDirs.push(process.cwd());
      }

      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      if (fs.existsSync(tenantRoot)) {
        try {
          const tenants = fs.readdirSync(tenantRoot, { withFileTypes: true });
          for (const t of tenants) {
            if (t.name === tenantId) continue;
            const tDir = path.join(tenantRoot, t.name);
            if (t.isDirectory()) {
              const tProjects = fs.readdirSync(tDir, { withFileTypes: true });
              for (const p of tProjects) {
                if (p.isDirectory()) {
                  searchDirs.push(path.join(tDir, p.name));
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
        const subDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const p of subDirs) {
          if (p.isDirectory()) {
            searchDirs.push(path.join(projectsDir, p.name));
          }
        }
      } catch { /* skip */ }
    }

    // Load globally registered projects
    try {
      const homeDir = os.homedir();
      const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");

      let registered: any = [];
      try {
        const data = fs.readFileSync(regPath, "utf-8");
        registered = JSON.parse(data);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          // Keep old behavior: swallow parse errors gracefully
          registered = [];
        }
      }

      if (registered) {
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
        // ⚡ Bolt: Use EAFP pattern to avoid redundant fs.existsSync system call overhead before statSync
        try {
          modifiedAt = fs.statSync(analysisPath).mtime;
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            modifiedAt = fs.statSync(dir).mtime;
          } else {
            throw err;
          }
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
      registerProjectAsync(target.dir).catch(() => {});
    } else if (fs.existsSync(absPath) && isProjectDirectory(absPath)) {
      registerProjectAsync(absPath).catch(() => {});
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
    registerProjectAsync(target.dir).catch(() => {});
  }

  try {
    if (onProjectLoadedCallback) {
      onProjectLoadedCallback(target.dir);
    }
    let data: string;
    // ⚡ Bolt: Use EAFP pattern to avoid redundant fs.existsSync system call overhead before readFileSync
    try {
      data = fs.readFileSync(target.analysisPath, "utf-8");
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.error(`[Auto-Scan] ❌ Dynamic sync scanning is not supported on the server repo. Please push analysis from MCP client: ${target.dir}`);
        return null;
      }
      throw err;
    }
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
      ? (auth.uid === "admin" || auth.role === "admin")
      : (tenantId === "admin");

    // 1. If tenantId is provided, always add the tenant's own projects
    if (tenantId) {
      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      const userDir = path.join(tenantRoot, tenantId);
      if (await fileExists(userDir)) {
        try {
          // ⚡ Bolt: Using { withFileTypes: true } to get fs.Dirent objects directly from readdir,
          // avoiding N separate expensive fs.stat() system calls to check for isDirectory().
          const userProjects = await fs.promises.readdir(userDir, { withFileTypes: true });
          userProjects.forEach((p) => {
            if (p.isDirectory()) {
              searchDirs.push(path.join(userDir, p.name));
            }
          });
        } catch { /* skip */ }
      }
    }

    // 2. If system admin, also add system-wide and all tenants' directories
    if (isSystemAdmin) {
      if (process.env.CODEATLAS_PROJECT_DIR) {
        searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
      }
      if (process.env.CODEATLAS_MULTI_TENANT !== "true") {
        searchDirs.push(process.cwd());
      }

      const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
      if (await fileExists(tenantRoot)) {
        try {
          const tenants = await fs.promises.readdir(tenantRoot, { withFileTypes: true });
          await Promise.all(tenants.map(async (t) => {
            if (t.name === tenantId) return;
            const tDir = path.join(tenantRoot, t.name);
            if (t.isDirectory()) {
              try {
                const tProjects = await fs.promises.readdir(tDir, { withFileTypes: true });
                tProjects.forEach((p) => {
                  if (p.isDirectory()) {
                    searchDirs.push(path.join(tDir, p.name));
                  }
                });
              } catch { /* skip */ }
            }
          }));
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
        const subDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
        subDirs.forEach((p) => {
          if (p.isDirectory()) {
            searchDirs.push(path.join(projectsDir, p.name));
          }
        });
      } catch { /* skip */ }
    }

    // Load globally registered projects
    try {
      const homeDir = os.homedir();
      const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");

      const registered = await loadRegisteredProjectsAsync(regPath);

      if (registered.length > 0) {
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
    } catch (err) {
      logger.error(`[Auto-Scan] ❌ Failed to load registered projects: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Add all git repos discovered by the indexing service
    const indexedProjectDirs = indexingService.getProjectDirs();
    if (indexedProjectDirs.length > 0) {
      for (const dir of indexedProjectDirs) {
        if (!searchDirs.includes(dir)) {
          searchDirs.push(dir);
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqueDirs = searchDirs.filter(dir => {
    if (seen.has(dir) || isSystemIdeDirectory(dir)) return false;
    seen.add(dir);
    return true;
  });

  const chunkSize = 50; // Batch file system operations to prevent EMFILE
  for (let i = 0; i < uniqueDirs.length; i += chunkSize) {
    const chunk = uniqueDirs.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (dir) => {
        if (await isProjectDirectoryAsync(dir)) {
          try {
            const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
            let modifiedAt: Date;
            try {
              modifiedAt = (await fs.promises.stat(analysisPath)).mtime;
            } catch (err: any) {
              if (err.code === 'ENOENT') {
                modifiedAt = (await fs.promises.stat(dir)).mtime;
              } else {
                throw err;
              }
            }
            return {
              name: path.basename(dir),
              dir,
              analysisPath,
              modifiedAt,
            };
          } catch { /* skip */ }
        }
        return null;
      })
    );
    for (const res of results) {
      if (res) projects.push(res);
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
      await registerProjectAsync(target.dir);
    } else if (await fileExists(absPath) && await isProjectDirectoryAsync(absPath)) {
      await registerProjectAsync(absPath);
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
    await registerProjectAsync(target.dir);
  }

  try {
    if (onProjectLoadedCallback) {
      onProjectLoadedCallback(target.dir);
    }
    let data: string;
    try {
      data = await fs.promises.readFile(target.analysisPath, "utf-8");
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.error(`[Auto-Scan] ❌ analysis.json not found at ${target.analysisPath}. Returning empty analysis for: ${target.dir}`);
        return { analysis: { graph: { nodes: [], links: [] }, insights: [], entityCounts: { modules: 0, functions: 0, classes: 0, dependencies: 0, circularDeps: 0 }, totalFilesAnalyzed: 0, totalFilesSkipped: 0 }, projectName: target.name, projectDir: target.dir };
      }
      throw err;
    }

    logger.debug(`[Auto-Scan] Read analysis data from ${target.analysisPath}`);
    const parsedData = JSON.parse(data);
    logger.debug("[Auto-Scan] Successfully parsed analysis data.");
    return { analysis: parsedData, projectName: target.name, projectDir: target.dir };
  } catch (err) {
    logger.error(`[Auto-Scan] ❌ Loading analysis failed for ${target?.analysisPath || 'unknown path'}: ${err}`);
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

