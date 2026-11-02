export interface DreamProjectIdentityInput {
  projectId: string;
  displayName?: string;
  workspacePath?: string;
  aliases?: string[];
}

export interface DreamProjectIdentityResult {
  projectId: string;
  aliases: string[];
  collisions: Array<{ alias: string; existingProjectId: string }>;
}

/** Persistence boundary owned by project identity policy. */
export interface DreamProjectIdentityRepositoryPort {
  addAlias(input: { tenantId: string; alias: string; projectId: string; displayName: string | null; workspacePath: string | null }): Promise<void>;
  findAliasProjectId(tenantId: string, alias: string): Promise<string | null>;
  recordCollision(input: { tenantId: string; alias: string; requestedProjectId: string; existingProjectId: string }): Promise<void>;
  listAliases(tenantId: string, projectId: string): Promise<string[]>;
}

function normalizeAlias(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length <= 1) return trimmed;
  let end = trimmed.length;
  while (end > 1 && trimmed.charCodeAt(end - 1) === 47) end--;
  return trimmed.slice(0, end);
}

export class DreamProjectIdentityUseCase {
  constructor(private readonly createRepository: () => DreamProjectIdentityRepositoryPort) {}

  async register(tenantId: string, input: DreamProjectIdentityInput): Promise<DreamProjectIdentityResult> {
    const projectId = input.projectId.trim();
    if (!projectId || projectId.length > 512) throw new Error("Invalid project_id");
    const displayName = input.displayName?.trim().slice(0, 512) || null;
    const workspacePath = input.workspacePath?.trim().slice(0, 2048) || null;
    const candidateAliases = [...new Set([input.displayName, input.workspacePath, ...(input.aliases ?? [])]
      .filter((alias): alias is string => typeof alias === "string")
      .map(normalizeAlias)
      .filter((alias) => alias.length > 0 && alias.length <= 2048 && alias !== projectId))];
    const repository = this.createRepository();
    const aliases: string[] = [];
    const collisions: DreamProjectIdentityResult["collisions"] = [];

    for (const alias of candidateAliases) {
      await repository.addAlias({ tenantId, alias, projectId, displayName, workspacePath });
      const existingProjectId = await repository.findAliasProjectId(tenantId, alias);
      if (existingProjectId === null) continue;
      if (existingProjectId !== projectId) {
        collisions.push({ alias, existingProjectId });
        await repository.recordCollision({ tenantId, alias, requestedProjectId: projectId, existingProjectId });
        continue;
      }
      aliases.push(alias);
    }

    return { projectId, aliases, collisions };
  }

  getAliases(tenantId: string, projectId: string): Promise<string[]> {
    return this.createRepository().listAliases(tenantId, projectId);
  }
}
