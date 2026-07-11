/**
 * AI Second Brain Routes — feedback & context injection
 */
import express from "express";
import { secondBrain, type TaskOutcome } from "../services/secondBrainService.js";
import { authMiddleware } from "../services/authService.js";
import { logger } from "../utils/logger.js";

export function mountSecondBrainRoutes(app: express.Application): void {
  // POST /api/memory/outcome — Record task outcome
  app.post("/api/memory/outcome", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const outcome = req.body as TaskOutcome;
      if (!outcome.task || !outcome.result) {
        res.status(400).json({ error: "task and result are required" });
        return;
      }
      const dreamId = await secondBrain.recordOutcome(outcome);
      res.status(201).json({ success: true, dreamId });
    } catch (err) {
      logger.error(`[SecondBrain] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/memory/inject — Build context block from relevant memories
  app.post("/api/memory/inject", authMiddleware, async (req: express.Request, res: express.Response) => {
    try {
      const { task, project, limit } = req.body as {
        task: string;
        project?: string;
        limit?: number;
      };
      if (!task) {
        res.status(400).json({ error: "task is required" });
        return;
      }
      const injected = await secondBrain.buildContext(task, project, limit);
      res.json(injected);
    } catch (err) {
      logger.error(`[SecondBrain] ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });
}
