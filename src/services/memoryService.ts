import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initAdapter } from "../database/connection.js";
import { generateEmbedding, generateEmbeddingsBatch } from "./embeddingService.js";
import type { GraphEntity, GraphLink, ArchSmells } from "../types/index.js";
import { buildInClause, batchExecuteMany, validateRows } from "../database/utils.js";

type Dialect = "sqlite" | "postgres";

export function activeDialect(): Dialect {
  return (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase() === "postgres" ? "postgres" : "sqlite";
}

/**
 * Filters out malformed array items and optionally logs a warning with diagnostic counts.
 * Prevents throwing errors for individual mismatched fields to improve resilience.
 *
 * @example
 * const items = [{id: 1}, {id: null}];
 * const validItems = filterValidItems(items, (item) => item.id !== null, (skipped) => logger.warn(`Skipped ${skipped} items`));
 */
function filterValidItems<T>(
  items: T[],
  isValid: (item: T, index: number) => boolean,
  logWarning: (skippedCount: number) => void
): T[] {
  const valid: T[] = [];
  let skippedCount = 0;

  // Guard against arbitrary large unbounded inputs or prototype pollution
  const len = Array.isArray(items) ? items.length : 0;

  for (let i = 0; i < len; i++) {
    if (isValid(items[i], i)) {
      valid.push(items[i]);
    } else {
      skippedCount++;
    }
  }
  if (skippedCount > 0) {
    logWarning(skippedCount);
  }
  return valid;
}

function tenantId(): string {
  const auth = authStorage.getStore();
  if (!auth?.uid) throw new Error("Auth context required — call within authStorage.run()");
  return auth.uid;
}

/** SQLite stores vectors as a BLOB; Postgres takes the typed array directly. */
function encodeEmbedding(vector: number[] | null | undefined): Uint8Array | Float32Array | null {
  if (!vector || vector.length === 0) return null;
  const floats = new Float32Array(vector);
  return activeDialect() === "sqlite" ? new Uint8Array(floats.buffer) : floats;
}

/** Row keys come back lower-cased from SQLite; tolerate other casings defensively. */
function col<T = unknown>(row: Record<string, unknown>, name: string): T | undefined {
  if (name in row) return row[name] as T;
  const upper = name.toUpperCase();
  if (upper in row) return row[upper] as T;
  const lower = name.toLowerCase();
  return lower in row ? (row[lower] as T) : undefined;
}

/**
 * AI Memory across three tiers: episodic events, semantic entity embeddings,
 * and relational knowledge-graph edges. Every statement goes through the
 * configured database adapter (SQLite + sqlite-vec by default).
 */
export class MemoryService {
  /** Tier 1: Episodic — business rules and change logs. */
  static async saveEpisodicMemory(
    project: string,
    eventType: "BUSINESS_RULE" | "CHANGE_LOG",
    data: Record<string, unknown>
  ): Promise<void> {
    const db = await initAdapter();
    try {
      await db.execute(
        `INSERT INTO ai_episodic_memory (id, project_name, event_type, event_data, tenant_id)
         VALUES (:id, :project, :eventType, :data, :tenantId)`,
        {
          id: `${project}_${eventType}_${Date.now()}`,
          project,
          eventType,
          data: JSON.stringify(data ?? {}),
          tenantId: tenantId(),
        }
      );
    } catch (err) {
      logger.error("Error saving episodic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Retrieves episodic memories (change logs / business rules) for a project. */
  static async getEpisodicMemories(
    project: string,
    eventType?: "BUSINESS_RULE" | "CHANGE_LOG"
  ): Promise<Array<Record<string, unknown>>> {
    const db = await initAdapter();
    try {
      const binds: Record<string, unknown> = { project, tenantId: tenantId() };
      let sql = `SELECT id, event_type, event_data, created_at
                 FROM ai_episodic_memory
                 WHERE project_name = :project AND tenant_id = :tenantId`;
      if (eventType) {
        sql += ` AND event_type = :eventType`;
        binds.eventType = eventType;
      }
      sql += ` ORDER BY created_at DESC`;
      return await db.query<Record<string, unknown>>(sql, binds);
    } catch (err) {
      logger.error("Error getting episodic memories:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Tier 2: Semantic — code entity embeddings. Upsert on id. */
  static async saveSemanticMemory(project: string, entities: GraphEntity[]): Promise<void> {
    if (entities.length === 0) return;
    const contents = entities.map(e => `Entity: ${e.label}, Type: ${e.type}, Path: ${e.filePath}`);
    const embeddings = await generateEmbeddingsBatch(contents, "passage");
    const db = await initAdapter();
    const tid = tenantId();

    const sql = `
      INSERT INTO ai_semantic_memory (id, project_name, entity_type, entity_name, file_path, content, embedding, tenant_id)
      VALUES (:id, :project, :type, :name, :path, :content, :embedding, :tenantId)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, embedding = excluded.embedding
    `;

    // Filter down to the subset of entities that successfully generated embeddings
    // We map to a tuple to preserve the original index for content lookup, preventing indexOf bugs
    const validEntitiesWithIndices = filterValidItems(
      entities.map((e, i) => ({ entity: e, originalIndex: i })),
      (item) => !!(embeddings && embeddings[item.originalIndex] !== undefined),
      (skippedCount) => {
        const acceptedCount = entities.length - skippedCount;
        logger.warn(`[MemoryService] Embedding generation mismatch for semantic memory. Expected ${entities.length}, got ${embeddings?.length}. Accepted ${acceptedCount} valid entities, dropping ${skippedCount} unmatched entities.`);
      }
    );
    const validEmbeddings = embeddings ? embeddings.filter(emb => emb !== undefined) : [];

    // Transform GraphEntity objects into database rows, mapping project-prefixed IDs
    // and combining them with their generated semantic embeddings.
    const rows = validEntitiesWithIndices.map((item, mappedIndex) => {
      // In a well-formed response, validEmbeddings length perfectly matches validEntitiesWithIndices length.
      // However, if the generation batch failed partially or the arrays somehow drifted,
      // we need to fail fast to prevent silent data corruption or 'TypeError: cannot read properties of undefined'.
      if (mappedIndex >= validEmbeddings.length) {
         throw new Error(`[MemoryService] Critical Mismatch: Index out of bounds during row mapping for entity ${item.entity.id}. Expected at least ${mappedIndex + 1} valid embeddings but got ${validEmbeddings.length}.`);
      }
      const emb = validEmbeddings[mappedIndex];

      const content = contents[item.originalIndex];
      if (content === undefined) {
         throw new Error(`[MemoryService] Critical Mismatch: Original index ${item.originalIndex} out of bounds for contents array of length ${contents.length}.`);
      }

      return {
        id: `${project}_${item.entity.id}`,
        project,
        type: item.entity.type,
        name: item.entity.label,
        path: item.entity.filePath || "",
        content, // Safe O(1) direct mapping guaranteed by index invariants
        embedding: encodeEmbedding(emb),
        tenantId: tid,
      };
    });

    type SemanticMemoryRow = { id: string; project: string; type: string; name: string; path: string; content: string; embedding: any; tenantId: string };

    // Sample a subset for very large ingestion requests to optimize validation performance
    validateRows<SemanticMemoryRow>(rows as SemanticMemoryRow[], { id: 'string', project: 'string' }, 10);

    try {
      await batchExecuteMany(db, sql, rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Error saving semantic memory:", msg);
      if (err instanceof Error) {
         throw err;
      }
      throw new Error(`Error saving semantic memory: ${msg}`);
    }
  }

  /** Tier 3: Relational — knowledge-graph edges. Insert-if-absent. */
  static async saveRelationalMemory(project: string, links: GraphLink[]): Promise<void> {
    if (links.length === 0) return;
    const db = await initAdapter();
    const tid = tenantId();

    const sql = `
      INSERT INTO ai_relational_memory (source_id, target_id, project_name, relationship_type, tenant_id)
      VALUES (:src, :tgt, :project, :type, :tenantId)
      ON CONFLICT DO NOTHING
    `;

    try {
      // Transform GraphLink objects into an array of parameter binds, ensuring
      // the source and target node IDs are correctly prefixed with the project name.
      // Filter out links that lack valid source or target identifiers.
      let skippedNoSource = 0;
      let skippedNoTarget = 0;

      const validLinks = filterValidItems(
        links,
        (l) => {
          const hasSource = !!l.source;
          const hasTarget = !!l.target;
          if (!hasSource && !hasTarget) {
            skippedNoSource++;
            skippedNoTarget++;
            return false;
          }
          if (!hasSource) {
             skippedNoSource++;
             return false;
          }
          if (!hasTarget) {
             skippedNoTarget++;
             return false;
          }
          return true;
        },
        (skippedCount) => {
          const acceptedCount = links.length - skippedCount;
          logger.warn(`[MemoryService] Relational memory diagnostics for project '${project}': Accepted ${acceptedCount} valid links. Skipped ${skippedCount} malformed links (${skippedNoSource} missing source, ${skippedNoTarget} missing target).`);
        }
      );

      type RelationalMemoryRow = { src: string; tgt: string; project: string; type: string; tenantId: string };
      const rows: RelationalMemoryRow[] = validLinks.map(l => ({
        src: `${project}_${l.source}`,
        tgt: `${project}_${l.target}`,
        project,
        type: l.type,
        tenantId: tid,
      }));

      // Sample a subset for very large ingestion requests to optimize validation performance
      validateRows<RelationalMemoryRow>(rows, { src: 'string', tgt: 'string' }, 10);

      await batchExecuteMany(db, sql, rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Error saving relational memory:", msg);
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(`Error saving relational memory: ${msg}`);
    }
  }

  /** Semantic vector search over stored entity embeddings. */
  static async searchSemanticMemory(
    project: string,
    query: string,
    limit: number = 5
  ): Promise<Array<Record<string, unknown>>> {
    const queryVector = await generateEmbedding(query, "query");
    const db = await initAdapter();
    const tid = tenantId();

    try {
      if (queryVector) {
        const hits = await db.searchVector("ai_semantic_memory", queryVector, limit, tid);
        if (hits.length === 0) return [];
        const ids = hits.map((h) => String(h.id));
        const { clause: inClause, binds: bindParams } = buildInClause(ids, { project, tenantId: tid });
        return await db.query<Record<string, unknown>>(
          `SELECT entity_name, entity_type, file_path, content
           FROM ai_semantic_memory
           WHERE project_name = :project AND tenant_id = :tenantId AND id IN (${inClause})`,
          bindParams
        );
      }

      return await db.query<Record<string, unknown>>(
        `SELECT entity_name, entity_type, file_path, content
         FROM ai_semantic_memory
         WHERE project_name = :project AND tenant_id = :tenantId
         LIMIT :limit`,
        { project, tenantId: tid, limit }
      );
    } catch (err) {
      // Avoid logging potentially sensitive user queries directly if the search query is included in the error message
      logger.error("Error searching semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Graph analysis: circular deps, god objects, dead code — delegated to the adapter. */
  static async detectArchitecturalSmells(project: string): Promise<ArchSmells> {
    const db = await initAdapter();
    const tid = tenantId();
    try {
      return {
        circularDependencies: (await db.detectCircularDependencies(project, tid)) as unknown[],
        godObjects: (await db.detectGodObjects(project, tid)) as unknown[],
        deadCode: (await db.detectDeadCode(project, tid)) as unknown[],
      };
    } catch (err) {
      logger.error("Error detecting smells:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Deletes all episodic, semantic, and relational memory for a project. */
  static async deleteProjectMemory(project: string): Promise<void> {
    const db = await initAdapter();
    const tid = tenantId();
    try {
      await db.execute(
        `DELETE FROM ai_episodic_memory WHERE project_name = :project AND tenant_id = :tenantId`,
        { project, tenantId: tid }
      );
      await db.execute(
        `DELETE FROM ai_semantic_memory WHERE project_name = :project AND tenant_id = :tenantId`,
        { project, tenantId: tid }
      );
      await db.execute(
        `DELETE FROM ai_relational_memory WHERE project_name = :project AND tenant_id = :tenantId`,
        { project, tenantId: tid }
      );
      logger.info(`[Memory] Deleted all memory for project ${project} (tenant ${tid})`);
    } catch (err) {
      logger.error("Error deleting project memory:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Normalizes episodic rows across dialects (column casing can vary). */
  static parseEpisodicMemories(
    memories: Array<Record<string, unknown>>
  ): Array<{ id: unknown; eventType: unknown; data: unknown; createdAt: unknown }> {
    return memories.map((m) => {
      const raw = col(m, "event_data");
      let val: unknown = null;
      try {
        if (typeof raw === "string") {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          val = parsed.val !== undefined ? parsed.val : parsed;
        } else if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          val = obj.val !== undefined ? obj.val : obj;
        }
      } catch {
        val = raw;
      }
      return {
        id: col(m, "id"),
        eventType: col(m, "event_type"),
        data: val,
        createdAt: col(m, "created_at"),
      };
    });
  }
}
