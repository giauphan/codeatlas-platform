// src/database/adapters/interface.ts
export interface IDatabaseAdapter {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnection(): Promise<unknown>; // Opaque connection handle

  // CRUD operations
  query<T>(sql: string, params?: Record<string, unknown> | unknown[]): Promise<T[]>;
  execute(sql: string, params?: Record<string, unknown> | unknown[]): Promise<{ rowsAffected: number }>;
  executeMany(sql: string, params: Array<Record<string, unknown>>): Promise<{ rowsAffected: number }>;

  // Vector search
  searchVector(table: string, embedding: number[], limit: number, tenantId: string, filterBinds?: Record<string, unknown>): Promise<VectorSearchResult[]>;

  // Schema migration
  initializeSchema(): Promise<void>;
  checkColumnExists(table: string, column: string): Promise<boolean>;

  // Graph operations (replacement for GRAPH_TABLE)
  detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>>;
  detectGodObjects(project: string, tenantId: string): Promise<Array<{ entity_name: string; in_degree: number }>>;
  detectDeadCode(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>>;

  // Wiki operations
  saveWikiPage(page: WikiPageRecord): Promise<void>;
  getWikiPage(projectName: string, path: string, tenantId?: string): Promise<WikiPageRecord | null>;
  listWikiPages(projectName: string, tenantId?: string): Promise<WikiPageRecord[]>;
  deleteWikiPages(projectName: string, tenantId?: string): Promise<void>;
}

export interface VectorSearchResult {
  id: string;
  score: number; // 0..1 (1 = most similar)
  // ... other fields from the table
}

export interface WikiPageRecord {
  id: string;
  project_name: string;
  path: string;
  title: string;
  summary?: string;
  content: string;
  diagram_data?: string;
  parent_path?: string;
  order_index?: number;
  created_at?: string;
  updated_at?: string;
  tenant_id?: string;
}
