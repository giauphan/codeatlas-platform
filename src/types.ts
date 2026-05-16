export interface GraphNode {
  id: string;
  label: string;
  type: 'module' | 'function' | 'class' | 'variable';
  val?: number; // Size in graph
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

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface AIInsight {
  id: string;
  type: 'refactor' | 'security' | 'maintainability' | 'performance' | 'architecture';
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  affectedNodes: string[];
}

export interface EntityCounts {
  modules: number;
  functions: number;
  classes: number;
  dependencies: number;
  circularDeps: number;
}

export interface AnalysisResult {
  graph: GraphData;
  insights: AIInsight[];
  entityCounts: EntityCounts;
  totalFilesAnalyzed: number;
  totalFilesSkipped: number;
}

// --- Chunked / Progressive Loading Types ---

export interface FolderInfo {
  path: string;          // relative folder path (e.g. "src/components")
  nodeCount: number;
  linkCount: number;
  types: Record<string, number>;  // { module: 2, function: 5, class: 1 }
}

export interface AnalysisManifest {
  totalNodes: number;
  totalLinks: number;
  totalFiles: number;
  totalFilesSkipped: number;
  folders: FolderInfo[];
  insights: AIInsight[];
  entityCounts: EntityCounts;
}

export interface ChunkData {
  folderPath: string;
  nodes: GraphNode[];
  links: GraphLink[];    // links where BOTH source and target are in this chunk
}

/** Cross-chunk links where source and target are in different folders */
export interface CrossChunkLinks {
  links: GraphLink[];
}

/** Sent to webview on initial load: manifest + first N nodes */
export interface InitialLoadData {
  manifest: AnalysisManifest;
  initialGraph: GraphData;       // first N nodes + their links
  loadedFolders: string[];       // which folders are included
  initialNodeLimit: number;
}
