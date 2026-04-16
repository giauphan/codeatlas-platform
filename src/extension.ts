import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WebviewProvider } from './WebviewProvider';
import { CodeAnalyzer } from './analyzer/parser';
import { AnalysisResult, AnalysisManifest, ChunkData, CrossChunkLinks } from './analyzer/types';
import { generateMemory } from './memoryGenerator';

/**
 * Global status bar item for CodeAtlas analysis state.
 */
let statusBarItem: vscode.StatusBarItem;

/** Cached analysis data for progressive loading requests from webview */
let cachedResult: AnalysisResult | null = null;
let cachedManifest: AnalysisManifest | null = null;
let cachedChunks: Map<string, ChunkData> | null = null;
let cachedCrossChunkLinks: CrossChunkLinks | null = null;
let cachedAnalyzer: CodeAnalyzer | null = null;

/**
 * Activates the CodeAtlas extension.
 * @param context The extension context provided by VS Code
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('CodeAtlas is now active!');

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'codeatlas.analyzeProject';
  statusBarItem.text = '$(project) CodeAtlas: Ready';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  /**
   * Disposable for the analyzeProject command.
   */
  let disposable = vscode.commands.registerCommand('codeatlas.analyzeProject', async () => {
    // Ensure we have a workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showInformationMessage('CodeAtlas: Please open a workspace or folder first to analyze the project.');
      return;
    }

    if (statusBarItem) {
      statusBarItem.text = '$(sync~spin) CodeAtlas: Analyzing...';
    }

    // Show loading progress
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "CodeAtlas: Analyzing workspace...",
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 0 });

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      // Read settings
      const config = vscode.workspace.getConfiguration('codeatlas');
      const maxFiles = config.get<number>('maxFiles', 5000);
      const excludedDirectories = config.get<string[]>('excludedDirectories', ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'vendor', 'storage']);
      const excludedFiles = config.get<string[]>('excludedFiles', ['_ide_helper.php', '_ide_helper_models.php', '.phpstorm.meta.php']);
      const fileExtensions = config.get<string[]>('fileExtensions', ['.ts', '.tsx', '.js', '.jsx', '.py', '.php']);
      const initialNodeLimit = config.get<number>('initialNodeLimit', 100);

      // Initialize analyzer
      const analyzer = new CodeAnalyzer(workspaceRoot, maxFiles, excludedDirectories, fileExtensions, excludedFiles);
      
      progress.report({ increment: 30, message: "Parsing ASTs..." });
      
      try {
        const result = await analyzer.analyzeProject();
        
        progress.report({ increment: 50, message: "Building chunks..." });

        // Build chunked data
        const { manifest, chunks, crossChunkLinks } = analyzer.buildChunkedResult(result);

        // Cache for webview requests
        cachedResult = result;
        cachedManifest = manifest;
        cachedChunks = chunks;
        cachedCrossChunkLinks = crossChunkLinks;
        cachedAnalyzer = analyzer;

        progress.report({ increment: 70, message: "Generating Webview..." });
        
        // Show webview
        WebviewProvider.createOrShow(context.extensionUri, workspaceRoot);
        
        // Determine if progressive loading is needed
        const totalNodes = result.graph.nodes.length;
        if (initialNodeLimit > 0 && totalNodes > initialNodeLimit) {
          // Progressive loading: send initial subset
          const initialData = analyzer.getInitialLoadData(result, manifest, chunks, crossChunkLinks, initialNodeLimit);
          WebviewProvider.currentPanel?.sendInitialLoadData({
            manifest,
            initialGraph: initialData.graph,
            loadedFolders: initialData.loadedFolders,
            initialNodeLimit
          });
        } else {
          // Small project: send everything at once (backward compatible)
          WebviewProvider.currentPanel?.sendAnalysisData(result);
        }
        
        // Pass graph physics configuration
        const graphPhysics = config.get<string>('graphPhysics', 'default');
        WebviewProvider.currentPanel?.sendGraphPhysics(graphPhysics);

        if (statusBarItem) {
          const numNodes = result.graph.nodes.length;
          const numLinks = result.graph.links.length;
          statusBarItem.text = `$(project) CodeAtlas: ${numNodes} nodes | ${numLinks} rels`;
        }

        // Save analysis data for MCP server (full data, backward compatible)
        const codeatlasDir = path.join(workspaceRoot, '.codeatlas');
        if (!fs.existsSync(codeatlasDir)) {
          fs.mkdirSync(codeatlasDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(codeatlasDir, 'analysis.json'),
          JSON.stringify(result, null, 2),
          'utf-8'
        );

        // Auto-generate .agents/memory/ folder
        try {
          generateMemory(workspaceRoot, result);
        } catch (memErr) {
          console.error('CodeAtlas: Memory generation failed:', memErr);
        }

        // Save chunked data
        const chunksDir = path.join(codeatlasDir, 'chunks');
        if (!fs.existsSync(chunksDir)) {
          fs.mkdirSync(chunksDir, { recursive: true });
        }
        // Save manifest
        fs.writeFileSync(
          path.join(codeatlasDir, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf-8'
        );
        // Save each chunk
        for (const [folder, chunk] of chunks) {
          const safeFolder = encodeURIComponent(folder);
          fs.writeFileSync(
            path.join(chunksDir, `${safeFolder}.json`),
            JSON.stringify(chunk, null, 2),
            'utf-8'
          );
        }
        // Save cross-chunk links
        fs.writeFileSync(
          path.join(chunksDir, '__cross_links__.json'),
          JSON.stringify(crossChunkLinks, null, 2),
          'utf-8'
        );

        vscode.window.showInformationMessage('CodeAtlas: Analysis complete!');
      } catch (error) {
        console.error(error);
        if (statusBarItem) {
          statusBarItem.text = '$(error) CodeAtlas: Error';
        }
        vscode.window.showErrorMessage('CodeAtlas Analysis failed: ' + (error as Error).message);
      }
    });
  });

  /**
   * Disposable for the openPanel command.
   */
  const openPanelDisposable = vscode.commands.registerCommand('codeatlas.openPanel', () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showInformationMessage('CodeAtlas: Please open a workspace or folder first to view insights.');
      return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    WebviewProvider.createOrShow(context.extensionUri, workspaceRoot);
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(openPanelDisposable);

  // File Watcher
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx}');
  let debounceTimer: NodeJS.Timeout | undefined;

  const triggerReanalysis = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      if (WebviewProvider.currentPanel) {
        if (statusBarItem) {
          statusBarItem.text = '$(sync~spin) CodeAtlas: Updating...';
        }
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const config = vscode.workspace.getConfiguration('codeatlas');
            const initialNodeLimit = config.get<number>('initialNodeLimit', 100);
            const maxFiles = config.get<number>('maxFiles', 5000);
            const excludedDirectories = config.get<string[]>('excludedDirectories', ['node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'vendor', 'storage']);
            const excludedFiles = config.get<string[]>('excludedFiles', ['_ide_helper.php', '_ide_helper_models.php', '.phpstorm.meta.php']);
            const fileExtensions = config.get<string[]>('fileExtensions', ['.ts', '.tsx', '.js', '.jsx', '.py', '.php']);

            const analyzer = new CodeAnalyzer(workspaceFolders[0].uri.fsPath, maxFiles, excludedDirectories, fileExtensions, excludedFiles);
            const result = await analyzer.analyzeProject();
            const { manifest, chunks, crossChunkLinks } = analyzer.buildChunkedResult(result);

            // Update cache
            cachedResult = result;
            cachedManifest = manifest;
            cachedChunks = chunks;
            cachedCrossChunkLinks = crossChunkLinks;
            cachedAnalyzer = analyzer;

            const totalNodes = result.graph.nodes.length;
            if (initialNodeLimit > 0 && totalNodes > initialNodeLimit) {
              const initialData = analyzer.getInitialLoadData(result, manifest, chunks, crossChunkLinks, initialNodeLimit);
              WebviewProvider.currentPanel.sendInitialLoadData({
                manifest,
                initialGraph: initialData.graph,
                loadedFolders: initialData.loadedFolders,
                initialNodeLimit
              });
            } else {
              WebviewProvider.currentPanel.sendAnalysisData(result);
            }

            if (statusBarItem) {
              statusBarItem.text = `$(project) CodeAtlas: ${result.graph.nodes.length} nodes | ${result.graph.links.length} rels`;
            }
          }
        } catch (error) {
          console.error('CodeAtlas Auto-Analysis failed:', error);
          if (statusBarItem) {
            statusBarItem.text = '$(error) CodeAtlas: Error';
          }
        }
      }
    }, 2000);
  };

  watcher.onDidChange(triggerReanalysis);
  watcher.onDidCreate(triggerReanalysis);
  watcher.onDidDelete(triggerReanalysis);
  context.subscriptions.push(watcher);

  // Listen for configuration changes
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('codeatlas')) {
      if (WebviewProvider.currentPanel) {
        // Re-analyze if analysis-related settings changed
        if (
          e.affectsConfiguration('codeatlas.maxFiles') ||
          e.affectsConfiguration('codeatlas.excludedDirectories') ||
          e.affectsConfiguration('codeatlas.fileExtensions') ||
          e.affectsConfiguration('codeatlas.initialNodeLimit')
        ) {
          vscode.commands.executeCommand('codeatlas.analyzeProject');
        }
      }
    }
  });
}

/**
 * Returns cached analysis data for webview requests.
 */
export function getCachedData() {
  return {
    result: cachedResult,
    manifest: cachedManifest,
    chunks: cachedChunks,
    crossChunkLinks: cachedCrossChunkLinks,
    analyzer: cachedAnalyzer
  };
}

/**
 * Deactivates the CodeAtlas extension and cleans up resources.
 */
export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  cachedResult = null;
  cachedManifest = null;
  cachedChunks = null;
  cachedCrossChunkLinks = null;
  cachedAnalyzer = null;
}
