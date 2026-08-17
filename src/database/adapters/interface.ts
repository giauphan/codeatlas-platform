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
  searchVector(table: string, embedding: number[], limit: number, tenantId: string): Promise<VectorSearchResult[]>;

  // Schema migration
  initializeSchema(): Promise<void>;
  checkColumnExists(table: string, column: string): Promise<boolean>;

  // Graph operations (replacement for GRAPH_TABLE)
  detectCircularDependencies(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>>;
  detectGodObjects(project: string, tenantId: string): Promise<Array<{ entity_name: string; in_degree: number }>>;
  detectDeadCode(project: string, tenantId: string): Promise<Array<{ entity_name: string; file_path: string }>>;
}

export interface VectorSearchResult {
  id: string;
  score: number; // 0..1 (1 = most similar)
  // ... other fields from the table
}
