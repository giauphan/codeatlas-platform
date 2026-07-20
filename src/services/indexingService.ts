import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "../utils/logger.js";

// Types matching the parser output
export interface GraphNode {
  id: string;
  label: string;
  type: 'module' | 'function' | 'class' | 'variable';
  val?: number;
  color?: string;
  filePath?: string;
  line?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: 'import' | 'call' | 'contains' | 'implements';
  label?: string;
}

export interface AnalysisResult {
  graph: { nodes: GraphNode[]; links: GraphLink[] };
  insights: { id: string; type: string; title: string; description: string; severity: string; affectedNodes: string[] }[];
  entityCounts: { modules: number; functions: number; classes: number; variables: number; dependencies: number; circularDeps: number; deadCode: number };
  totalFilesAnalyzed: number;
  totalFilesSkipped: number;
}

export class IndexingService {
  private projectDirs: string[] = [];
  private isIndexing = false;

  constructor() {}

  /**
   * Initialize: load project list from env
   */
  async init(projectDirs?: string[]): Promise<void> {
    if (projectDirs) {
      this.projectDirs = projectDirs;
    }

    // Fallback: read from CODEATLAS_PROJECT_DIRS env var (comma-separated)
    if (this.projectDirs.length === 0 && process.env.CODEATLAS_PROJECT_DIRS) {
      this.projectDirs = process.env.CODEATLAS_PROJECT_DIRS.split(",").map(s => s.trim());
    }

    // Auto-discover git repos in home directory
    if (this.projectDirs.length === 0) {
      const home = os.homedir();
      const files = fs.readdirSync(home, { withFileTypes: true });
      this.projectDirs = files
        .filter(f => f.isDirectory() && fs.existsSync(path.join(home, f.name, '.git')))
        .map(f => path.join(home, f.name));
      logger.info(`[IndexingService] Discovered ${this.projectDirs.length} git projects in ${home}`);
    }

    logger.info(`[IndexingService] Initialized with ${this.projectDirs.length} projects`);
  }

  /**
   * Index all configured projects
   */
  async indexAll(): Promise<void> {
    if (this.isIndexing) {
      logger.warn("[IndexingService] Already indexing, skipping...");
      return;
    }

    this.isIndexing = true;
    let succeeded = 0;
    let failed = 0;

    logger.info(`[IndexingService] Starting index for ${this.projectDirs.length} projects...`);

    for (const dir of this.projectDirs) {
      try {
        const success = await this.indexProject(dir);
        if (success) succeeded++;
        else failed++;
      } catch (err) {
        logger.error(`[IndexingService] Error indexing ${dir}: ${err}`);
        failed++;
      }
    }

    this.isIndexing = false;
    logger.info(`[IndexingService] Index complete: ${succeeded} succeeded, ${failed} failed`);
  }

  /**
   * Analyze a single project and write .codeatlas/analysis.json
   */
  async indexProject(projectPath: string): Promise<boolean> {
    const absPath = path.resolve(projectPath);
    if (!fs.existsSync(absPath)) {
      logger.warn(`[IndexingService] Project path does not exist: ${absPath}`);
      return false;
    }

    const codeatlasDir = path.join(absPath, ".codeatlas");
    if (!fs.existsSync(codeatlasDir)) {
      fs.mkdirSync(codeatlasDir, { recursive: true });
    }

    const analysisPath = path.join(codeatlasDir, "analysis.json");
    const projectName = path.basename(absPath);

    try {
      const result = await this.analyzeProjectCode(projectName, absPath);

      fs.writeFileSync(analysisPath, JSON.stringify(result, null, 2));
      logger.info(`[IndexingService] ✅ Indexed ${projectName}: ${result.totalFilesAnalyzed} files, ${result.graph.nodes.length} nodes, ${result.graph.links.length} links`);
      return true;
    } catch (err) {
      logger.error(`[IndexingService] ❌ Failed to index ${projectName}: ${err}`);
      return false;
    }
  }

