/**
 * Consolidation Engine — AI Second Brain
 *
 * Deduplicates similar dreams, extracts concepts, updates knowledge base.
 * Designed to run both on-demand (API) and as a nightly cron job.
 */

import { randomUUID } from "node:crypto";
import { initPool, setSessionContext } from "../database/connection.js";
import { generateEmbedding } from "./embeddingService.js";
import { logger } from "../utils/logger.js";

export interface ConsolidationJob {
  project?: string;
  operations: ("dedup" | "extract_concepts" | "score")[];
}

export interface ConsolidationReport {
  id: string;
  jobType: string;
  dreamsProcessed: number;
  dreamsMerged: number;
  conceptsCreated: number;
  errors: string[];
}

export class ConsolidationEngine {
  /**
   * Run a consolidation job.
   */
  async run(job: ConsolidationJob): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      id: randomUUID(),
      jobType: "consolidation",
      dreamsProcessed: 0,
      dreamsMerged: 0,
      conceptsCreated: 0,
      errors: [],
    };

    for (const op of job.operations) {
      try {
        switch (op) {
          case "dedup":
            await this.dedupDreams(job.project, report);
            break;
          case "extract_concepts":
            await this.extractConcepts(job.project, report);
            break;
          case "score":
            await this.scoreRelevance(report);
            break;
        }
      } catch (err) {
        report.errors.push(`[${op}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info(
      `[Consolidation] Done: ${report.dreamsMerged} merged, ${report.conceptsCreated} concepts created`
    );
    return report;
  }

  /**
   * Find and merge duplicate dreams (cosine similarity > 0.85).
   * Keeps the dream with higher importance, merges metadata.
   */
  private async dedupDreams(project?: string, report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const whereClause = project ? "WHERE project = :project" : "";
      const binds = project ? { project } : {};

      // Get all non-consolidated dreams sorted by importance DESC
      const dreams = await connection.execute<any[]>(
        `SELECT id, content, embedding, importance, memory_type, project
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );
      const rows = dreams.rows || [];
      report!.dreamsProcessed = rows.length;

      if (rows.length < 2) {
        logger.info(`[Consolidation] Only ${rows.length} dreams — skipping dedup`);
        return;
      }

      // Group by project to avoid cross-project false positives
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(row.project || "default");
        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let merged = 0;
      for (const [, group] of byProject) {
        const toRemove: string[] = [];

        for (let i = 0; i < group.length; i++) {
          if (toRemove.includes(String(group[i].ID))) continue;

          for (let j = i + 1; j < group.length; j++) {
            if (toRemove.includes(String(group[j].ID))) continue;

            // Cosine similarity on embeddings (both must exist)
            const embI = group[i].EMBEDDING;
            const embJ = group[j].EMBEDDING;
            if (!embI || !embJ) continue;

            const similarity = this.cosineSimilarity(
              embI instanceof Float32Array ? Array.from(embI) : [],
              embJ instanceof Float32Array ? Array.from(embJ) : []
            );

            if (similarity > 0.85) {
              // Merge: keep the one with higher importance
              const keepIdx = Number(group[i].IMPORTANCE) >= Number(group[j].IMPORTANCE) ? i : j;
              const removeIdx = keepIdx === i ? j : i;
              toRemove.push(String(group[removeIdx].ID));
            }
          }
        }

        // Delete duplicates
        for (const id of toRemove) {
          try {
            await connection.execute(
              `DELETE FROM ai_dreaming_memory WHERE id = :id`,
              { id } as any,
              { autoCommit: true }
            );
            merged++;
          } catch {
            // skip delete errors
          }
        }
      }

      report!.dreamsMerged = merged;
      logger.info(`[Consolidation] Dedup: removed ${merged} duplicate dreams`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Extract abstract concepts from dream clusters.
   * For each project, groups related dreams and generates concept entries.
   */
  private async extractConcepts(project?: string, report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const whereClause = project ? "WHERE project = :project" : "";
      const binds = project ? { project } : {};

      const dreams = await connection.execute<any[]>(
        `SELECT id, content, memory_type, project, importance
         FROM ai_dreaming_memory ${whereClause}
         ORDER BY importance DESC`,
        binds as any
      );
      const rows = dreams.rows || [];

      if (rows.length === 0) return;

      // Group by project for concept extraction
      const byProject = new Map<string, any[]>();
      for (const row of rows) {
        const proj = String(row.PROJECT || "default");
        if (!byProject.has(proj)) byProject.set(proj, []);
        byProject.get(proj)!.push(row);
      }

      let conceptsCreated = 0;

      for (const [proj, group] of byProject) {
        // Take top 10 highest-importance dreams per project for concept extraction
        const topDreams = group.slice(0, 10);
        const combinedContent = topDreams
          .map((d) => `[${d.MEMORY_TYPE}] ${d.CONTENT}`)
          .join("\n\n");

        // Generate a concept label and description from the content
        // In production, this would use an LLM call. For MVP, use content-based heuristics.
        const conceptLabel = this.extractLabel(topDreams);
        const conceptDescription = combinedContent.slice(0, 1000);
        const conceptEmbedding = await generateEmbedding(conceptDescription, "passage");

        if (!conceptEmbedding || conceptEmbedding.length === 0) {
          logger.warn(`[Consolidation] No embedding for concept "${conceptLabel}", skipping`);
          continue;
        }

        // Check if concept already exists for this project
        const existing = await connection.execute<any[]>(
          `SELECT id FROM codeatlas_concepts WHERE label = :label AND project = :proj`,
          { label: conceptLabel, proj } as any
        );

        if (existing.rows && existing.rows.length > 0) {
          // Update existing concept
          await connection.execute(
            `UPDATE codeatlas_concepts
             SET description = :desc,
                 evidence_count = evidence_count + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE label = :label AND project = :proj`,
            { label: conceptLabel, proj, desc: conceptDescription } as any,
            { autoCommit: true }
          );
        } else {
          // Insert new concept
          const conceptId = `concept-${randomUUID().slice(0, 8)}`;
          await connection.execute(
            `INSERT INTO codeatlas_concepts (id, label, description, category, embedding, project, confidence, source_ids, evidence_count, status)
             VALUES (:id, :label, :desc, 'lesson', :embedding, :proj, 0.50, :sources, 1, 'active')`,
            {
              id: conceptId,
              label: conceptLabel,
              desc: conceptDescription,
              embedding: new Float32Array(conceptEmbedding),
              proj,
              sources: JSON.stringify(topDreams.map((d) => d.ID)),
            } as any,
            { autoCommit: true }
          );
          conceptsCreated++;
        }
      }

      report!.conceptsCreated = conceptsCreated;
      logger.info(`[Consolidation] Extracted ${conceptsCreated} concepts`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Score relevance — decay importance of old unused concepts.
   */
  private async scoreRelevance(report?: ConsolidationReport): Promise<void> {
    let connection;
    try {
      const pool = await initPool();
      connection = await pool.getConnection();
      await setSessionContext(connection);

      const result = await connection.execute(
        `UPDATE codeatlas_concepts
         SET confidence = confidence * 0.97
         WHERE status = 'active' AND access_count < 2 AND updated_at < (CURRENT_TIMESTAMP - INTERVAL '30' DAY)`,
        [],
        { autoCommit: true }
      );
      const updated = result.rowsAffected || 0;

      // Archive very low confidence
      await connection.execute(
        `UPDATE codeatlas_concepts
         SET status = 'archived'
         WHERE confidence < 0.15 AND status = 'active'`,
        [],
        { autoCommit: true }
      );

      logger.info(`[Consolidation] Decay: ${updated} concepts scored`);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Cosine similarity between two float vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Extract a concept label from the top dreams of a cluster.
   * Prioritizes PATTERN and KNOWLEDGE types, then most common memory_type.
   */
  private extractLabel(dreams: any[]): string {
    // Try to find a PATTERN or KNOWLEDGE dream with the most descriptive content
    for (const type of ["PATTERN", "KNOWLEDGE", "MISTAKE"]) {
      const match = dreams.find((d) => d.MEMORY_TYPE === type);
      if (match) {
        const content = String(match.CONTENT || "");
        return content.length > 80 ? content.slice(0, 80) : content;
      }
    }
    // Fallback: use first dream's beginning
    const first = String(dreams[0]?.CONTENT || "Untitled Concept");
    return first.length > 80 ? first.slice(0, 80) : first;
  }
}

export const consolidationEngine = new ConsolidationEngine();
