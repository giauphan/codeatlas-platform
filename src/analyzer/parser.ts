import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@typescript-eslint/typescript-estree';
import { GraphData, GraphNode, GraphLink, AnalysisResult, AIInsight, AnalysisManifest, FolderInfo, ChunkData, CrossChunkLinks } from './types';
import { PythonParser } from './pythonParser';
import { PhpParser } from './phpParser';

export class CodeAnalyzer {
  private workspaceRoot: string;
  private nodes: Map<string, GraphNode> = new Map();
  private links: GraphLink[] = [];
  private readonly maxFiles: number;
  private readonly excludedDirectories: string[];
  private readonly excludedFiles: string[];
  private readonly fileExtensions: string[];

  constructor(
    workspaceRoot: string,
    maxFiles: number = 5000,
    excludedDirectories: string[] = ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'venv', 'env', '.env', 'vendor', 'build', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.next', '.nuxt'],
    fileExtensions: string[] = ['.ts', '.tsx', '.js', '.jsx', '.py', '.php'],
    excludedFiles: string[] = ['_ide_helper.php', '_ide_helper_models.php', '.phpstorm.meta.php']
  ) {
    this.workspaceRoot = workspaceRoot;
    this.maxFiles = maxFiles;
    this.excludedDirectories = excludedDirectories;
    this.excludedFiles = excludedFiles;
    this.fileExtensions = fileExtensions;
  }

  public async analyzeProject(): Promise<AnalysisResult> {
    this.nodes.clear();
    this.links = [];

    let files = this.getFiles(this.workspaceRoot);
    if (files.length > this.maxFiles) {
      console.warn(`[CodeAnalyzer] Workspace has ${files.length} files, which exceeds maxFiles (${this.maxFiles}). Truncating to ${this.maxFiles} files.`);
      files = files.slice(0, this.maxFiles);
    }
    
    let totalSkipped = 0;
    for (const file of files) {
      const success = this.analyzeFile(file);
      if (!success) {
        totalSkipped++;
      }
    }

    // Add graph layout sizes based on relationships
    this.nodes.forEach(node => {
      let degree = this.links.filter(l => l.source === node.id || l.target === node.id).length;
      node.val = (node.type === 'module' ? 8 : (node.type === 'class' ? 6 : 4)) + Math.log1p(degree) * 2;
    });

    // Only keep links where both source and target nodes exist
    const validLinks = this.links.filter(
      link => this.nodes.has(link.source) && this.nodes.has(link.target)
    );

    const graph: GraphData = {
      nodes: Array.from(this.nodes.values()),
      links: validLinks
    };

    const insights = this.generateAIInsights(graph);

    const circularDepsCount = this.detectCircularDeps();

    const counts = {
      modules: Array.from(this.nodes.values()).filter(n => n.type === 'module').length,
      functions: Array.from(this.nodes.values()).filter(n => n.type === 'function').length,
      classes: Array.from(this.nodes.values()).filter(n => n.type === 'class').length,
      dependencies: this.links.filter(l => l.type === 'import').length,
      circularDeps: circularDepsCount
    };

    return {
      graph,
      insights,
      entityCounts: counts,
      totalFilesAnalyzed: files.length - totalSkipped,
      totalFilesSkipped: totalSkipped
    };
  }

