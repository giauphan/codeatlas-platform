/**
 * Direct dimension fix: truncates 4096-dim (16384 bytes) embeddings to 1024-dim (4096 bytes).
 *
 * Uses the underlying ArrayBuffer to correctly slice the first 1024 floats.
 * No API calls needed - pure byte manipulation.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';

const targetDim = Number(process.env.EMBEDDING_DIM ?? 1024);
const expectedBytes = targetDim * 4;
const dbPath = process.env.CODEATLAS_SQLITE_PATH || './data/codeatlas.db';
const db = new Database(dbPath);
const tables = ['ai_dreaming_memory', 'codeatlas_genome', 'ai_semantic_memory', 'codeatlas_concepts'];

let totalFixed = 0;
let totalSkipped = 0;

for (const table of tables) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) {
    console.log(`[Fix] ${table}: does not exist, skipping.`);
    continue;
  }

  // Find rows with 16384 bytes (4096-dim)
  const badRows = db.prepare(`SELECT id, embedding FROM ${table} WHERE length(embedding) = 16384`).all() as Array<{ id: string; embedding: Buffer }>;

  if (badRows.length === 0) {
    console.log(`[Fix] ${table}: no 4096-dim rows.`);
    continue;
  }

  console.log(`[Fix] ${table}: found ${badRows.length} 4096-dim rows to truncate to 1024-dim.`);

  const updateStmt = db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`);
  const verifyStmt = db.prepare(`SELECT length(embedding) as new_bytes FROM ${table} WHERE id = ?`);

  let totalFailed = 0;

  for (const { id, embedding: blob } of badRows) {
    if (!blob || blob.byteLength !== 16384) {
      console.log(`[Fix] ${table}/${id}: skipping row — embedding blob byteLength is ${blob?.byteLength ?? 'null'}, expected 16384 (4096-dim). Possible NULL, empty, or already correct-dimension row.`);
      totalSkipped++;
      continue;
    }

    try {
      // Extract first 1024 floats using the underlying buffer
      const truncated = new Float32Array(blob.buffer, blob.byteOffset, targetDim);

      // Verify it's valid
      if (truncated.length !== targetDim) {
        console.error(`[Fix] ${table}/${id}: truncation failed, got ${truncated.length} dims.`);
        totalSkipped++;
        continue;
      }

      // Convert to Buffer for SQLite
      const buffer = Buffer.from(truncated.buffer, truncated.byteOffset, expectedBytes);
      updateStmt.run(buffer, id);

      // Verify
      const verified = verifyStmt.get(id) as { new_bytes: number };
      if (verified.new_bytes === expectedBytes) {
        console.log(`[Fix] ${table}/${id}: 16384 -> ${verified.new_bytes} bytes`);
        totalFixed++;
      } else {
        console.error(`[Fix] ${table}/${id}: verification failed, expected ${expectedBytes}, got ${verified.new_bytes}`);
      }
    } catch (err) {
      console.error(`[Fix] ${table}/${id}: SQL/truncation error — ${(err as Error).message}`);
      totalFailed++;
    }
  }

  console.log(`[Fix] ${table}: done — fixed=${totalFixed}, skipped=${totalSkipped}, failed=${totalFailed}`);
}

console.log(`\n[Fix] Done. Fixed: ${totalFixed}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
db.close();
