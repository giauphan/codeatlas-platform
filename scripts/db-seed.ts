#!/usr/bin/env ts-node
// scripts/db-seed.ts
import "dotenv/config";
import { createDatabaseAdapter } from "../src/database/factory";
import { randomUUID } from "node:crypto";
import { logger } from "../src/utils/logger";

async function seed() {
  const db = createDatabaseAdapter();
  await db.connect();

  try {
    // Initialize schema (idempotent)
    await db.initializeSchema();

    // Get tenant ID from env (fallback to 'admin')
    const tenantId = process.env.CODEATLAS_TENANT_ID || "admin";

    // 1. Seed Tenant (if not exists)
    const tenantExists = await db.query(
      "SELECT 1 FROM tenants WHERE id = ?",
      [tenantId]
    );
    if (tenantExists.length === 0) {
      await db.execute(
        "INSERT INTO tenants (id, name, tier) VALUES (?, ?, ?)",
        [tenantId, "System Admin", "enterprise"]
      );
      logger.info(`[Seeder] Created tenant: ${tenantId}`);
    }

    // 2. Seed API Key (if not exists)
    const apiKey = process.env.CODEATLAS_API_KEY || `sk-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    const keyHash = ""; // Will be computed by auth service
    const keyExists = await db.query(
      "SELECT 1 FROM users WHERE id = ? AND EXISTS (SELECT 1 FROM keys WHERE user_id = ? AND key = ?)",
      [tenantId, tenantId, apiKey]
    );
    if (keyExists.length === 0) {
      await db.execute(
        "INSERT INTO users (id, tenant_id, tier) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        [tenantId, tenantId, "enterprise"]
      );
      await db.execute(
        "INSERT INTO keys (id, tenant_id, user_id, key, key_hash, tier) VALUES (?, ?, ?, ?, ?, ?)",
        [randomUUID(), tenantId, tenantId, apiKey, keyHash, "enterprise"]
      );
      logger.info(`[Seeder] Created API key for tenant: ${tenantId}`);
    }

    // 3. Seed Sample Project
    const projectId = "codeatlas";
    const projectExists = await db.query(
      "SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?",
      [projectId, tenantId]
    );
    if (projectExists.length === 0) {
      await db.execute(
        "INSERT INTO projects (id, name, description, tenant_id) VALUES (?, ?, ?, ?)",
        [projectId, "CodeAtlas Platform", "AI-powered codebase intelligence platform", tenantId]
      );
      logger.info(`[Seeder] Created project: ${projectId}`);
    }

    // 4. Seed Sample Dream Memories
    const dreams = [
      {
        id: randomUUID(),
        session_id: randomUUID(),
        project: projectId,
        memory_type: "SESSION_SUMMARY",
        content: "Implemented database abstraction layer to support SQLite and Postgres alongside Oracle.",
        content_hash: "a1b2c3d4e5f6",
        importance: 0.9,
        confidence: 0.95,
        status: "active",
        scope: "database",
        tags: JSON.stringify(["refactor", "multi-db"]),
        tenant_id: tenantId
      },
      {
        id: randomUUID(),
        session_id: randomUUID(),
        project: projectId,
        memory_type: "SESSION_SUMMARY",
        content: "Fixed CI pipeline by regenerating pnpm-lock.yaml with pnpm@9 to match CI environment.",
        content_hash: "f6e5d4c3b2a1",
        importance: 0.8,
        confidence: 0.9,
        status: "active",
        scope: "ci",
        tags: JSON.stringify(["ci", "pnpm"]),
        tenant_id: tenantId
      }
    ];

    for (const dream of dreams) {
      const exists = await db.query(
        "SELECT 1 FROM ai_dreaming_memory WHERE id = ?",
        [dream.id]
      );
      if (exists.length === 0) {
        await db.execute(
          `INSERT INTO ai_dreaming_memory (
            id, session_id, project, memory_type, content, content_hash,
            importance, confidence, status, scope, tags, tenant_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
          [
            dream.id, dream.session_id, dream.project, dream.memory_type, dream.content,
            dream.content_hash, dream.importance, dream.confidence, dream.status,
            dream.scope, dream.tags, dream.tenant_id
          ]
        );
      }
    }
    logger.info(`[Seeder] Created ${dreams.length} sample dream memories`);

    // 5. Seed Sample Genome Entries
    const genomes = [
      {
        id: randomUUID(),
        name: "Database Abstraction Layer",
        description: "Multi-DB adapter pattern to support Oracle, SQLite, and Postgres.",
        problem: "Hard coupling to Oracle 26ai makes local development impossible.",
        solution: "Implemented IDatabaseAdapter interface with OracleAdapter and SQLiteAdapter.",
        architecture: "Adapter pattern with factory for runtime DB selection.",
        category: "refactor",
        project: projectId,
        confidence: 0.95,
        status: "active",
        tenant_id: tenantId
      },
      {
        id: randomUUID(),
        name: "CI Pipeline Fix",
        description: "Fixed pnpm-lock.yaml compatibility with CI environment.",
        problem: "CI fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH due to pnpm version mismatch.",
        solution: "Regenerated lockfile with pnpm@9 to match CI environment.",
        architecture: "CI uses pnpm@9 via corepack, local uses pnpm@11.",
        category: "ci",
        project: projectId,
        confidence: 0.9,
        status: "active",
        tenant_id: tenantId
      }
    ];

    for (const genome of genomes) {
      const exists = await db.query(
        "SELECT 1 FROM codeatlas_genome WHERE id = ?",
        [genome.id]
      );
      if (exists.length === 0) {
        await db.execute(
          `INSERT INTO codeatlas_genome (
            id, name, description, problem, solution, architecture,
            category, project, confidence, status, tenant_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
          [
            genome.id, genome.name, genome.description, genome.problem, genome.solution,
            genome.architecture, genome.category, genome.project, genome.confidence,
            genome.status, genome.tenant_id
          ]
        );
      }
    }
    logger.info(`[Seeder] Created ${genomes.length} sample genome entries`);

    // 6. Seed Sample Semantic Memory
    const semanticMemories = [
      {
        id: randomUUID(),
        project_name: projectId,
        entity_type: "function",
        entity_name: "createDatabaseAdapter",
        file_path: "src/database/factory.ts",
        content: "Factory function to create database adapter based on CODEATLAS_DB_TYPE env var.",
        tenant_id: tenantId
      },
      {
        id: randomUUID(),
        project_name: projectId,
        entity_type: "interface",
        entity_name: "IDatabaseAdapter",
        file_path: "src/database/adapters/interface.ts",
        content: "Database adapter interface for multi-DB support (Oracle, SQLite, Postgres).",
        tenant_id: tenantId
      }
    ];

    for (const memory of semanticMemories) {
      const exists = await db.query(
        "SELECT 1 FROM ai_semantic_memory WHERE id = ?",
        [memory.id]
      );
      if (exists.length === 0) {
        await db.execute(
          `INSERT INTO ai_semantic_memory (
            id, project_name, entity_type, entity_name, file_path, content, tenant_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?
          )`,
          [
            memory.id, memory.project_name, memory.entity_type, memory.entity_name,
            memory.file_path, memory.content, memory.tenant_id
          ]
        );
      }
    }
    logger.info(`[Seeder] Created ${semanticMemories.length} sample semantic memories`);

    // 7. Seed Sample Relational Memory
    const relationalMemories = [
      {
        source_id: semanticMemories[0].id,
        target_id: semanticMemories[1].id,
        project_name: projectId,
        relationship_type: "uses",
        tenant_id: tenantId
      }
    ];

    for (const rel of relationalMemories) {
      const exists = await db.query(
        "SELECT 1 FROM ai_relational_memory WHERE source_id = ? AND target_id = ? AND project_name = ?",
        [rel.source_id, rel.target_id, rel.project_name]
      );
      if (exists.length === 0) {
        await db.execute(
          `INSERT INTO ai_relational_memory (
            source_id, target_id, project_name, relationship_type, tenant_id
          ) VALUES (
            ?, ?, ?, ?, ?
          )`,
          [rel.source_id, rel.target_id, rel.project_name, rel.relationship_type, rel.tenant_id]
        );
      }
    }
    logger.info(`[Seeder] Created ${relationalMemories.length} sample relational memories`);

    logger.info("✅ Seeder completed successfully");
  } catch (err) {
    logger.error("❌ Seeder failed:", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await db.disconnect();
  }
}

seed().catch(err => {
  logger.error("Seeder error:", err);
  process.exit(1);
});
