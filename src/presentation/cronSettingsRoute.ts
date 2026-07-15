import express from "express";
import { logger } from "../utils/logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

function loadSettings(): CronSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch (err) {
    logger.warn("[CronSettings] Failed to load, using defaults:", err);
  }
  return defaultSettings();
}

function saveSettings(s: CronSettings): void {
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  s.updated_at = new Date().toISOString();
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

export function mountCronSettingsRoutes(app: express.Application): void {
  // GET /api/settings/cron — read current schedule
  app.get("/api/settings/cron", authMiddleware, (_req, res) => {
    res.json(loadSettings());
  });

  // PUT /api/settings/cron — update schedule; validates 5-field cron expression
  app.put("/api/settings/cron", authMiddleware, (req, res) => {
    const { dreams_schedule, dreams_enabled } = req.body as {
      dreams_schedule?: string;
      dreams_enabled?: boolean;
    };
    const current = loadSettings();
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
    saveSettings(current);
    logger.info(`[CronSettings] Updated: schedule=${current.dreams_schedule}, enabled=${current.dreams_enabled}`);
    res.json({ success: true, settings: current });
  });
}
