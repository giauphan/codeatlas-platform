import { randomUUID } from "node:crypto";
import { initPool, setSessionContext } from "../database/connection.js";
import type { AdapterConnection } from "../database/connection.js";
import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { buildInClause } from "../database/utils.js";

// ─── Types ──────────────────────────────────────────────────
export interface GeneInput {
  name: string;
  description: string;
  problem: string;
  solution: string;
  architecture?: string;
  category: string; // 'pattern' | 'decision' | 'lesson' | 'workflow' | 'immune'
  project: string;
  sourceType: string; // 'dream' | 'concept' | 'skill' | 'manual' | 'feedback'
  sourceId?: string;
  dependencies?: string[]; // gene IDs this depends on
  confidence?: number;
}

export interface GeneRecord {
  id: string;
  name: string;
  description: string;
  problem: string;
  solution: string;
  architecture: string;
  category: string;
  project: string;
  confidence: number;
  version: number;
  evolutionScore: number;
  usageCount: number;
  successRate: number;
  status: string;
  sourceType: string;
  sourceId: string;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GeneSearchResult extends GeneRecord {
  score: number; // similarity score
}

export interface ExtractRequest {
  sourceType: string;
  sourceId: string;
  project: string;
  autoExtract?: boolean;
}

/** Get authenticated tenant ID — fallback to admin for testing */
export function getTenantId(): string {
  const auth = authStorage.getStore();
  return auth ? auth.uid : "admin";
}

export function rowValue<T = unknown>(row: unknown, name: string): T | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  return (
    (record[name] as T | undefined) ??
    (record[name.toUpperCase()] as T | undefined) ??
    (record[name.toLowerCase()] as T | undefined)
  );
}

export function mapRowToGeneRecord(row: unknown): GeneRecord {
  return {
    id: String(rowValue(row, "id")),
    name: String(rowValue(row, "name")),
    description: String(rowValue(row, "description") || ""),
    problem: String(rowValue(row, "problem") || ""),
    solution: String(rowValue(row, "solution") || ""),
    architecture: String(rowValue(row, "architecture") || ""),
    category: String(rowValue(row, "category")),
    project: String(rowValue(row, "project") || ""),
    confidence: Number(rowValue(row, "confidence")),
    version: Number(rowValue(row, "version")),
    evolutionScore: Number(rowValue(row, "evolution_score")),
    usageCount: Number(rowValue(row, "usage_count")),
    successRate: Number(rowValue(row, "success_rate")),
    status: String(rowValue(row, "status")),
    sourceType: String(rowValue(row, "source_type") || ""),
    sourceId: String(rowValue(row, "source_id") || ""),
    dependencies: JSON.parse(String(rowValue(row, "dependencies") || "[]")),
    createdAt: String(rowValue(row, "created_at")),
    updatedAt: String(rowValue(row, "updated_at")),
  };
}

export function mapRowToScoredGene(row: unknown, scoreMap: ReadonlyMap<string, number>): GeneSearchResult {
  const record = mapRowToGeneRecord(row);
  return {
    ...record,
    score: scoreMap.get(record.id) ?? 0,
  };
}

export const GENOME_SELECT_COLUMNS = `id, name, description, problem, solution, architecture,
                category, project, confidence, version, evolution_score,
                usage_count, success_rate, embedding, status,
                source_type, source_id, dependencies, created_at, updated_at`;

export async function fetchGenesByVectorMatches(
  connection: AdapterConnection,
  searchResults: ReadonlyArray<{ id: string; score: number }>,
  tenantId: string,
): Promise<{ genes: GeneSearchResult[]; rows: unknown[] }> {
  if (searchResults.length === 0) return { genes: [], rows: [] };

  const ids = searchResults.map((r) => r.id);
  const scoreMap = new Map(searchResults.map((r) => [r.id, r.score]));
  const { clause: idBinds, binds: queryBinds } = buildInClause(ids, { tenantId });

  const result = await connection.execute<unknown[]>(
    `SELECT ${GENOME_SELECT_COLUMNS}
         FROM codeatlas_genome
         WHERE tenant_id = :tenantId AND id IN (${idBinds})`,
    queryBinds,
  );

  const paired = (result.rows || []).map((row) => ({
    row,
    gene: mapRowToScoredGene(row, scoreMap),
  }));
  paired.sort((a, b) => b.gene.score - a.gene.score);
  return {
    genes: paired.map((p) => p.gene),
    rows: paired.map((p) => p.row),
  };
}

export async function withGenomeConnection<T>(work: (connection: AdapterConnection) => Promise<T>): Promise<T> {
  const connection = await (await initPool()).getConnection();
  try {
    await setSessionContext(connection);
    return await work(connection);
  } finally {
    try {
      await connection.close();
    } catch {
      // Preserve the existing best-effort cleanup policy.
    }
  }
}

export function incrementGeneUsageInBackground(geneIds: readonly string[], tenantId: string): void {
  const uniqueIds = Array.from(new Set(geneIds));
  if (uniqueIds.length === 0) return;

  initPool()
    .then((pool) => pool.getConnection())
    .then((bgConn) =>
      setSessionContext(bgConn)
        .then(async () => {
          const chunkSize = 900;
          for (let i = 0; i < uniqueIds.length; i += chunkSize) {
            const chunk = uniqueIds.slice(i, i + chunkSize);
            const { clause: inClause, binds: inBinds } = buildInClause(chunk, { tenantId });
            await bgConn.execute( // NOSONAR
              `UPDATE codeatlas_genome SET usage_count = usage_count + 1,
                 updated_at = CURRENT_TIMESTAMP WHERE id IN (${inClause}) AND tenant_id = :tenantId`,
              inBinds,
              { autoCommit: true },
            );
          }
        })
        .finally(() => bgConn.close()),
    )
    .catch((err) => {
      logger.warn(
        `[Genome] Failed to non-blocking increment usage counts for genes: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

export function createPrefixedId(prefix: "gene" | "mut" | "rel"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
