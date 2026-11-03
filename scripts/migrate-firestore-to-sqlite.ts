import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Timestamp } from "firebase-admin/firestore";
import { createDatabaseAdapter } from "../src/database/factory.js";
import { hashApiKey } from "../src/utils/apiKey.js";

function toIsoString(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null) {
    const ts = val as Partial<Timestamp> & { _seconds?: number };
    if (typeof ts.toDate === "function") {
      return ts.toDate().toISOString();
    }
    if (typeof ts._seconds === "number") {
      return new Date(ts._seconds * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}

function initFirebaseAdmin(): void {
  if (getApps().length > 0) return;

  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./serviceAccountKey.json";
  const absolutePath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(process.cwd(), serviceAccountPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Firebase service account file not found at: ${absolutePath}`);
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = absolutePath;
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.VITE_FIREBASE_PROJECT_ID || "atlas-intelligence-node",
  });
}

type DatabaseAdapter = ReturnType<typeof createDatabaseAdapter>;

function readTrimmedString(val: unknown): string | null {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function readStringOrFallback(val: unknown, fallback: string): string {
  return readTrimmedString(val) ?? fallback;
}

function resolveIndexingEnabled(val: unknown): number {
  if (typeof val === "boolean") {
    return val ? 1 : 0;
  }
  return 1;
}

async function migrateUserKeyDoc(
  db: DatabaseAdapter,
  uid: string,
  defaultTier: string,
  keyId: string,
  keyData: Record<string, unknown>
): Promise<boolean> {
  const rawKey = typeof keyData.key === "string" ? keyData.key : null;
  const storedHash = typeof keyData.keyHash === "string" ? keyData.keyHash : null;

  if (!rawKey && !storedHash) {
    console.warn(`    ⚠ Skipping key ${keyId} (missing key and keyHash)`);
    return false;
  }

  const keyHash = rawKey ? await hashApiKey(rawKey) : storedHash!;
  const keyName = readStringOrFallback(keyData.name, `Migrated Key ${keyId}`);
  const keyTier = readStringOrFallback(keyData.tier, defaultTier);
  const createdAt = toIsoString(keyData.createdAt);
  const keyUpdatedAt = keyData.lastUsed ? toIsoString(keyData.lastUsed) : createdAt;

  await db.execute(
    `INSERT INTO keys (id, tenant_id, user_id, name, key_hash, tier, created_at, updated_at)
     VALUES (:id, :tenantId, :userId, :name, :keyHash, :tier, :createdAt, :updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       user_id = excluded.user_id,
       name = excluded.name,
       key_hash = excluded.key_hash,
       tier = excluded.tier,
       updated_at = excluded.updated_at`,
    {
      id: keyId,
      tenantId: uid,
      userId: uid,
      name: keyName,
      keyHash,
      tier: keyTier,
      createdAt,
      updatedAt: keyUpdatedAt,
    }
  );
  console.log(`    ✓ API Key migrated: ${keyId} (${keyName}, tier=${keyTier})`);
  return true;
}

async function migrateSingleUserDoc(
  db: DatabaseAdapter,
  userDoc: FirebaseFirestore.QueryDocumentSnapshot
): Promise<{ isAdminCandidate: boolean; uid: string; keysMigrated: number }> {
  const uid = userDoc.id;
  const data = userDoc.data() || {};
  const email = readTrimmedString(data.email);
  const displayName = readStringOrFallback(data.displayName, uid);
  const role = readStringOrFallback(data.role, "user");
  const tier = readStringOrFallback(data.tier, "free");
  const updatedAt = toIsoString(data.updatedAt || data.stats?.lastActivity);
  const isAdminCandidate = role === "admin" && uid !== "admin" && uid !== "account1_admin";

  await db.execute(
    `INSERT INTO tenants (id, name, description, tier, updated_at)
     VALUES (:id, :name, :description, :tier, :updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       tier = excluded.tier,
       updated_at = excluded.updated_at`,
    {
      id: uid,
      name: displayName,
      description: email ? `Migrated from Firestore (${email})` : "Migrated from Firestore",
      tier,
      updatedAt,
    }
  );

  await db.execute(
    `INSERT INTO users (id, tenant_id, email, name, role, tier, updated_at)
     VALUES (:id, :tenantId, :email, :name, :role, :tier, :updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       email = COALESCE(excluded.email, users.email),
       name = excluded.name,
       role = excluded.role,
       tier = excluded.tier,
       updated_at = excluded.updated_at`,
    {
      id: uid,
      tenantId: uid,
      email,
      name: displayName,
      role,
      tier,
      updatedAt,
    }
  );
  console.log(`  ✓ User migrated: ${uid} (${email || "no-email"}, role=${role}, tier=${tier})`);

  const keysSnapshot = await userDoc.ref.collection("keys").get(); // NOSONAR
  const keyResults = await Promise.all(
    keysSnapshot.docs.map((keyDoc) =>
      migrateUserKeyDoc(db, uid, tier, keyDoc.id, keyDoc.data() || {})
    )
  );
  const keysMigrated = keyResults.filter(Boolean).length;

  return { isAdminCandidate, uid, keysMigrated };
}

async function registerEnvAdminKeyIfNeeded(
  db: DatabaseAdapter,
  primaryAdminUid: string | null
): Promise<number> {
  const envApiKey = process.env.CODEATLAS_API_KEY?.trim();
  if (!envApiKey || envApiKey === "your_api_key") {
    return 0;
  }

  const targetUid = primaryAdminUid || "admin";
  await db.execute(
    `INSERT OR IGNORE INTO tenants (id, name, tier) VALUES (:id, :name, 'enterprise')`,
    { id: targetUid, name: targetUid }
  );
  await db.execute(
    `INSERT OR IGNORE INTO users (id, tenant_id, name, role, tier)
     VALUES (:id, :tenantId, :name, 'admin', 'enterprise')`,
    { id: targetUid, tenantId: targetUid, name: targetUid }
  );
  const envKeyHash = await hashApiKey(envApiKey);
  const existingEnvKey = await db.query<{ id: string }>(
    `SELECT id FROM keys WHERE key_hash = :keyHash LIMIT 1`,
    { keyHash: envKeyHash }
  );
  if (existingEnvKey.length > 0) {
    return 0;
  }

  await db.execute(
    `INSERT INTO keys (id, tenant_id, user_id, name, key_hash, tier)
     VALUES (:id, :tenantId, :userId, :name, :keyHash, 'enterprise')`,
    {
      id: "env-admin-key",
      tenantId: targetUid,
      userId: targetUid,
      name: "Environment Admin Key (.env)",
      keyHash: envKeyHash,
    }
  );
  console.log(`  ✓ Registered active .env CODEATLAS_API_KEY for user: ${targetUid}`);
  return 1;
}

async function migrateSingleProjectDoc(
  db: DatabaseAdapter,
  projDoc: FirebaseFirestore.QueryDocumentSnapshot,
  defaultTenantId: string
): Promise<void> {
  const docId = projDoc.id;
  const pData = projDoc.data() || {};
  const name = readStringOrFallback(pData.name, docId);
  const tenantId = readStringOrFallback(pData.tenantId, defaultTenantId);
  const projPath = typeof pData.path === "string" ? pData.path : null;
  const status = typeof pData.status === "string" ? pData.status : "synced";
  const nodesCount = typeof pData.nodesCount === "number" ? pData.nodesCount : 0;
  const linksCount = typeof pData.linksCount === "number" ? pData.linksCount : 0;
  const lastIndexed = pData.lastIndexed ? toIsoString(pData.lastIndexed) : null;
  const statsJson = JSON.stringify(pData.stats || {});
  const indexingEnabled = resolveIndexingEnabled(pData.indexingEnabled);
  const updatedAt = toIsoString(pData.updatedAt || pData.lastIndexed);

  await db.execute(
    `INSERT OR IGNORE INTO tenants (id, name, description, tier)
     VALUES (:id, :name, 'Migrated project tenant from Firestore', 'free')`,
    { id: tenantId, name: tenantId }
  );

  await db.execute(
    `INSERT INTO projects (
       id, tenant_id, name, path, status, nodes_count, links_count,
       last_indexed, stats_json, indexing_enabled, updated_at
     )
     VALUES (
       :id, :tenantId, :name, :path, :status, :nodesCount, :linksCount,
       :lastIndexed, :statsJson, :indexingEnabled, :updatedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       name = excluded.name,
       path = COALESCE(excluded.path, projects.path),
       status = excluded.status,
       nodes_count = excluded.nodes_count,
       links_count = excluded.links_count,
       last_indexed = COALESCE(excluded.last_indexed, projects.last_indexed),
       stats_json = excluded.stats_json,
       indexing_enabled = excluded.indexing_enabled,
       updated_at = excluded.updated_at`,
    {
      id: docId,
      tenantId,
      name,
      path: projPath,
      status,
      nodesCount,
      linksCount,
      lastIndexed,
      statsJson,
      indexingEnabled,
      updatedAt,
    }
  );
  console.log(`  ✓ Project migrated: ${docId} (tenant=${tenantId}, nodes=${nodesCount})`);
}

export async function migrateFirestoreToSqlite(): Promise<void> {
  initFirebaseAdmin();
  const firestore = getFirestore();
  const db = createDatabaseAdapter();
  await db.connect();
  if (typeof (db as { initializeSchema?: () => Promise<void> }).initializeSchema === "function") {
    await (db as { initializeSchema: () => Promise<void> }).initializeSchema();
  }

  try {
    console.log("\n=== 1. Migrating Firestore Users & API Keys to SQLite ===");
    const usersSnapshot = await firestore.collection("users").get();
    const userResults = await Promise.all(
      usersSnapshot.docs.map((userDoc) => migrateSingleUserDoc(db, userDoc))
    );

    const tenantsCount = userResults.length;
    const usersCount = userResults.length;
    const primaryAdminUid = userResults.find((r) => r.isAdminCandidate)?.uid ?? null;
    let keysCount = userResults.reduce((sum, r) => sum + r.keysMigrated, 0);

    keysCount += await registerEnvAdminKeyIfNeeded(db, primaryAdminUid);

    console.log("\n=== 2. Migrating Firestore Projects to SQLite ===");
    const projectsSnapshot = await firestore.collection("projects").get();
    const defaultTenantId = primaryAdminUid || "admin";
    await Promise.all(
      projectsSnapshot.docs.map((projDoc) =>
        migrateSingleProjectDoc(db, projDoc, defaultTenantId)
      )
    );
    const projectsCount = projectsSnapshot.docs.length;

    console.log("\n=== Migration Summary ===");
    console.log(`  Tenants migrated : ${tenantsCount}`);
    console.log(`  Users migrated   : ${usersCount}`);
    console.log(`  API Keys migrated: ${keysCount}`);
    console.log(`  Projects migrated: ${projectsCount}`);
    console.log("✔ Firestore-to-SQLite migration completed successfully!\n");
  } finally {
    await db.disconnect();
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-firestore-to-sqlite.ts") ||
    process.argv[1].endsWith("migrate-firestore-to-sqlite.js"));

if (isDirectRun) {
  try {
    await migrateFirestoreToSqlite();
  } catch (err: unknown) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}
