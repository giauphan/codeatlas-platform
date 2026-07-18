import express from "express";
import { logger } from "../utils/logger.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { authMiddleware } from "../middleware/auth.js";

const SETTINGS_PATH = process.env.CRON_SETTINGS_PATH || join(process.env.HOME || "/home/ubuntu", ".hermes", "cron-settings.json");

interface CronSettings {
  dreams_schedule: string; // cron expression, e.g. "0 19 * * *"
  dreams_enabled: boolean;
  updated_at: string;
}

function defaultSettings(): CronSettings {
  return {
    dreams_schedule: "0 19 * * *",
    dreams_enabled: true,
    updated_at: new Date().toISOString(),
  };
}

async function loadSettings(): Promise<CronSettings> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn("[CronSettings] Failed to load, using defaults:", err);
    }
  }
  return defaultSettings();
}

async function saveSettings(s: CronSettings): Promise<void> {
  const dir = dirname(SETTINGS_PATH);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  s.updated_at = new Date().toISOString();
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export function mountCronSettingsRoutes(app: express.Application): void {
  // GET /api/settings/cron — read current schedule
  app.get("/api/settings/cron", authMiddleware, async (_req, res, next) => {
    try {
      res.json(await loadSettings());
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/settings/cron — update schedule; validates 5-field cron expression
  app.put("/api/settings/cron", authMiddleware, async (req, res, next) => {
    try {
      const { dreams_schedule, dreams_enabled } = req.body as {
        dreams_schedule?: string;
        dreams_enabled?: boolean;
      };
      const current = await loadSettings();
      if (dreams_schedule !== undefined) {
        // Basic cron validation: must have 5 fields
        const parts = dreams_schedule.trim().split(/\s+/);
        if (parts.length !== 5) {
          return res.status(400).json({ error: "Invalid cron expression — must have exactly 5 fields" });
        }
        current.dreams_schedule = dreams_schedule.trim();
      }
      if (dreams_enabled !== undefined) {
        current.dreams_enabled = Boolean(dreams_enabled);
      }
      await saveSettings(current);
      logger.info(`[CronSettings] Updated: schedule=${current.dreams_schedule}, enabled=${current.dreams_enabled}`);
      res.json({ success: true, settings: current });
    } catch (err) {
      next(err);
    }
  });
}
