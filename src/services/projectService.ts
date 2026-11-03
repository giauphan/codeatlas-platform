import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AnalysisResult } from "../types/index.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { indexingService } from "./indexingService.js";
import pLimit from "p-limit";

const FILE_EXISTS_CONCURRENCY = 50;

function normalizeProjectPath(projectPath: string): string {
  return projectPath.replaceAll("\\", "/").toLowerCase();
}

function findAnalysisProject(
  projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[],
  projectDir: string,
  absPath: string,
) {
  return projects.find(
    (project) => project.dir === absPath ||
      project.name.toLowerCase() === projectDir.toLowerCase() ||
      normalizeProjectPath(path.relative(process.cwd(), project.dir)) === normalizeProjectPath(projectDir)
  );
}

export interface AnalysisResultLocal extends AnalysisResult {
  stats?: { files: number; functions: number; classes: number; dependencies: number; circularDeps: number; deadCode: number };
}


/** Helper to retrieve boolean environment variables */
function getEnvVar(key: string): boolean {
  return process.env[key]?.toLowerCase() === "true";
}

/** Check if a directory entry is valid, conditionally following symlinks */
function isValidDirectory(entry: fs.Dirent): boolean {
  const followSymlinks = getEnvVar("CODEATLAS_FOLLOW_SYMLINKS");
  return entry.isDirectory() && (followSymlinks || !entry.isSymbolicLink());
}

/** Helper to format error messages robustly */
function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check if a path segment is safe to use in path.join — no path traversal,
 * no path separators, no control characters, no leading/trailing whitespace.
 */
function isSafePathSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (segment.includes(path.sep) || segment.includes('/')) return false;
  if (segment.includes('\\')) return false;
  if (/[\x00-\x1F\x7F]/.test(segment)) return false;
  if (segment.trim() !== segment) return false;
  return true;
}

/**
 * Check if a sub-path is safe to join to a base path — no traversal,
 * no absolute paths, no control characters.
 */
function isSafeSubPath(base: string, subPath: string): boolean {
  if (path.isAbsolute(subPath)) return false;
  const parts = subPath.split(path.sep);
  if (!parts.every(isSafePathSegment)) return false;
  // Ensure the joined path resolves to a sub-path of base (no traversal)
  try {
    const joined = path.join(base, subPath);
    const resolved = path.resolve(joined);
    const baseResolved = path.resolve(base);
    return resolved.startsWith(baseResolved + path.sep) || resolved === baseResolved;
  } catch {
    return false;
  }
}

/** Helper to check if an error is a recoverable/expected filesystem error */
function isRecoverableError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'EACCES' || code === 'ENOENT';
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

function hasIdeApplicationResources(absPath: string): boolean {
  const extPath = path.join(absPath, "resources", "app", "extensions");
  const relExt = path.relative(absPath, extPath);
  const vsPath = path.join(absPath, "resources", "app", "out", "vs");
  const relVs = path.relative(absPath, vsPath);
  return (
    (!relExt.startsWith("..") && !path.isAbsolute(relExt) && fs.existsSync(extPath)) ||
    (!relVs.startsWith("..") && !path.isAbsolute(relVs) && fs.existsSync(vsPath))
  );
}

function detectSystemIdeDirectory(absPath: string): boolean {
  if (absPath === "/config/Downloads/Antigravity" || absPath.startsWith("/config/Downloads/Antigravity/")) {
    return true;
  }
  if (absPath === cachedDynamicAntigravityPath || absPath.startsWith(cachedDynamicAntigravityPath + path.sep)) {
    return true;
  }
  if (absPath === cachedHomeDir || absPath === "/" || absPath === "/config") {
    return true;
  }

  const parts = absPath.split(path.sep);
  const hasHiddenDirectory = parts.some(
    part => part.startsWith('.') && !part.startsWith('..') && part !== '.codeatlas' && part !== '.claude'
  );
  return hasHiddenDirectory || hasIdeApplicationResources(absPath);
}

