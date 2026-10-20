import { createDatabaseAdapter } from "../database/factory.js";
import { authStorage } from "../utils/context.js";

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

function normalizeAlias(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, "");
}

export class DreamProjectIdentityService {
  static async register(input: DreamProjectIdentityInput): Promise<DreamProjectIdentityResult> {
    const auth = authStorage.getStore();
    if (!auth?.uid) throw new Error("Auth context required to register project identity");
    const projectId = input.projectId.trim();
    if (!projectId || projectId.length > 512) throw new Error("Invalid project_id");
    const displayName = input.displayName?.trim().slice(0, 512) || null;
    const workspacePath = input.workspacePath?.trim().slice(0, 2048) || null;
    const candidateAliases = [...new Set([input.displayName, input.workspacePath, ...(input.aliases ?? [])]
      .filter((alias): alias is string => typeof alias === "string")
      .map(normalizeAlias)
      .filter((alias) => alias.length > 0 && alias.length <= 2048 && alias !== projectId))];
    const db = createDatabaseAdapter();
    const aliases: string[] = [];
    const collisions: DreamProjectIdentityResult["collisions"] = [];

    for (const alias of candidateAliases) {
      await db.execute(
        `INSERT INTO dream_project_aliases (tenant_id, alias, project_id, display_name, workspace_path)
         VALUES (:tenantId, :alias, :projectId, :displayName, :workspacePath)
         ON CONFLICT DO NOTHING`,
        { tenantId: auth.uid, alias, projectId, displayName, workspacePath },
      );
      const existing = await db.query<{ project_id: string }>(
        `SELECT project_id FROM dream_project_aliases WHERE tenant_id = :tenantId AND alias = :alias LIMIT 1`,
        { tenantId: auth.uid, alias },
      );
      if (!existing.length) continue;
      if (existing[0].project_id !== projectId) {
        collisions.push({ alias, existingProjectId: existing[0].project_id });
        await db.execute(
          `INSERT INTO dream_project_alias_audit (tenant_id, alias, requested_project_id, existing_project_id, reason)
           VALUES (:tenantId, :alias, :requestedProjectId, :existingProjectId, 'alias_collision')`,
          { tenantId: auth.uid, alias, requestedProjectId: projectId, existingProjectId: existing[0].project_id },
        );
        continue;
      }
      aliases.push(alias);
    }

    return { projectId, aliases, collisions };
  }

  static async getAliases(projectId: string): Promise<string[]> {
    const tenantId = authStorage.getStore()?.uid;
    if (!tenantId) throw new Error("Auth context required to read project aliases");
    const rows = await createDatabaseAdapter().query<{ alias: string }>(
      `SELECT alias FROM dream_project_aliases
       WHERE tenant_id = :tenantId AND project_id = :projectId ORDER BY alias ASC`,
      { tenantId, projectId },
    );
    return rows.map((row) => row.alias);
  }
}
