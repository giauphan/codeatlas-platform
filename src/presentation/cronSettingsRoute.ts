import express from "express";
import { logger } from "../utils/logger.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { authMiddleware } from "../middleware/auth.js";
import rateLimit from "express-rate-limit";
import { validateCronExpression, validateTimeZone } from "../utils/cron.js";

const cronRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

export interface CronSettings {
  dreams_schedule: string;
  dreams_enabled: boolean;
  dreams_provider: string;
  reconciliation_schedule: string;
  reconciliation_enabled: boolean;
  timezone: string;
  tenant_id?: string;
  project_id?: string;
  project?: string;
  updated_at: string;
}

export type CronSettingsPatch = Partial<Omit<CronSettings, "updated_at">>;

function settingsPath(): string {
  return process.env.CRON_SETTINGS_PATH || join(process.env.HOME || "/home/ubuntu", ".hermes", "cron-settings.json");
}

function defaultSettings(): CronSettings {
  return {
    dreams_schedule: "0 19 * * *",
    dreams_enabled: true,
    dreams_provider: "",
    reconciliation_schedule: "*/5 * * * *",
    reconciliation_enabled: true,
    timezone: "UTC",
    updated_at: new Date().toISOString(),
  };
}

export function mergeCronSettings(value: unknown): CronSettings {
  const defaults = defaultSettings();
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const merged = { ...defaults, ...raw } as CronSettings;
  if (!validateCronExpression(merged.dreams_schedule).valid) merged.dreams_schedule = defaults.dreams_schedule;
  if (!validateCronExpression(merged.reconciliation_schedule).valid) merged.reconciliation_schedule = defaults.reconciliation_schedule;
  if (!validateTimeZone(merged.timezone).valid) merged.timezone = defaults.timezone;
  if (typeof merged.dreams_enabled !== "boolean") merged.dreams_enabled = defaults.dreams_enabled;
  if (typeof merged.reconciliation_enabled !== "boolean") merged.reconciliation_enabled = defaults.reconciliation_enabled;
  if (typeof merged.dreams_provider !== "string") merged.dreams_provider = defaults.dreams_provider;
  for (const key of ["tenant_id", "project_id", "project"] as const) {
    const scope = raw[key];
    if (typeof scope === "string" && scope.trim() && scope.trim().length <= 512) merged[key] = scope.trim();
    else delete merged[key];
  }
  if (typeof merged.updated_at !== "string") merged.updated_at = defaults.updated_at;
  return merged;
}

export function validateCronSettingsUpdate(value: unknown): { valid: boolean; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "Settings must be a JSON object" };
  const patch = value as Record<string, unknown>;
  const allowed = new Set([
    "dreams_schedule", "dreams_enabled", "dreams_provider",
    "reconciliation_schedule", "reconciliation_enabled", "timezone",
    "tenant_id", "project_id", "project",
  ]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) return { valid: false, error: `Unknown setting: ${key}` };
  for (const key of ["dreams_schedule", "reconciliation_schedule"] as const) {
    const expression = patch[key];
    if (expression !== undefined) {
      if (typeof expression !== "string") return { valid: false, error: `${key} must be a string` };
      const validation = validateCronExpression(expression);
      if (!validation.valid) return { valid: false, error: `${key}: ${validation.error}` };
    }
  }
  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string") return { valid: false, error: "timezone must be a string" };
    const validation = validateTimeZone(patch.timezone);
    if (!validation.valid) return { valid: false, error: validation.error };
  }
  for (const key of ["dreams_enabled", "reconciliation_enabled"] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") return { valid: false, error: `${key} must be a boolean` };
  }
  if (patch.dreams_provider !== undefined && (typeof patch.dreams_provider !== "string" || patch.dreams_provider.length > 100)) {
    return { valid: false, error: "dreams_provider must be a string of at most 100 characters" };
  }
  for (const key of ["tenant_id", "project_id", "project"] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== "string" || !patch[key].trim() || patch[key].trim().length > 512)) {
      return { valid: false, error: `${key} must be a non-empty string of at most 512 characters` };
    }
  }
  return { valid: true };
}

export async function loadSettings(): Promise<CronSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), "utf-8")) as unknown;
    return mergeCronSettings(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn("[CronSettings] Failed to load settings; using defaults");
    }
  }
  return defaultSettings();
}

async function saveSettings(settings: CronSettings): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  settings.updated_at = new Date().toISOString();
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tempPath, path);
}

export function mountCronSettingsRoutes(app: express.Application): void {
  app.get("/api/settings/cron", cronRateLimiter, authMiddleware, async (_req, res, next) => {
    try {
      res.json(await loadSettings());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/settings/cron", cronRateLimiter, authMiddleware, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth || (auth.uid !== "admin" && auth.role !== "admin" && auth.tier !== "admin")) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const validation = validateCronSettingsUpdate(req.body);
      if (!validation.valid) return res.status(400).json({ error: validation.error });
      const current = await loadSettings();
      const patch = req.body as CronSettingsPatch;
      if (patch.dreams_schedule !== undefined) current.dreams_schedule = patch.dreams_schedule.trim();
      if (patch.dreams_enabled !== undefined) current.dreams_enabled = patch.dreams_enabled;
      if (patch.dreams_provider !== undefined) current.dreams_provider = patch.dreams_provider;
      if (patch.reconciliation_schedule !== undefined) current.reconciliation_schedule = patch.reconciliation_schedule.trim();
      if (patch.reconciliation_enabled !== undefined) current.reconciliation_enabled = patch.reconciliation_enabled;
      if (patch.timezone !== undefined) current.timezone = patch.timezone;
      if (patch.tenant_id !== undefined) current.tenant_id = patch.tenant_id.trim();
      if (patch.project_id !== undefined) current.project_id = patch.project_id.trim();
      if (patch.project !== undefined) current.project = patch.project.trim();
      await saveSettings(current);
      logger.info(`[CronSettings] Updated schedule settings (timezone=${current.timezone}, consolidation=${current.dreams_enabled}, reconciliation=${current.reconciliation_enabled})`);
      res.json({ success: true, settings: current });
    } catch (err) {
      next(err);
    }
  });
}