export function isSystemIdeDirectory(dir: string): boolean {
  try {
    const trimmedDir = dir.trim();
    if (!trimmedDir) return false;
    const absPath = path.resolve(trimmedDir);
    // Sanitize path to satisfy CodeQL static analysis rules against path injection
    if (absPath.includes("\0") || /[\x00-\x1F\x7F]/.test(absPath)) {
      return false;
    }
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

    const isIde = detectSystemIdeDirectory(absPath);

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
        // Sanitize to satisfy CodeQL path-injection static analysis
        if (codeatlasPath.includes("\0") || /[\x00-\x1F\x7F]/.test(codeatlasPath)) {
          return false;
        }
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
    const resolvedDir = path.normalize(path.resolve(dir));
    const rel = path.relative("/", resolvedDir);
    if (rel.startsWith("..") || resolvedDir.includes("\0") || /[\x00-\x1F\x7F]/.test(resolvedDir)) {
      return false;
    }
    const stat = await fs.promises.stat(resolvedDir);
    if (!stat.isDirectory()) {
      return false;
    }
    const gitPath = path.join(resolvedDir, ".git");
    if (isSafeSubPath(resolvedDir, ".git") && await fileExists(gitPath)) {
      return true;
    }
    const codeatlasPath = path.join(resolvedDir, ".codeatlas");
    if (isSafeSubPath(resolvedDir, ".codeatlas") && await fileExists(codeatlasPath)) {
      // Must be a project .codeatlas (has analysis.json or settings.json),
      // not the global config directory at ~/.codeatlas/
      if (isSafeSubPath(codeatlasPath, "analysis.json") && await fileExists(path.join(codeatlasPath, "analysis.json")) ||
          isSafeSubPath(codeatlasPath, "settings.json") && await fileExists(path.join(codeatlasPath, "settings.json"))) {
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
    const resolvedPath = path.normalize(path.resolve(filePath));
    // Sanitize path to satisfy CodeQL static analysis rules against path injection
    const rel = path.relative("/", resolvedPath);
    if (rel.startsWith("..") || resolvedPath.includes("\0") || /[\x00-\x1F\x7F]/.test(resolvedPath)) {
      return false;
    }
    await fs.promises.access(resolvedPath);
    return true;
  } catch {
    return false;
  }
}

let onProjectLoadedCallback: ((dir: string) => void) | null = null;
export function registerOnProjectLoaded(cb: (dir: string) => void) {
  onProjectLoadedCallback = cb;
}


export async function registerProjectAsync(dir: string): Promise<void> {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, ".codeatlas");
    await fs.promises.mkdir(configDir, { recursive: true });

    const regPath = path.join(configDir, "registered_projects.json");
    let projects: string[] = [];
    if (await fileExists(regPath)) {
      try {
        const data = await fs.promises.readFile(regPath, "utf-8");
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
    if (await fileExists(regPath)) {
      let projects: string[] = [];
      try {
        const data = await fs.promises.readFile(regPath, "utf-8");
        projects = JSON.parse(data);
      } catch {
        projects = [];
      }
      if (Array.isArray(projects)) {
        const absPath = path.resolve(dir);
        const filtered = projects.filter((p) => p !== absPath);
        if (filtered.length !== projects.length) {
          await fs.promises.writeFile(regPath, JSON.stringify(filtered, null, 2));
          logger.info(`[Project-Registry] 📝 Unregistered project (async): ${absPath}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[Project-Registry] ❌ Failed to unregister project (async): ${err}`);
    throw err;
  }
}

function scanProjectChildren(parentDir: string, discovered: string[]): void {
  const entries = fs.readdirSync(parentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!isScanableDirectory(entry)) continue;
    const subPath = path.join(parentDir, entry.name);
    if (fs.existsSync(path.join(subPath, ".codeatlas"))) discovered.push(path.resolve(subPath));
    else scanProjectGrandchildren(subPath, discovered);
  }
}

function scanProjectGrandchildren(parentDir: string, discovered: string[]): void {
  try {
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!isScanableDirectory(entry)) continue;
      const child = path.join(parentDir, entry.name);
      if (fs.existsSync(path.join(child, ".codeatlas"))) discovered.push(path.resolve(child));
    }
  } catch { /* skip */ }
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

    scanProjectChildren(parentDir, discovered);
  } catch (err) {
    logger.error(`[Project-Discovery] ❌ Failed to scan for .codeatlas projects: ${extractErrorMessage(err)}`);
  }
  return discovered;
}

/**
 * Scans a directory 2-levels deep to discover '.codeatlas' projects.
 * Uses a manual chunked concurrency strategy to avoid EMFILE limits.
 */
const isScanableDirectory = (entry: fs.Dirent) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".");

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

    /** Default limits for parallel fs checks */
    const DEFAULT_CONCURRENCY_LIMIT = 50;
    /** Safe max ceiling on concurrency to protect OS resources against misconfiguration */
    const MAX_CONCURRENCY_CAP = 1000;

    let concurrencyLimit = DEFAULT_CONCURRENCY_LIMIT;
    if (process.env.CODEATLAS_PROJECT_SCAN_CHUNK_SIZE) {
      const parsed = Number.parseInt(process.env.CODEATLAS_PROJECT_SCAN_CHUNK_SIZE, 10);
      if (!Number.isNaN(parsed) && parsed >= 1) {
        concurrencyLimit = Math.min(parsed, MAX_CONCURRENCY_CAP);
      }
    }

    // Process directory entries sequentially via chunks to naturally limit concurrency
    // and avoid EMFILE without requiring external dependencies or nested deadlock risks.
    const processDirEntry = async (entry: fs.Dirent, currentParentDir: string, currentDiscovered: string[]): Promise<void> => {
      try {
        if (!isScanableDirectory(entry)) return;

        const subPath = path.join(currentParentDir, entry.name);
        if (await fileExists(path.join(subPath, ".codeatlas"))) {
          currentDiscovered.push(path.resolve(subPath));
        } else {
          // checkSecondLevel inlined
          try {
            const subEntries = await fs.promises.readdir(subPath, { withFileTypes: true });
            // We chunk the sub entries to strictly bound deeply nested directories
            // and prevent massive Promise.all spikes that could exhaust OS resources on massive repos.
            for (let i = 0; i < subEntries.length; i += concurrencyLimit) {
              const chunk = subEntries.slice(i, i + concurrencyLimit);
              await Promise.all(chunk.map(async (subEntry) => { // NOSONAR
                if (isScanableDirectory(subEntry)) {
                  const subSubPath = path.join(subPath, subEntry.name);
                  if (await fileExists(path.join(subSubPath, ".codeatlas"))) {
                    currentDiscovered.push(path.resolve(subSubPath));
                  }
                }
              }));
            }
          } catch (err: unknown) {
            if (isRecoverableError(err)) {
              logger.debug(`[Project-Discovery] 🛡️ Ignored inaccessible sub-directory: ${subPath}`);
              return;
            }
            logger.warn(`[Project-Discovery] ⚠️ Skipped sub-directory read for ${subPath}: ${extractErrorMessage(err)}`);
          }
        }
      } catch (err: unknown) {
        if (isRecoverableError(err)) {
          logger.debug(`[Project-Discovery] 🛡️ Ignored inaccessible directory entry: ${entry.name}`);
          return;
        }
        logger.warn(`[Project-Discovery] ⚠️ Skipped processing entry ${entry.name}: ${extractErrorMessage(err)}`);
      }
    };

    for (let i = 0; i < entries.length; i += concurrencyLimit) {
      const chunk = entries.slice(i, i + concurrencyLimit);
      await Promise.all(chunk.map(entry => processDirEntry(entry, parentDir, discovered))); // NOSONAR
    }
  } catch (err) {
    logger.error(`[Project-Discovery] ❌ Failed to read parent directory during scan: ${extractErrorMessage(err)}`);
  }
  return discovered;
}

