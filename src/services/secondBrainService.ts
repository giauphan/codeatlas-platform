/**
 * AI Second Brain — Feedback & Context System
 */

import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { OracleDreamingService } from "./dreamingService.js";

export interface TaskOutcome {
  task: string;
  result: "success" | "failure" | "partial" | "aborted";
  project?: string;
  learnings?: string[];
  dreamIds?: string[];
}

export interface InjectedContext {
  context: string;
  sources: { type: string; id: string; score: number }[];
}

export class SecondBrainService {
  /**
   * Record task outcome as FEEDBACK dream memory.
   */
  async recordOutcome(outcome: TaskOutcome): Promise<string> {
    const dreamId = await OracleDreamingService.saveDreamMemory(
      outcome.project || "default",
      randomUUID(),
      "FEEDBACK",
      JSON.stringify({
        task: outcome.task,
        result: outcome.result,
        learnings: outcome.learnings || [],
        timestamp: new Date().toISOString(),
      }),
      outcome.result === "failure" ? 10 : outcome.result === "success" ? 5 : 3
    );
    logger.info(`[SecondBrain] Outcome: ${outcome.task} → ${outcome.result}`);
    return dreamId;
  }

  /**
   * Build injected context block from relevant dreams.
   */
  async buildContext(task: string, project?: string, limit: number = 5): Promise<InjectedContext> {
    try {
      const projectName = project || "default";
      const dreams = await OracleDreamingService.queryDreamMemories(
        projectName,
        task,
        limit
      );
      const sources: { type: string; id: string; score: number }[] = [];
      const parts: string[] = [];

      for (const d of dreams || []) {
        const dream = d as any;
        const score = dream.score || dream.importance / 10 || 0.5;
        sources.push({ type: dream.memoryType || "DREAM", id: dream.id, score });
        parts.push(`[${dream.memoryType || "DREAM"} | score: ${score.toFixed(2)}] ${dream.content}`);
      }

      return {
        context: parts.join("\n\n"),
        sources,
      };
    } catch (err) {
      logger.warn(`[SecondBrain] Context injection failed: ${err}`);
      return { context: "", sources: [] };
    }
  }
}

export const secondBrain = new SecondBrainService();
