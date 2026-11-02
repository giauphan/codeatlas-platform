export interface GeneUpsertInput {
  name: string;
  description: string;
  problem: string;
  solution: string;
  architecture?: string;
  category: string;
  project: string;
  sourceType: string;
  sourceId?: string;
  dependencies?: string[];
  confidence?: number;
}

export interface GeneUpsertPersistence {
  findByNameProjectTenant(name: string, project: string, tenantId: string): Promise<{ id: unknown; version: unknown } | undefined>;
  recordMutation(id: string, geneId: string, oldVersion: number, newVersion: number, changes: string): Promise<void>;
  updateExisting(input: {
    id: string; description: string; problem: string; solution: string; architecture: string;
    category: string; confidence: number; version: number; embedding: Uint8Array | null; tenantId: string;
  }): Promise<void>;
  insertNew(input: {
    id: string; name: string; description: string; problem: string; solution: string; architecture: string;
    category: string; project: string; confidence: number; embedding: Uint8Array | null;
    sourceType: string; sourceId: string; dependencies: string; tenantId: string;
  }): Promise<void>;
}

export interface GeneUpsertUseCaseDependencies {
  persistence: GeneUpsertPersistence;
  getTenantId(): string;
  generateEmbedding(text: string): Promise<number[] | null>;
  logInfo(message: string): void;
  createId(prefix: "gene" | "mut"): string;
}

export async function upsertGene(input: GeneUpsertInput, deps: GeneUpsertUseCaseDependencies): Promise<string> {
  const combinedText = `${input.problem}\n\n${input.solution}`;
  const embedding = await deps.generateEmbedding(combinedText);
  const lookupTenantId = deps.getTenantId();
  const existing = await deps.persistence.findByNameProjectTenant(input.name, input.project, lookupTenantId);

  if (existing) {
    const geneId = String(existing.id);
    const oldVersion = Number(existing.version);
    const newVersion = oldVersion + 1;
    await deps.persistence.recordMutation(
      deps.createId("mut"), geneId, oldVersion, newVersion,
      JSON.stringify({ description: input.description, solution: input.solution }),
    );
    const embeddingBytes = embedding ? new Uint8Array(new Float32Array(embedding).buffer) : null;
    const writeTenantId = deps.getTenantId();
    await deps.persistence.updateExisting({
      id: geneId,
      description: input.description,
      problem: input.problem,
      solution: input.solution,
      architecture: input.architecture || "",
      category: input.category,
      confidence: input.confidence || 0.5,
      version: newVersion,
      embedding: embeddingBytes,
      tenantId: writeTenantId,
    });
    deps.logInfo(`[Genome] Gene "${input.name}" updated to v${newVersion}`);
    return geneId;
  }

  const geneId = deps.createId("gene");
  const embeddingBytes = embedding ? new Uint8Array(new Float32Array(embedding).buffer) : null;
  const writeTenantId = deps.getTenantId();
  await deps.persistence.insertNew({
    id: geneId,
    name: input.name,
    description: input.description,
    problem: input.problem,
    solution: input.solution,
    architecture: input.architecture || "",
    category: input.category,
    project: input.project,
    confidence: input.confidence || 0.5,
    embedding: embeddingBytes,
    sourceType: input.sourceType,
    sourceId: input.sourceId || "",
    dependencies: JSON.stringify(input.dependencies || []),
    tenantId: writeTenantId,
  });
  deps.logInfo(`[Genome] Gene "${input.name}" created (v1)`);
  return geneId;
}