async function appendProjectDirectories(parent: string, searchDirs: string[]): Promise<void> {
  if (!await fileExists(parent)) return;
  try {
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (isValidDirectory(entry)) searchDirs.push(path.join(parent, entry.name));
    }
  } catch { /* Skip non-accessible directories */ }
}

async function appendOtherTenants(tenantRoot: string, tenantId: string | undefined, searchDirs: string[]): Promise<void> {
  if (!await fileExists(tenantRoot)) return;
  try {
    const tenants = await fs.promises.readdir(tenantRoot, { withFileTypes: true });
    const limit = pLimit(FILE_EXISTS_CONCURRENCY);
    await Promise.all(tenants.map(tenant => limit(async () => {
      if (tenant.name === tenantId || !isValidDirectory(tenant)) return;
      const tenantDir = path.join(tenantRoot, tenant.name);
      try {
        const projects = await fs.promises.readdir(tenantDir, { withFileTypes: true });
        for (const project of projects) {
          if (isValidDirectory(project)) searchDirs.push(path.join(tenantDir, project.name));
        }
      } catch { /* Skip non-accessible directories */ }
    })));
  } catch { /* skip */ }
}

async function collectTenantSearchDirs(tenantId: string | undefined, searchDirs: string[]): Promise<boolean> {
  const auth = authStorage.getStore();
  const isSystemAdmin = auth ? (auth.uid === "admin" || auth.role === "admin") : tenantId === "admin";
  const tenantRoot = process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants");
  if (tenantId) await appendProjectDirectories(path.join(tenantRoot, tenantId), searchDirs);
  if (isSystemAdmin) {
    if (process.env.CODEATLAS_PROJECT_DIR) searchDirs.push(process.env.CODEATLAS_PROJECT_DIR);
    if (process.env.CODEATLAS_MULTI_TENANT !== "true") searchDirs.push(process.cwd());
    await appendOtherTenants(process.env.CODEATLAS_PROJECTS_ROOT || path.join(process.cwd(), "tenants"), tenantId, searchDirs);
  }
  return !!tenantId || isSystemAdmin;
}

