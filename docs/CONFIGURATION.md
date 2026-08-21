# Configuration reference

CodeAtlas Platform is configured via environment variables. Copy `.env.example` to `.env` and fill in your values.

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | unset | HTTP/SSE server port. Leave unset for stdio-only mode (Claude Desktop). |
| `CODEATLAS_MCP_PORT` | `3382` | Internal MCP callback port. |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:3000` | CORS allowlist (comma-separated origins). |

## Multi-tenant

| Variable | Default | Description |
|---|---|---|
| `CODEATLAS_MULTI_TENANT` | `false` | Enable multi-tenant isolation via Firebase auth + `authStorage.run`. |
| `CODEATLAS_PROJECTS_ROOT` | `./tenants` | Root directory for tenant project sandboxes. |
| `CODEATLAS_PROJECT_DIR` | `./` | Canonical project directory for single-tenant mode. |
| `CODEATLAS_DISABLED_TOOLS` | unset | Comma-separated MCP tool names to disable (e.g., `scan_enterprise_vulnerabilities`). |

## SQLite + sqlite-vec

SQLite is default database for local and current deployment flow. `sqlite-vec` loads automatically through the SQLite adapter.

| Variable | Default | Description |
|---|---|---|
| `CODEATLAS_DB_TYPE` | `sqlite` | Database backend selection. Keep `sqlite`. |
| `CODEATLAS_SQLITE_PATH` | `./data/codeatlas.db` | SQLite database file path. |

Initialize or seed database with `pnpm run db-seed`. To copy existing Oracle data into SQLite, run `pnpm run db-migrate-oracle-to-sqlite` with migration-only Oracle credentials configured outside this template.

Oracle adapter configuration is intentionally omitted from `.env.example` and remains legacy migration/fallback code for now.

## Firebase

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | `./serviceAccountKey.json` | Path to Firebase service account JSON. |

## NVIDIA NIM

| Variable | Default | Description |
|---|---|---|
| `NVIDIA_API_KEY` | required | NVIDIA NIM API key for vector embeddings. Without it, queries fall back to date-ordered results. |

## Security

| Variable | Default | Description |
|---|---|---|
| `CODEATLAS_API_KEY` | unset | API key for `x-api-key` header auth. Optional for local dev. |
| `A2A_MCP_TOKEN` | unset | Bearer token for outbound A2A MCP calls. |

## Cron / scheduler

| Variable | Default | Description |
|---|---|---|
| `CRON_SETTINGS_PATH` | `~/.hermes/cron-settings.json` | Path to cron settings JSON file. |

## Dashboard (Vite env vars)

Dashboard uses Vite — env vars must be prefixed with `VITE_`. Set these in `dashboard/.env`:

| Variable | Description |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase Web API key. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain. |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID. |
| `VITE_FIREBASE_APP_ID` | Firebase app ID. |

Without `VITE_FIREBASE_API_KEY`, the dashboard falls back to API-key-only mode (no Firebase auth UI).