  /**
   * Builds chunked analysis data grouped by folder.
   * Call this after analyzeProject() to get folder-based chunks.
   */
  public buildChunkedResult(result: AnalysisResult): {
    manifest: AnalysisManifest;
    chunks: Map<string, ChunkData>;
    crossChunkLinks: CrossChunkLinks;
  } {
    // Group nodes by their parent folder
    const folderNodeMap = new Map<string, GraphNode[]>();

    for (const node of result.graph.nodes) {
      let folder = '.'; // root
      if (node.filePath) {
        const rel = path.relative(this.workspaceRoot, node.filePath);
        folder = path.dirname(rel).replace(/\\/g, '/');
      } else if (node.id.startsWith('module:')) {
        const rel = node.id.replace('module:', '');
        folder = path.dirname(rel).replace(/\\/g, '/');
      } else if (node.id.startsWith('external:')) {
        folder = '__external__';
      } else {
        // Extract folder from node id (e.g. "class:module:src/foo.ts:MyClass")
        const parts = node.id.split(':');
        if (parts.length >= 3 && parts[1] === 'module') {
          // Reconstruct the path from parts[2] (e.g. "src/foo.ts")
          folder = path.dirname(parts[2]).replace(/\\/g, '/');
        } else if (parts.length >= 2) {
          const moduleRef = parts.slice(1, -1).join(':').replace(/^module:/, '');
          if (moduleRef) {
            folder = path.dirname(moduleRef).replace(/\\/g, '/');
          }
        }
      }

      if (!folderNodeMap.has(folder)) {
        folderNodeMap.set(folder, []);
      }
      folderNodeMap.get(folder)!.push(node);
    }

    // Build chunks and separate cross-chunk links
    const chunks = new Map<string, ChunkData>();
    const nodeToFolder = new Map<string, string>();
    const crossLinks: GraphLink[] = [];

    // Map each node to its folder
    for (const [folder, nodes] of folderNodeMap) {
      for (const node of nodes) {
        nodeToFolder.set(node.id, folder);
      }
    }

    // Create chunks with internal links
    for (const [folder, nodes] of folderNodeMap) {
      const nodeIds = new Set(nodes.map(n => n.id));
      const internalLinks = result.graph.links.filter(
        link => nodeIds.has(link.source) && nodeIds.has(link.target)
      );
      chunks.set(folder, {
        folderPath: folder,
        nodes,
        links: internalLinks
      });
    }

    // Collect cross-chunk links
    for (const link of result.graph.links) {
      const srcFolder = nodeToFolder.get(link.source);
      const tgtFolder = nodeToFolder.get(link.target);
      if (srcFolder && tgtFolder && srcFolder !== tgtFolder) {
        crossLinks.push(link);
      }
    }

    // Build folder info for manifest
    const folders: FolderInfo[] = [];
    for (const [folder, chunk] of chunks) {
      const types: Record<string, number> = {};
      for (const node of chunk.nodes) {
        types[node.type] = (types[node.type] || 0) + 1;
      }
      folders.push({
        path: folder,
        nodeCount: chunk.nodes.length,
        linkCount: chunk.links.length,
        types
      });
    }
    // Sort folders by node count descending for prioritized loading
    folders.sort((a, b) => b.nodeCount - a.nodeCount);

    const manifest: AnalysisManifest = {
      totalNodes: result.graph.nodes.length,
      totalLinks: result.graph.links.length,
      totalFiles: result.totalFilesAnalyzed + result.totalFilesSkipped,
      totalFilesSkipped: result.totalFilesSkipped,
      folders,
      insights: result.insights,
      entityCounts: result.entityCounts
    };

    return { manifest, chunks, crossChunkLinks: { links: crossLinks } };
  }