async function filterRegisteredProjects(registered: string[], regPath: string): Promise<string[]> {
  let updated = false;
  const filtered = registered.filter(dir => {
    if (isSystemIdeDirectory(dir)) {
      updated = true;
      return false;
    }
    return true;
  });
  if (updated) await fs.promises.writeFile(regPath, JSON.stringify(filtered, null, 2));
  return filtered;
}

async function appendRegisteredProjects(searchDirs: string[]): Promise<void> {
  // Load globally registered projects
  try {
    const homeDir = os.homedir();
    const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");

    let registered: unknown = [];
    try {
      const data = await fs.promises.readFile(regPath, "utf-8");
      registered = JSON.parse(data);
    } catch {
      // Missing or malformed registrations leave the list empty.
      registered = [];
    }

    if (registered) {
      if (Array.isArray(registered)) {
        const filtered = await filterRegisteredProjects(registered, regPath);
        for (const dir of filtered) {
          if (await fileExists(dir)) { // NOSONAR
            searchDirs.push(dir);
          }
        }
      }
    }
  } catch { /* skip */ }
}

async function collectCommonLocalSearchDirs(searchDirs: string[]): Promise<void> {
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

  await appendProjectDirectories(path.join(process.cwd(), "projects"), searchDirs);

}

async function collectLocalSearchDirs(searchDirs: string[]): Promise<void> {
  await collectCommonLocalSearchDirs(searchDirs);
  await appendRegisteredProjects(searchDirs);
}

