import { authStorage } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { initAdapter } from "../database/connection.js";
import { generateEmbedding, generateEmbeddingsBatch } from "./embeddingService.js";
import type { GraphEntity, GraphLink, ArchSmells } from "../types/index.js";

type Dialect = "sqlite" | "postgres" | "oracle";

export function activeDialect(): Dialect {
  const configured = (process.env.CODEATLAS_DB_TYPE || "sqlite").toLowerCase();
  return configured === "oracle" || configured === "postgres" ? configured : "sqlite";
}

function tenantId(): string {
  const auth = authStorage.getStore();
  if (!auth?.uid) throw new Error("Auth context required — call within authStorage.run()");
  return auth.uid;
}

/** SQLite stores vectors as BLOB; Oracle/Postgres take the typed array directly. */
function encodeEmbedding(vector: number[] | null | undefined): Uint8Array | Float32Array | null {
  if (!vector || vector.length === 0) return null;
  const floats = new Float32Array(vector);
  return activeDialect() === "sqlite" ? new Uint8Array(floats.buffer) : floats;
}

/** Oracle returns upper-cased column keys, SQLite/Postgres lower-cased ones. */
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
 * configured database adapter, so the same code runs on SQLite, Postgres, or Oracle.
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

    const rows = entities.map((e, index) => ({
      id: `${project}_${e.id}`,
      project,
      type: e.type,
      name: e.label,
      path: e.filePath || "",
      content: contents[index],
      embedding: encodeEmbedding(embeddings?.[index] ?? null),
      tenantId: tid,
    }));

    try {
      for (const row of rows) {
        await db.execute(sql, row);
      }
    } catch (err) {
      logger.error("Error saving semantic memory:", err instanceof Error ? err.message : String(err));
      throw err;
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
      for (const l of links) {
        await db.execute(sql, {
          src: `${project}_${l.source}`,
          tgt: `${project}_${l.target}`,
          project,
          type: l.type,
          tenantId: tid,
        });
      }
    } catch (err) {
      logger.error("Error saving relational memory:", err instanceof Error ? err.message : String(err));
      throw err;
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
        const ids = hits.map(h => `'${String(h.id).replace(/'/g, "''")}'`).join(",");
        return await db.query<Record<string, unknown>>(
          `SELECT entity_name, entity_type, file_path, content
           FROM ai_semantic_memory
           WHERE project_name = :project AND tenant_id = :tenantId AND id IN (${ids})`,
          { project, tenantId: tid }
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

  /** Normalizes episodic rows across dialects (Oracle upper-cases columns). */
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

/** @deprecated Use MemoryService. Alias kept for existing import sites. */
export const OracleMemoryService = MemoryService;
