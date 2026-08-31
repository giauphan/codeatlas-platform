/**
 * Re-embed migration script with detailed logging and verification.
 *
 * Fixes rows whose embedding BLOB length doesn't match EMBEDDING_DIM * 4.
 * Logs before/after byte size for every row to confirm the update took effect.
 *
 * Usage:
 *   npx tsx scripts/reembed-migrate.ts --dry-run
 *   npx tsx scripts/reembed-migrate.ts
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { generateEmbedding } from '../src/services/embeddingService.js';

const dryRun = process.argv.includes('--dry-run');
const targetDim = Number(process.env.EMBEDDING_DIM ?? process.env.NVIDIA_EMBEDDING_DIM) || 1024;
const expectedBytes = targetDim * 4;

const dbPath = process.env.CODEATLAS_SQLITE_PATH || './data/codeatlas.db';
console.log(`[Reembed] DB: ${dbPath}, target dim: ${targetDim} (${expectedBytes} bytes), dry-run: ${dryRun}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const TABLES = [
  { table: 'ai_dreaming_memory', contentCol: 'content', idCol: 'id' },
  { table: 'codeatlas_genome', contentCol: "COALESCE(problem, name, description)", idCol: 'id' },
  { table: 'ai_semantic_memory', contentCol: 'content', idCol: 'id' },
  { table: 'codeatlas_concepts', contentCol: "COALESCE(description, label)", idCol: 'id' },
];

let totalFixed = 0;
let totalSkipped = 0;
let totalFailed = 0;

for (const { table, contentCol, idCol } of TABLES) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) {
    console.log(`[Reembed] ${table}: does not exist, skipping.`);
    continue;
  }

  const badRows = db.prepare(
    `SELECT ${idCol} as id, ${contentCol} as content, length(embedding) as old_bytes FROM ${table} WHERE embedding IS NOT NULL AND length(embedding) != ?`
  ).all(expectedBytes) as Array<{ id: string; content: string; old_bytes: number }>;

  if (badRows.length === 0) {
    console.log(`[Reembed] ${table}: no mismatched rows.`);
    continue;
  }

  console.log(`[Reembed] ${table}: found ${badRows.length} mismatched rows.`);

  const updateStmt = db.prepare(`UPDATE ${table} SET embedding = ? WHERE ${idCol} = ?`);
  const verifyStmt = db.prepare(`SELECT length(embedding) as new_bytes FROM ${table} WHERE ${idCol} = ?`);

  for (const row of badRows) {
    if (!row.content?.trim()) {
      console.log(`[Reembed] ${table}/${row.id}: empty content, nullifying.`);
      if (!dryRun) updateStmt.run(null, row.id);
      totalSkipped++;
      continue;
    }

    try {
      const embedding = await generateEmbedding(row.content, 'passage');
      if (!embedding || embedding.length !== targetDim) {
        console.error(`[Reembed] ${table}/${row.id}: embedding returned null or wrong dim (${embedding?.length}).`);
        totalFailed++;
        continue;
      }

      const blob = Buffer.from(new Float32Array(embedding).buffer);

      if (dryRun) {
        console.log(`[Reembed] DRY-RUN ${table}/${row.id}: ${row.old_bytes} -> ${blob.byteLength} bytes`);
        totalFixed++;
      } else {
        updateStmt.run(blob, row.id);
        // Verify the write actually took effect
        const verified = verifyStmt.get(row.id) as { new_bytes: number };
        if (verified.new_bytes === expectedBytes) {
          console.log(`[Reembed] OK ${table}/${row.id}: ${row.old_bytes} -> ${verified.new_bytes} bytes`);
          totalFixed++;
        } else {
          console.error(`[Reembed] FAIL ${table}/${row.id}: wrote ${blob.byteLength} but read back ${verified.new_bytes} bytes!`);
          totalFailed++;
        }
      }
    } catch (err) {
      console.error(`[Reembed] ERROR ${table}/${row.id}:`, err);
      totalFailed++;
    }
  }
}

console.log(`\n[Reembed] Done. Fixed: ${totalFixed}, Skipped (empty): ${totalSkipped}, Failed: ${totalFailed}`);
db.close();
