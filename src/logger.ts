/**
 * CodeAtlas Logger — structured logging with levels
 *
 * Environment variables:
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 *   LOG_FORMAT=json|pretty            (default: pretty)
 *
 * Usage:
 *   import { logger } from "./logger.js";
 *   logger.info("Server started", { port: 8080 });
 *   logger.error("Failed to connect", err);
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LOG_LEVELS;

const currentLevel: Level =
  (Object.prototype.hasOwnProperty.call(LOG_LEVELS, process.env.LOG_LEVEL ?? "")
    ? (process.env.LOG_LEVEL as Level)
    : "info");
const isJson = process.env.LOG_FORMAT === "json";
const threshold = LOG_LEVELS[currentLevel];

function timestamp(): string {
  return new Date().toISOString();
}

function formatMeta(args: unknown[]): unknown {
  // last arg if it's a plain object (not an Error) is treated as structured meta
  // Using slice to avoid mutating the caller's array
  if (args.length > 1) {
    const last = args[args.length - 1];
    if (typeof last === "object" && last !== null && !(last instanceof Error)) {
      return last as Record<string, unknown>;
    }
  }
  return undefined;
}

function stringify(val: unknown): string {
  if (val instanceof Error) {
    return `${val.name}: ${val.message}\n${(val.stack ?? "").split("\n").slice(1).join("\n")}`;
  }
  if (typeof val === "object" && val !== null) {
    try {
      return JSON.stringify(val, null, isJson ? 0 : 2);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

function log(level: Level, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < threshold) return;

  const meta = formatMeta(args);
  const message = args.map(stringify).join(" ");
  const ts = timestamp();

  if (isJson) {
    const entry: Record<string, unknown> = {
      level,
      time: ts,
      msg: message,
    };
    if (meta) entry.meta = meta;
    const output = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  } else {
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (level === "error") {
      process.stderr.write(`${prefix} ${message}\n`);
    } else {
      process.stdout.write(`${prefix} ${message}\n`);
    }
  }
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
};