  private async analyzeProjectCode(projectName: string, projectPath: string): Promise<AnalysisResult> {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    let totalFilesAnalyzed = 0;
    let totalFilesSkipped = 0;

    const files = this.scanFiles(projectPath);

    for (const filePath of files) {
      const relPath = path.relative(projectPath, filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const ext = path.extname(filePath).toLowerCase();

        const moduleId = `module:${relPath}`;
        nodes.push({
          id: moduleId,
          label: relPath,
          type: "module",
          filePath: relPath,
          val: 1,
          color: this.getColorForExt(ext),
        });

        if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
          this.parseTSJS(content, relPath, moduleId, nodes, links);
        } else if (ext === ".py") {
          this.parsePython(content, relPath, moduleId, nodes, links);
        } else if (ext === ".go") {
          this.parseGo(content, relPath, moduleId, nodes, links);
        } else if (ext === ".php" || ext === ".phtml" || ext === ".ctp") {
          this.parsePHP(content, relPath, moduleId, nodes, links);
        }

        totalFilesAnalyzed++;
      } catch {
        totalFilesSkipped++;
      }
    }

    const funcCount = nodes.filter(n => n.type === "function").length;
    const classCount = nodes.filter(n => n.type === "class").length;
    const varCount = nodes.filter(n => n.type === "variable").length;
    const depCount = links.filter(l => l.type === "import" || l.type === "call").length;
    const circularDeps = this.detectCircularDeps(nodes, links);

