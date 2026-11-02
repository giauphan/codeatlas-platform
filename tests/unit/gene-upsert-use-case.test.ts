import test from "node:test";
import assert from "node:assert/strict";
import type { GeneInput } from "../../src/services/genomeService.js";
import { upsertGene, type GeneUpsertPersistence } from "../../src/services/geneUpsertUseCase.js";
import { GeneUpsertPersistenceAdapter } from "../../src/database/adapters/geneUpsertPersistence.js";
import type { AdapterConnection } from "../../src/database/connection.js";

const input: GeneInput = {
  name: "Policy", description: "new description", problem: "problem", solution: "solution",
  category: "pattern", project: "project-a", sourceType: "manual",
};

function fakePersistence(existing?: { id: unknown; version: unknown }) {
  const calls: string[] = [];
  const persistence: GeneUpsertPersistence = {
    async findByNameProjectTenant(name, project, tenantId) {
      calls.push(`find:${name}:${project}:${tenantId}`);
      return existing;
    },
    async recordMutation(_id, geneId, oldVersion, newVersion, changes) {
      calls.push(`mutation:${geneId}:${oldVersion}:${newVersion}:${changes}`);
    },
    async updateExisting(payload) {
      calls.push(`update:${payload.id}:${payload.version}:${payload.tenantId}`);
    },
    async insertNew(payload) {
      calls.push(`insert:${payload.id}:${payload.project}:${payload.tenantId}:${payload.dependencies}`);
    },
  };
  return { persistence, calls };
}

test("gene upsert use case creates a v1 gene after embedding and scoped lookup", async () => {
  const { persistence, calls } = fakePersistence();
  const order: string[] = [];
  const logs: string[] = [];
  const id = await upsertGene(input, {
    persistence,
    getTenantId() { order.push("tenant"); return "tenant-a"; },
    async generateEmbedding(text) {
      order.push(`embedding:${text}`);
      return [1, 2];
    },
    logInfo: (message) => logs.push(message),
    createId: (prefix) => `${prefix}-fixed`,
  });

  assert.equal(id, "gene-fixed");
  assert.deepEqual(order, ["embedding:problem\n\nsolution", "tenant", "tenant"]);
  assert.deepEqual(calls, ["find:Policy:project-a:tenant-a", "insert:gene-fixed:project-a:tenant-a:[]"]);
  assert.deepEqual(logs, ['[Genome] Gene "Policy" created (v1)']);
});

test("gene upsert use case records mutation before a tenant-scoped version update", async () => {
  const { persistence, calls } = fakePersistence({ id: "gene-old", version: 4 });
  const logs: string[] = [];
  const order: string[] = [];
  const recordMutation = persistence.recordMutation;
  persistence.recordMutation = async (...args) => {
    order.push("mutation");
    return recordMutation(...args);
  };
  const id = await upsertGene(input, {
    persistence,
    getTenantId() { order.push("tenant"); return order.filter((item) => item === "tenant").length === 1 ? "tenant-b" : "tenant-c"; },
    async generateEmbedding() { order.push("embedding"); return null; },
    logInfo: (message) => logs.push(message),
    createId: (prefix) => `${prefix}-fixed`,
  });

  assert.equal(id, "gene-old");
  assert.deepEqual(calls, [
    "find:Policy:project-a:tenant-b",
    'mutation:gene-old:4:5:{"description":"new description","solution":"solution"}',
    "update:gene-old:5:tenant-c",
  ]);
  assert.deepEqual(logs, ['[Genome] Gene "Policy" updated to v5']);
  assert.deepEqual(order, ["embedding", "tenant", "mutation", "tenant"]);
});

test("SQL adapter scopes lookup by project and tenant and update by tenant", async () => {
  const calls: Array<{ sql: string; binds: Record<string, unknown> | unknown[] | undefined }> = [];
  const connection = {
    async execute<T>(sql: string, binds?: Record<string, unknown> | unknown[]) {
      calls.push({ sql, binds });
      return { rows: [["gene-1", 2]] as T[], rowsAffected: 1 };
    },
  } as unknown as AdapterConnection;
  const adapter = new GeneUpsertPersistenceAdapter(connection);
  assert.deepEqual(await adapter.findByNameProjectTenant("Policy", "project-a", "tenant-c"), {
    id: "gene-1", version: 2,
  });
  await adapter.updateExisting({
    id: "gene-1", description: "d", problem: "p", solution: "s", architecture: "", category: "pattern",
    confidence: 0.5, version: 3, embedding: null, tenantId: "tenant-c",
  });

  assert.match(calls[0].sql, /name = :name AND project = :project AND tenant_id = :tenantId/);
  assert.deepEqual(calls[0].binds, { name: "Policy", project: "project-a", tenantId: "tenant-c" });
  assert.match(calls[1].sql, /WHERE id = :id AND tenant_id = :tenantId/);
  assert.equal((calls[1].binds as Record<string, unknown>).tenantId, "tenant-c");
});

test("SQL adapter rejects a null existing row instead of creating a duplicate", async () => {
  const connection = {
    async execute<T>() {
      return { rows: [null] as T[], rowsAffected: 1 };
    },
  } as unknown as AdapterConnection;
  const adapter = new GeneUpsertPersistenceAdapter(connection);
  await assert.rejects(adapter.findByNameProjectTenant("Policy", "project-a", "tenant-c"), TypeError);
});