async function inspectAnalysisProject(dir: string): Promise<AnalysisProject | null> {
  if (!await isProjectDirectoryAsync(dir)) return null;
  try {
    const analysisPath = path.join(dir, ".codeatlas", "analysis.json");
    let modifiedAt: Date;
    try {
      modifiedAt = (await fs.promises.stat(analysisPath)).mtime;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
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
  return null;
}

export async function discoverProjects(tenantId?: string): Promise<{ name: string; dir: string; analysisPath: string; modifiedAt: Date }[]> {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const searchDirs: string[] = [];
  if (process.env.CODEATLAS_MULTI_TENANT === "true") {
    if (!await collectTenantSearchDirs(tenantId, searchDirs)) return [];
  } else {
    await collectLocalSearchDirs(searchDirs);
  }

  const seen = new Set<string>();
  const uniqueDirs = searchDirs.filter(dir => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return !isSystemIdeDirectory(dir);
  });
  const limit = pLimit(FILE_EXISTS_CONCURRENCY);
  const inspected = await Promise.all(uniqueDirs.map(dir => limit(() => inspectAnalysisProject(dir))));
  projects.push(...inspected.filter((project): project is AnalysisProject => project !== null));

  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

type AnalysisProject = { name: string; dir: string; analysisPath: string; modifiedAt: Date };

async function selectAnalysisTarget(projects: AnalysisProject[], projectDir: string | undefined, tenantId: string | undefined): Promise<AnalysisProject | null> {
  let target: AnalysisProject | undefined = projects[0];

  if (projectDir) {
    const absPath = path.resolve(projectDir);
    if (isSystemIdeDirectory(absPath)) {
      logger.warn(`[Auto-Scan] 🛡️ Ignored IDE system/extensions directory from workspace indexing: ${absPath}`);
      return null;
    }
    let match = findAnalysisProject(projects, projectDir, absPath);
    if (match) {
      target = match;
      await registerProjectAsync(target.dir).catch(err => {
        logger.error(`[Auto-Scan] ❌ Failed to register targeted project ${target?.dir}: ${err}`);
      });
    } else if (await fileExists(absPath) && await isProjectDirectoryAsync(absPath)) {
      await registerProjectAsync(absPath).catch(err => {
        logger.error(`[Auto-Scan] ❌ Failed to register explicitly accessed project ${absPath}: ${err}`);
      });
      const reDiscovered = await discoverProjects(tenantId);
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
    await registerProjectAsync(target.dir).catch(err => {
      logger.error(`[Auto-Scan] ❌ Failed to register default fallback project ${target?.dir}: ${err}`);
    });
  }

  return target ?? null;
}

export async function loadAnalysis(projectDir?: string, force = false): Promise<{ analysis: AnalysisResult; projectName: string; projectDir: string } | null> {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;

  const projects = await discoverProjects(tenantId);
  if (projects.length === 0) return null;

  const target = await selectAnalysisTarget(projects, projectDir, tenantId);
  if (!target) return null;

  try {
    if (onProjectLoadedCallback) {
      onProjectLoadedCallback(target.dir);
    }
    let data: string;
    // ⚡ Bolt: Use EAFP pattern to avoid redundant fs.existsSync system call overhead before readFileSync
    try {
      logger.debug(`[Auto-Scan] Attempting to read analysis data for ${target.name} at ${target.analysisPath}`);
      data = await fs.promises.readFile(target.analysisPath, "utf-8");
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        logger.error(`[Auto-Scan] ❌ Dynamic sync scanning is not supported on the server repo. Analysis file missing. Please push analysis from MCP client: ${target.dir}`);
        return null;
      }
      logger.error(`[Auto-Scan] ❌ Unexpected system error while reading analysis file for ${target.dir}: ${err.message || err}`);
      throw err;
    }
    return { analysis: JSON.parse(data), projectName: target.name, projectDir: target.dir };
  } catch (err: any) {
    logger.error(`[Auto-Scan] ❌ Loading analysis failed for ${target?.dir || 'unknown'}: ${err.message || err}`);
    return null;
  }
}

async function appendRegisteredProjectsAsync(searchDirs: string[]): Promise<void> {
  // Load globally registered projects
  try {
    const homeDir = os.homedir();
    const regPath = path.join(homeDir, ".codeatlas", "registered_projects.json");
    if (await fileExists(regPath)) {
      const data = await fs.promises.readFile(regPath, "utf-8");
      const registered = JSON.parse(data);
      if (Array.isArray(registered)) {
        const filtered = await filterRegisteredProjects(registered, regPath);
        // Chunked to avoid EMFILE while reducing sequential I/O latency
        for (let i = 0; i < filtered.length; i += FILE_EXISTS_CONCURRENCY) {
          const chunk = filtered.slice(i, i + FILE_EXISTS_CONCURRENCY);
          const results = await Promise.all( // NOSONAR
            chunk.map((dir) => fileExists(dir).then((ok) => (ok ? dir : null)))
          );
          searchDirs.push(...results.filter((result): result is string => result !== null));
        }
      }
    }
  } catch { /* skip */ }
}

async function collectLocalSearchDirsAsync(searchDirs: string[]): Promise<void> {
  await collectCommonLocalSearchDirs(searchDirs);
  await appendRegisteredProjectsAsync(searchDirs);

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

export async function discoverProjectsAsync(tenantId?: string): Promise<{ name: string; dir: string; analysisPath: string; modifiedAt: Date }[]> {
  const projects: { name: string; dir: string; analysisPath: string; modifiedAt: Date }[] = [];
  const searchDirs: string[] = [];
  if (process.env.CODEATLAS_MULTI_TENANT === "true") {
    if (!await collectTenantSearchDirs(tenantId, searchDirs)) return [];
  } else {
    await collectLocalSearchDirsAsync(searchDirs);
  }

  const seen = new Set<string>();
  const uniqueDirs = searchDirs.filter(dir => {
    if (seen.has(dir) || isSystemIdeDirectory(dir)) return false;
    seen.add(dir);
    return true;
  });

  const chunkSize = FILE_EXISTS_CONCURRENCY; // Batch file system operations to prevent EMFILE
  for (let i = 0; i < uniqueDirs.length; i += chunkSize) {
    const chunk = uniqueDirs.slice(i, i + chunkSize);
    const results = await Promise.all( // NOSONAR
      chunk.map(dir => inspectAnalysisProject(dir))
    );
    for (const res of results) {
      if (res) projects.push(res);
    }
  }

  projects.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return projects;
}

async function selectAnalysisTargetAsync(projects: AnalysisProject[], projectDir: string | undefined, tenantId: string | undefined): Promise<AnalysisProject | null> {
  let target: AnalysisProject | undefined = projects[0];

  if (projectDir) {
    const absPath = path.resolve(projectDir);
    if (isSystemIdeDirectory(absPath)) {
      logger.warn(`[Auto-Scan] 🛡️ Ignored IDE system/extensions directory from workspace indexing: ${absPath}`);
      return null;
    }
    let match = findAnalysisProject(projects, projectDir, absPath);
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

  return target ?? null;
}

export async function loadAnalysisAsync(projectDir?: string, force = false): Promise<{ analysis: AnalysisResult; projectName: string; projectDir: string } | null> {
  const auth = authStorage.getStore();
  const tenantId = auth ? auth.uid : undefined;

  const projects = await discoverProjectsAsync(tenantId);
  if (projects.length === 0) return null;

  const target = await selectAnalysisTargetAsync(projects, projectDir, tenantId);
  if (!target) return null;

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
           normalizeProjectPath(path.relative(process.cwd(), p.dir)) === normalizeProjectPath(projectDir) ||
           (!requireExactPath && p.name.toLowerCase() === projectDir.toLowerCase())
  );
  if (!match) return null;
  return {
    cleanProjectName: match.name,
    fullProjectDir: match.dir
  };
}