    return {
      graph: { nodes, links },
      insights: [],
      entityCounts: {
        modules: nodes.filter(n => n.type === "module").length,
        functions: funcCount,
        classes: classCount,
        variables: varCount,
        dependencies: depCount,
        circularDeps,
        deadCode: 0,
      },
      totalFilesAnalyzed,
      totalFilesSkipped,
    };
  }

  private scanFiles(rootDir: string): string[] {
    const files: string[] = [];
    const excluded = ["node_modules", ".git", "dist", "out", "build", "__pycache__", ".codeatlas", ".cache", "venv", ".venv"];

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (excluded.includes(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(fullPath);
          else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".php", ".phtml", ".ctp", ".rs", ".java", ".rb", ".swift", ".kt"].includes(ext)) {
              const stat = fs.statSync(fullPath);
              if (stat.size > 0 && stat.size < 500000) files.push(fullPath);
            }
          }
        }
      } catch { /* permission denied */ }
    };
    walk(rootDir);
    return files;
  }

  private parseTSJS(code: string, relPath: string, moduleId: string, nodes: GraphNode[], links: GraphLink[]) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const importMatch = line.match(/import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']|from\s+["']([^"']+)["']/);
      if (importMatch) {
        const target = importMatch[1] || importMatch[2];
        if (target.startsWith(".") || target.startsWith("/")) {
          links.push({ source: moduleId, target: `module:${this.resolveImportPath(relPath, target)}`, type: "import" });
        }
      }
      const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        const classId = `class:${moduleId}:${classMatch[1]}`;
        nodes.push({ id: classId, label: classMatch[1], type: "class", filePath: relPath, line: lineNum, color: "#ffb74d" });
        links.push({ source: moduleId, target: classId, type: "contains" });
      }
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (funcMatch) {
        const funcId = `function:${moduleId}:${funcMatch[1]}`;
        nodes.push({ id: funcId, label: funcMatch[1], type: "function", filePath: relPath, line: lineNum, color: "#81c784" });
        links.push({ source: moduleId, target: funcId, type: "contains" });
      }
      const callMatch = line.match(/(\w+)\(/g);
      if (callMatch) {
        for (const call of callMatch) {
          const callName = call.slice(0, -1);
          if (["if", "while", "for", "switch", "catch", "then", "return", "throw", "console", "typeof"].includes(callName)) continue;
          links.push({ source: moduleId, target: `function:module:${relPath}:${callName}`, type: "call" });
        }
      }
    }
  }

  private parsePython(code: string, relPath: string, moduleId: string, nodes: GraphNode[], links: GraphLink[]) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const importMatch = line.match(/(?:from\s+(\S+)\s+)?import\s+(.+)/);
      if (importMatch) {
        const target = importMatch[1] || importMatch[2].split(",")[0].trim();
        if (target.startsWith(".")) links.push({ source: moduleId, target: `module:${this.resolveImportPath(relPath, target.replace(/\./g, "/"))}`, type: "import" });
      }
      const classMatch = line.match(/^\s*class\s+(\w+)/);
      if (classMatch) {
        const classId = `class:${moduleId}:${classMatch[1]}`;
        nodes.push({ id: classId, label: classMatch[1], type: "class", filePath: relPath, line: lineNum, color: "#ffb74d" });
        links.push({ source: moduleId, target: classId, type: "contains" });
      }
      const defMatch = line.match(/^\s*def\s+(\w+)\s*\(/);
      if (defMatch && defMatch[1] !== "__init__") {
        const funcId = `function:${moduleId}:${defMatch[1]}`;
        nodes.push({ id: funcId, label: defMatch[1], type: "function", filePath: relPath, line: lineNum, color: "#81c784" });
        links.push({ source: moduleId, target: funcId, type: "contains" });
      }
    }
  }

  private parseGo(code: string, relPath: string, moduleId: string, nodes: GraphNode[], links: GraphLink[]) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const funcMatch = line.match(/^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
      if (funcMatch && funcMatch[1][0] >= 'A' && funcMatch[1][0] <= 'Z') {
        const funcId = `function:${moduleId}:${funcMatch[1]}`;
        nodes.push({ id: funcId, label: funcMatch[1], type: "function", filePath: relPath, line: lineNum, color: "#81c784" });
        links.push({ source: moduleId, target: funcId, type: "contains" });
      }
      const structMatch = line.match(/^\s*type\s+(\w+)\s+struct/);
      if (structMatch) {
        const classId = `class:${moduleId}:${structMatch[1]}`;
        nodes.push({ id: classId, label: structMatch[1], type: "class", filePath: relPath, line: lineNum, color: "#ffb74d" });
        links.push({ source: moduleId, target: classId, type: "contains" });
      }
    }
  }

  private parsePHP(code: string, relPath: string, moduleId: string, nodes: GraphNode[], links: GraphLink[]) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const classMatch = line.match(/^\s*(?:abstract\s+)?class\s+(\w+)/i);
      if (classMatch) {
        const classId = `class:${moduleId}:${classMatch[1]}`;
        nodes.push({ id: classId, label: classMatch[1], type: "class", filePath: relPath, line: lineNum, color: "#ffb74d" });
        links.push({ source: moduleId, target: classId, type: "contains" });
      }
      const funcMatch = line.match(/^\s*(?:public|private|protected|static)?\s*function\s+(\w+)\s*\(/i);
      if (funcMatch) {
        const funcId = `function:${moduleId}:${funcMatch[1]}`;
        nodes.push({ id: funcId, label: funcMatch[1], type: "function", filePath: relPath, line: lineNum, color: "#81c784" });
        links.push({ source: moduleId, target: funcId, type: "contains" });
      }
    }
  }

  private getColorForExt(ext: string): string {
    const colors: Record<string, string> = {
      ".ts": "#3178c6", ".tsx": "#3178c6",
      ".js": "#f7df1e", ".jsx": "#f7df1e",
      ".py": "#3776ab", ".go": "#00add8",
      ".php": "#777bb4", ".rs": "#dea584",
      ".java": "#b07219", ".rb": "#cc342d",
      ".swift": "#f05138", ".kt": "#7f52ff",
    };
    return colors[ext] || "#94a3b8";
  }

  private resolveImportPath(currentFile: string, importTarget: string): string {
    if (importTarget.startsWith(".")) {
      const dir = path.dirname(currentFile);
      const resolved = path.resolve("/", dir, importTarget);
      return resolved.slice(1) + ".ts";
    }
    return importTarget.replace(/[\/.]/g, "_") + ".ts";
  }

  private detectCircularDeps(nodes: GraphNode[], links: GraphLink[]): number {
    const adj = new Map<string, string[]>();
    for (const link of links) {
      if (link.type === "import") {
        if (!adj.has(link.source)) adj.set(link.source, []);
        adj.get(link.source)!.push(link.target);
      }
    }
    let circular = 0;
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const dfs = (node: string) => {
      visited.add(node);
      recStack.add(node);
      for (const neighbor of adj.get(node) || []) {
        if (!visited.has(neighbor)) { dfs(neighbor); }
        else if (recStack.has(neighbor)) circular++;
      }
      recStack.delete(node);
    };
    for (const node of adj.keys()) if (!visited.has(node)) dfs(node);
    return circular;
  }
}

export const indexingService = new IndexingService();
