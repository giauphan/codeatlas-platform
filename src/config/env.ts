export function validateEnv() {
  const required = ["ORACLE_PASSWORD", "ORACLE_CONN_STRING"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

export function get(key: string, defaultVal?: string): string {
  return process.env[key] || defaultVal || "";
}

export const PROTECTED_TOOLS = new Set([
  "save_dream_memory",
  "query_dream_memories",
  "search_genome",
  "get_gene",
  "scan_immune_genes",
  "save_immune_gene",
  "sync_skills",
]);

let cachedDisabled: Set<string> | null = null;
let cacheRaw: string | undefined;

export function getDisabledTools(): Set<string> {
  const raw = process.env.CODEATLAS_DISABLED_TOOLS;
  if (cachedDisabled && raw === cacheRaw) return cachedDisabled;
  const names = (raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(n => !PROTECTED_TOOLS.has(n));
  cachedDisabled = new Set(names);
  cacheRaw = raw;
  return cachedDisabled;
}

export function isToolEnabled(name: string): boolean {
  if (PROTECTED_TOOLS.has(name)) return true;
  return !getDisabledTools().has(name);
}
