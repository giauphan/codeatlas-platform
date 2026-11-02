import type { AdapterConnection } from "../connection.js";
import type { GeneUpsertPersistence } from "../../services/geneUpsertUseCase.js";

/** SQL adapter for the application-owned gene upsert policy. */
export class GeneUpsertPersistenceAdapter implements GeneUpsertPersistence {
  constructor(private readonly connection: AdapterConnection) {}

  async findByNameProjectTenant(name: string, project: string, tenantId: string): Promise<{ id: unknown; version: unknown } | undefined> {
    const result = await this.connection.execute<unknown[]>(
      `SELECT id, version FROM codeatlas_genome WHERE name = :name AND project = :project AND tenant_id = :tenantId`,
      { name, project, tenantId },
    );
    const rows = result.rows || [];
    if (rows.length === 0) return undefined;
    const first: unknown = rows[0];
    if (first === null || first === undefined) throw new TypeError("Invalid existing gene row");
    if (Array.isArray(first)) return { id: first[0], version: first[1] };
    if (typeof first === "string") return { id: first[0], version: first[1] };
    if (typeof first === "object" && first !== null) {
      const indexed = first as Record<string, unknown>;
      return { id: indexed["0"], version: indexed["1"] };
    }
    // The former rows.length check selected the update path for every row,
    // even when a driver returned an unusual non-indexable value.
    return { id: undefined, version: undefined };
  }

  async recordMutation(id: string, geneId: string, oldVersion: number, newVersion: number, changes: string): Promise<void> {
    await this.connection.execute(
      `INSERT INTO gene_mutations (id, gene_id, old_version, new_version, changes, created_at)
           VALUES (:id, :geneId, :oldVer, :newVer, :changes, CURRENT_TIMESTAMP)`,
      { id, geneId, oldVer: oldVersion, newVer: newVersion, changes },
      { autoCommit: true },
    );
  }

  async updateExisting(input: {
    id: string; description: string; problem: string; solution: string; architecture: string;
    category: string; confidence: number; version: number; embedding: Uint8Array | null; tenantId: string;
  }): Promise<void> {
    await this.connection.execute(
      `UPDATE codeatlas_genome SET
           description = :desc, problem = :problem, solution = :solution,
           architecture = :arch, category = :cat, confidence = :conf,
           version = :ver, evolution_score = evolution_score + 1,
           embedding = :emb, status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE id = :id AND tenant_id = :tenantId`,
      {
        id: input.id,
        desc: input.description,
        problem: input.problem,
        solution: input.solution,
        arch: input.architecture,
        cat: input.category,
        conf: input.confidence,
        ver: input.version,
        emb: input.embedding,
        tenantId: input.tenantId,
      },
      { autoCommit: true },
    );
  }

  async insertNew(input: {
    id: string; name: string; description: string; problem: string; solution: string; architecture: string;
    category: string; project: string; confidence: number; embedding: Uint8Array | null;
    sourceType: string; sourceId: string; dependencies: string; tenantId: string;
  }): Promise<void> {
    await this.connection.execute(
      `INSERT INTO codeatlas_genome (
             id, name, description, problem, solution, architecture,
             category, project, confidence, version, evolution_score,
             usage_count, success_rate, embedding, status, source_type,
             source_id, dependencies, created_at, updated_at, tenant_id
           ) VALUES (
             :id, :name, :desc, :problem, :solution, :arch,
             :cat, :project, :conf, 1, 1, 0, 0.50, :emb, 'active',
             :srcType, :srcId, :deps, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, :tenantId
           )`,
      {
        id: input.id,
        name: input.name,
        desc: input.description,
        problem: input.problem,
        solution: input.solution,
        arch: input.architecture,
        cat: input.category,
        project: input.project,
        conf: input.confidence,
        emb: input.embedding,
        srcType: input.sourceType,
        srcId: input.sourceId,
        deps: input.dependencies,
        tenantId: input.tenantId,
      },
      { autoCommit: true },
    );
  }
}