  /**
   * Returns the first N nodes for initial loading, picking from folders in order.
   */
  public getInitialLoadData(
    result: AnalysisResult,
    manifest: AnalysisManifest,
    chunks: Map<string, ChunkData>,
    crossChunkLinks: CrossChunkLinks,
    nodeLimit: number
  ): { graph: GraphData; loadedFolders: string[] } {
    if (nodeLimit <= 0 || nodeLimit >= result.graph.nodes.length) {
      // Load everything
      return {
        graph: result.graph,
        loadedFolders: manifest.folders.map(f => f.path)
      };
    }

    const loadedNodes: GraphNode[] = [];
    const loadedFolders: string[] = [];
    let remaining = nodeLimit;

    // Load folders by priority (sorted by nodeCount descending — most important first)
    // Actually, for better UX, sort by path alphabetically so root folders load first
    const sortedFolders = [...manifest.folders].sort((a, b) => {
      // Root folder first, then by depth, then alphabetically
      if (a.path === '.') return -1;
      if (b.path === '.') return 1;
      const depthA = a.path.split('/').length;
      const depthB = b.path.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.path.localeCompare(b.path);
    });

    for (const folderInfo of sortedFolders) {
      if (remaining <= 0) break;
      const chunk = chunks.get(folderInfo.path);
      if (!chunk) continue;

      if (chunk.nodes.length <= remaining) {
        loadedNodes.push(...chunk.nodes);
        loadedFolders.push(folderInfo.path);
        remaining -= chunk.nodes.length;
      } else {
        // Partial load: take module nodes first, then classes, then functions, then variables
        const priorityOrder = ['module', 'class', 'function', 'variable'];
        const sorted = [...chunk.nodes].sort((a, b) => {
          const indexA = priorityOrder.indexOf(a.type);
          const indexB = priorityOrder.indexOf(b.type);
          // Unknown types go to the end
          const priorityA = indexA === -1 ? priorityOrder.length : indexA;
          const priorityB = indexB === -1 ? priorityOrder.length : indexB;
          return priorityA - priorityB;
        });
        loadedNodes.push(...sorted.slice(0, remaining));
        loadedFolders.push(folderInfo.path);
        remaining = 0;
      }
    }

    // Filter links to only include those where both endpoints are loaded
    const loadedNodeIds = new Set(loadedNodes.map(n => n.id));
    const loadedLinks = result.graph.links.filter(
      link => loadedNodeIds.has(link.source) && loadedNodeIds.has(link.target)
    );

    return {
      graph: { nodes: loadedNodes, links: loadedLinks },
      loadedFolders
    };
  }

