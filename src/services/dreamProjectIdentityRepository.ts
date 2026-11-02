import { createDatabaseAdapter } from "../database/factory.js";
import type { IDatabaseAdapter } from "../database/adapters/interface.js";
import type { DreamProjectIdentityRepositoryPort } from "./dreamProjectIdentityUseCase.js";

/** SQL adapter for the identity capability's tenant-scoped repository port. */
export class DreamProjectIdentityRepository implements DreamProjectIdentityRepositoryPort {
  private readonly adapter: IDatabaseAdapter;

  constructor() {
    this.adapter = createDatabaseAdapter();
  }

  async addAlias(input: { tenantId: string; alias: string; projectId: string; displayName: string | null; workspacePath: string | null }): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO dream_project_aliases (tenant_id, alias, project_id, display_name, workspace_path)
       VALUES (:tenantId, :alias, :projectId, :displayName, :workspacePath)
       ON CONFLICT DO NOTHING`,
      { tenantId: input.tenantId, alias: input.alias, projectId: input.projectId, displayName: input.displayName, workspacePath: input.workspacePath },
    );
  }

  async findAliasProjectId(tenantId: string, alias: string): Promise<string | null> {
    const rows = await this.adapter.query<{ project_id: string }>(
      `SELECT project_id FROM dream_project_aliases WHERE tenant_id = :tenantId AND alias = :alias LIMIT 1`,
      { tenantId, alias },
    );
    return rows[0]?.project_id ?? null;
  }

  async recordCollision(input: { tenantId: string; alias: string; requestedProjectId: string; existingProjectId: string }): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO dream_project_alias_audit (tenant_id, alias, requested_project_id, existing_project_id, reason)
       VALUES (:tenantId, :alias, :requestedProjectId, :existingProjectId, 'alias_collision')
       ON CONFLICT (tenant_id, alias, requested_project_id, existing_project_id) DO NOTHING`,
      { tenantId: input.tenantId, alias: input.alias, requestedProjectId: input.requestedProjectId, existingProjectId: input.existingProjectId },
    );
  }

  async listAliases(tenantId: string, projectId: string): Promise<string[]> {
    const rows = await this.adapter.query<{ alias: string }>(
      `SELECT alias FROM dream_project_aliases
       WHERE tenant_id = :tenantId AND project_id = :projectId ORDER BY alias ASC`,
      { tenantId, projectId },
    );
    return rows.map((row) => row.alias);
  }
}
