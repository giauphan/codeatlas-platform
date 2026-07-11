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