  /**
   * Detects circular dependencies among modules.
   * Builds a directed graph of module imports and runs DFS cycle detection.
   * @returns {number} The total number of back-edges (cycles) found.
   */
  private detectCircularDeps(): number {
    const adjList = new Map<string, string[]>();
    
    // Build adjacency list for module-to-module imports
    for (const link of this.links) {
      if (link.type === 'import' && link.source.startsWith('module:') && link.target.startsWith('module:')) {
        if (!adjList.has(link.source)) {
          adjList.set(link.source, []);
        }
        adjList.get(link.source)!.push(link.target);
      }
    }

    let cycles = 0;
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string) => {
      visited.add(node);
      recStack.add(node);

      const neighbors = adjList.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          cycles++;
        }
      }

      recStack.delete(node);
    };

    for (const node of adjList.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  private getFiles(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir)) return fileList;
    
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      // Skip excluded directories and hidden directories
      if (this.excludedDirectories.includes(file) || file.startsWith('.')) {
        continue;
      }
      
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        this.getFiles(filePath, fileList);
      } else if (this.fileExtensions.some(ext => file.endsWith(ext))) {
        // Skip excluded files
        if (this.excludedFiles.includes(file)) {
          continue;
        }
        fileList.push(filePath);
      }
    }
    
    return fileList;
  }

  private analyzeFile(filePath: string): boolean {
    let moduleId = '';
    try {
      const code = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(this.workspaceRoot, filePath);
      // Normalize to use forward slashes for matching
      const normalizedRelativePath = relativePath.replace(/\\/g, '/');
      moduleId = `module:${normalizedRelativePath}`;

      const isPython = filePath.endsWith('.py');
      const isPhp = filePath.endsWith('.php') && !filePath.endsWith('.blade.php');
      const isBlade = filePath.endsWith('.blade.php');

      // Set color based on file type
      let moduleColor = '#4cc9f0'; // TS/JS default
      if (isPython) moduleColor = '#3572A5';
      else if (isPhp) moduleColor = '#4F5D95';
      else if (isBlade) moduleColor = '#FF2D20';

      this.addNode({
        id: moduleId,
        label: path.basename(filePath),
        type: 'module',
        color: moduleColor,
        filePath: filePath,
        line: 1
      });

      if (isPython) {
        this.analyzePythonFile(code, moduleId, filePath);
      } else if (isPhp) {
        this.analyzePhpFile(code, moduleId, filePath);
      } else if (isBlade) {
        this.analyzeBladeFile(code, moduleId, filePath);
      } else {
        const ast = parse(code, {
          loc: true,
          range: true,
          jsx: true
        });

        // Keep track of imports in this file to resolve calls
        const fileImports = new Map<string, string>(); // alias/name -> moduleId

        this.traverseAST(ast, moduleId, filePath, moduleId, fileImports);
      }
      return true;
    } catch (e) {
      console.warn(`Failed to parse file: ${filePath}`, e);
      // Clean up the node if it was added
      if (moduleId && this.nodes.has(moduleId)) {
        this.nodes.delete(moduleId);
      }
      return false;
    }
  }

  /**
   * Parses Python files using the PythonParser.
   */
  private analyzePythonFile(code: string, moduleId: string, filePath: string) {
    const pythonParser = new PythonParser();
    const result = pythonParser.parseFile(filePath, code);

    for (const cls of result.classes) {
      const classId = `class:${moduleId}:${cls.name}`;
      this.addNode({
        id: classId,
        label: cls.name,
        type: 'class',
        color: '#f8961e',
        filePath: filePath,
        line: cls.line
      });
      this.addLink({
        source: moduleId,
        target: classId,
        type: 'contains'
      });

      for (const parent of cls.parents) {
        const parentId = `class:${moduleId}:${parent}`;
        this.addLink({
          source: classId,
          target: parentId,
          type: 'import'
        });
      }
    }

    for (const func of result.functions) {
      const funcId = `function:${moduleId}:${func.name}`;
      this.addNode({
        id: funcId,
        label: func.name,
        type: 'function',
        color: '#f72585',
        filePath: filePath,
        line: func.line
      });

      let linkSourceId = moduleId;
      if (func.indent && func.indent > 0) {
        // Find the most recent class defined before this function
        const parentClass = [...result.classes]
          .reverse()
          .find(cls => cls.line < func.line);
        if (parentClass) {
          linkSourceId = `class:${moduleId}:${parentClass.name}`;
        }
      }

      this.addLink({
        source: linkSourceId,
        target: funcId,
        type: 'contains'
      });
    }

    for (const variable of result.variables) {
      const varId = `variable:${moduleId}:${variable.name}`;
      this.addNode({
        id: varId,
        label: variable.name,
        type: 'variable',
        color: '#00ff88',
        filePath: filePath,
        line: variable.line
      });
      this.addLink({
        source: moduleId,
        target: varId,
        type: 'contains'
      });
    }

    for (const imp of result.imports) {
      const importSourceId = `external:${imp.source || imp.names[0]}`;
      this.addLink({
        source: moduleId,
        target: importSourceId,
        type: 'import'
      });

      if (!this.nodes.has(importSourceId)) {
        this.addNode({
          id: importSourceId,
          label: imp.source || imp.names[0],
          type: 'module',
          color: '#7209b7'
        });
      }
    }

    // Build a simple scope tracker from functions list
    const sortedFunctions = [...result.functions].sort((a, b) => a.line - b.line);
    for (const call of result.calls) {
      // Find which function this call is inside
      let enclosingScope = moduleId;
      for (let fi = sortedFunctions.length - 1; fi >= 0; fi--) {
        if (sortedFunctions[fi].line <= call.line) {
          enclosingScope = `function:${moduleId}:${sortedFunctions[fi].name}`;
          break;
        }
      }
      const targetId = `function:${moduleId}:${call.name}`;
      // Don't add self-referencing calls
      if (enclosingScope !== targetId) {
        this.addLink({
          source: enclosingScope,
          target: targetId,
          type: 'call'
        });
      }
    }
  }

  /**
   * Parses PHP files using the PhpParser.
   */
  private analyzePhpFile(code: string, moduleId: string, filePath: string) {
    const phpParser = new PhpParser();
    const result = phpParser.parseFile(filePath, code);

    // Classes, Interfaces, Traits, Enums
    for (const cls of result.classes) {
      const nodeType = cls.type === 'interface' ? 'class' : cls.type === 'trait' ? 'class' : 'class';
      const classId = `class:${moduleId}:${cls.name}`;
      const colorMap: Record<string, string> = {
        class: '#f8961e',
        interface: '#7209b7',
        trait: '#06d6a0',
        enum: '#ffd166'
      };
      this.addNode({
        id: classId,
        label: `${cls.name}`,
        type: nodeType,
        color: colorMap[cls.type] || '#f8961e',
        filePath: filePath,
        line: cls.line
      });
      this.addLink({ source: moduleId, target: classId, type: 'contains' });

      // Extends
      for (const parent of cls.parents) {
        const parentId = `class:external:${parent}`;
        if (!this.nodes.has(parentId)) {
          this.addNode({ id: parentId, label: parent, type: 'class', color: '#f8961e' });
        }
        this.addLink({ source: classId, target: parentId, type: 'import' });
      }

      // Implements
      for (const iface of cls.implements) {
        const ifaceId = `class:external:${iface}`;
        if (!this.nodes.has(ifaceId)) {
          this.addNode({ id: ifaceId, label: iface, type: 'class', color: '#7209b7' });
        }
        this.addLink({ source: classId, target: ifaceId, type: 'import' });
      }
    }

    // Functions
    for (const func of result.functions) {
      const funcId = `function:${moduleId}:${func.name}`;
      this.addNode({
        id: funcId,
        label: func.name,
        type: 'function',
        color: '#f72585',
        filePath: filePath,
        line: func.line
      });
      this.addLink({ source: moduleId, target: funcId, type: 'contains' });
    }

    // Variables (properties, constants)
    for (const variable of result.variables) {
      const varId = `variable:${moduleId}:${variable.name}`;
      this.addNode({
        id: varId,
        label: variable.name,
        type: 'variable',
        color: '#00ff88',
        filePath: filePath,
        line: variable.line
      });
      this.addLink({ source: moduleId, target: varId, type: 'contains' });
    }

    // Use statements (imports)
    for (const imp of result.imports) {
      const importSourceId = `external:${imp.alias}`;
      this.addLink({ source: moduleId, target: importSourceId, type: 'import' });

      if (!this.nodes.has(importSourceId)) {
        this.addNode({
          id: importSourceId,
          label: imp.alias,
          type: 'module',
          color: '#7209b7'
        });
      }
    }

    // Method calls — only link to functions already discovered in the graph
    for (const call of result.calls) {
      // Search all known function nodes to find a match
      const possibleTargets = Array.from(this.nodes.keys()).filter(
        id => id.startsWith('function:') && id.endsWith(`:${call.name}`)
      );
      if (possibleTargets.length > 0) {
        this.addLink({ source: moduleId, target: possibleTargets[0], type: 'call' });
      }
    }
  }

  /**
   * Parses Blade template files to extract template relationships.
   */
  private analyzeBladeFile(code: string, moduleId: string, filePath: string) {
    const phpParser = new PhpParser();
    const result = phpParser.parseBladeFile(filePath, code);

    // @extends creates a dependency link
    for (const ext of result.extends) {
      const targetId = `blade:${ext.replace(/\./g, '/')}`;
      if (!this.nodes.has(targetId)) {
        this.addNode({ id: targetId, label: ext, type: 'module', color: '#FF2D20' });
      }
      this.addLink({ source: moduleId, target: targetId, type: 'import' });
    }

    // @include creates a dependency link
    for (const inc of result.includes) {
      const targetId = `blade:${inc.replace(/\./g, '/')}`;
      if (!this.nodes.has(targetId)) {
        this.addNode({ id: targetId, label: inc, type: 'module', color: '#FF2D20' });
      }
      this.addLink({ source: moduleId, target: targetId, type: 'import' });
    }

    // @component / <x-component>
    for (const comp of result.components) {
      const targetId = `component:${comp}`;
      if (!this.nodes.has(targetId)) {
        this.addNode({ id: targetId, label: comp, type: 'class', color: '#f8961e' });
      }
      this.addLink({ source: moduleId, target: targetId, type: 'import' });
    }
  }

  /**
   * Traverses the AST recursively to extract modules, functions, classes, and variables.
   * Also detects function calls and updates links.
   */
  private traverseAST(
    node: any, 
    currentModuleId: string, 
    filePath: string, 
    currentScopeId: string,
    fileImports: Map<string, string>
  ) {
    if (!node) return;

    if (Array.isArray(node)) {
      node.forEach(child => this.traverseAST(child, currentModuleId, filePath, currentScopeId, fileImports));
      return;
    }

    let nextScopeId = currentScopeId;

    if (node.type === 'ImportDeclaration') {
      const importPath = node.source?.value;
      if (typeof importPath === 'string') {
        const targetModuleId = this.resolveImportPath(importPath, filePath);
        this.addLink({
          source: currentModuleId,
          target: targetModuleId,
          type: 'import'
        });
        
        if (node.specifiers) {
          for (const specifier of node.specifiers) {
            if (specifier.local?.name) {
              fileImports.set(specifier.local.name, targetModuleId);
            }
          }
        }
        
        // Ensure target module node exists (even if it's an external module for now)
        if (!this.nodes.has(targetModuleId)) {
          this.addNode({
            id: targetModuleId,
            label: importPath.split('/').pop() || importPath,
            type: 'module',
            color: '#7209b7' // external module color
          });
        }
      }
    }

    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      const funcId = `function:${currentModuleId}:${node.id.name}`;
      this.addNode({
        id: funcId,
        label: node.id.name,
        type: 'function',
        color: '#f72585',
        filePath: filePath,
        line: node.loc?.start?.line
      });
      this.addLink({
        source: currentScopeId,
        target: funcId,
        type: 'contains'
      });
      nextScopeId = funcId;
    }
    
    if (node.type === 'ClassDeclaration' && node.id?.name) {
      const classId = `class:${currentModuleId}:${node.id.name}`;
      this.addNode({
        id: classId,
        label: node.id.name,
        type: 'class',
        color: '#f8961e',
        filePath: filePath,
        line: node.loc?.start?.line
      });
      this.addLink({
        source: currentScopeId,
        target: classId,
        type: 'contains'
      });
      nextScopeId = classId;
    }

    if (node.type === 'MethodDefinition' && node.key?.name) {
      const methodId = `function:${currentModuleId}:${node.key.name}`;
      this.addNode({
        id: methodId,
        label: node.key.name,
        type: 'function',
        color: '#f72585',
        filePath: filePath,
        line: node.loc?.start?.line
      });
      this.addLink({
        source: currentScopeId,
        target: methodId,
        type: 'contains'
      });
      nextScopeId = methodId;
    }

    if (node.type === 'VariableDeclarator' && node.id?.name) {
      const varName = node.id.name;
      
      if (node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
        const funcId = `function:${currentModuleId}:${varName}`;
        this.addNode({
          id: funcId,
          label: varName,
          type: 'function',
          color: '#f72585',
          filePath: filePath,
          line: node.loc?.start?.line
        });
        this.addLink({
          source: currentScopeId,
          target: funcId,
          type: 'contains'
        });
        nextScopeId = funcId;
      } else if (currentScopeId === currentModuleId) {
        // Top-level variable
        const varId = `variable:${currentModuleId}:${varName}`;
        this.addNode({
          id: varId,
          label: varName,
          type: 'variable',
          color: '#00ff88', // Green for variables
          filePath: filePath,
          line: node.loc?.start?.line
        });
        this.addLink({
          source: currentScopeId,
          target: varId,
          type: 'contains'
        });
      }
    }

    if (node.type === 'CallExpression') {
      let calleeName = '';
      let objectName = '';
      if (node.callee.type === 'Identifier') {
        calleeName = node.callee.name;
      } else if (node.callee.type === 'MemberExpression' && node.callee.property?.name) {
        calleeName = node.callee.property.name;
        if (node.callee.object?.name) {
          objectName = node.callee.object.name;
        }
      }

      if (calleeName) {
        let targetId = '';
        if (objectName && fileImports.has(objectName)) {
          // It's a method call on an imported namespace/object
          const targetModule = fileImports.get(objectName);
          targetId = `function:${targetModule}:${calleeName}`;
        } else if (fileImports.has(calleeName)) {
          // It's a direct call to an imported function
          const targetModule = fileImports.get(calleeName);
          targetId = `function:${targetModule}:${calleeName}`;
        } else {
          // It's a local call
          targetId = `function:${currentModuleId}:${calleeName}`;
        }
        
        this.addLink({
          source: currentScopeId,
          target: targetId,
          type: 'call'
        });
      }
    }

    Object.keys(node).forEach(key => {
      if (key !== 'loc' && key !== 'range' && typeof node[key] === 'object') {
        this.traverseAST(node[key], currentModuleId, filePath, nextScopeId, fileImports);
      }
    });
  }

  /**
   * Resolves the actual module path checking for index files and standard file extensions.
   */
  private resolveImportPath(importPath: string, currentFilePath: string): string {
    if (importPath.startsWith('.')) {
      try {
        let absolutePath = path.resolve(path.dirname(currentFilePath), importPath);
        
        let foundPath = absolutePath;
        const extensions = this.fileExtensions;
        let matched = false;

        if (fs.existsSync(absolutePath)) {
          const stat = fs.statSync(absolutePath);
          if (stat.isDirectory()) {
            for (const ext of extensions) {
              const indexPath = path.join(absolutePath, `index${ext}`);
              if (fs.existsSync(indexPath)) {
                foundPath = indexPath;
                matched = true;
                break;
              }
            }
          } else {
            matched = true;
          }
        }

        if (!matched) {
          for (const ext of extensions) {
            const extPath = `${absolutePath}${ext}`;
            if (fs.existsSync(extPath)) {
              foundPath = extPath;
              matched = true;
              break;
            }
          }
        }
        
        const relativeToWorkspace = path.relative(this.workspaceRoot, foundPath);
        // Normalize slashes
        return `module:${relativeToWorkspace.replace(/\\/g, '/')}`;
      } catch {
        return `external:${importPath}`;
      }
    }
    return `external:${importPath}`;
  }

  private addNode(node: GraphNode) {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  private addLink(link: GraphLink) {
    this.links.push(link);
  }

  private generateAIInsights(graph: GraphData): AIInsight[] {
    const insights: AIInsight[] = [];
    
    // Mock AI Insights generation based on simple heuristics
    
    // 1. Large files / God objects
    const modulesWithManyFunctions = Array.from(this.nodes.values()).filter(n => {
      if (n.type !== 'module') return false;
      const functionCount = graph.links.filter(l => l.source === n.id && l.type === 'import' && l.target.startsWith('function')).length;
      return functionCount > 10; // threshold
    });

    if (modulesWithManyFunctions.length > 0) {
      insights.push({
        id: 'i-1',
        type: 'refactor',
        title: 'God Object Detected',
        description: `Found ${modulesWithManyFunctions.length} modules containing a large number of functions. Consider splitting them.`,
        severity: 'high',
        affectedNodes: modulesWithManyFunctions.map(n => n.id)
      });
    }

    // 2. High coupling
    const moduleDependencies = new Map<string, number>();
    graph.links.forEach(l => {
      if (l.type === 'import' && l.source.startsWith('module:') && l.target.startsWith('module:')) {
        moduleDependencies.set(l.source, (moduleDependencies.get(l.source) || 0) + 1);
      }
    });
    
    const highlyCoupled = Array.from(moduleDependencies.entries()).filter(([_, count]) => count > 15).map(([id]) => id);
    if (highlyCoupled.length > 0) {
      insights.push({
        id: 'i-2',
        type: 'architecture',
        title: 'High Coupling',
        description: `Some modules have excessive external dependencies, making them hard to test.`,
        severity: 'medium',
        affectedNodes: highlyCoupled
      });
    }

    // Generic fallback insight if none found
    if (insights.length === 0) {
       insights.push({
        id: 'i-default',
        type: 'maintainability',
        title: 'Clean Architecture',
        description: 'No major structural issues detected in the analyzed scope.',
        severity: 'low',
        affectedNodes: []
      });
    }

    return insights;
  }
}
