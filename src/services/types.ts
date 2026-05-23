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
  variables?: number;
  dependencies: number;
  circularDeps: number;
  deadCode?: number;
}

export interface AnalysisResult {
  graph: GraphData;
  insights: AIInsight[];
  entityCounts: EntityCounts;
  totalFilesAnalyzed: number;
  totalFilesSkipped: number;
}
