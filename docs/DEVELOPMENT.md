# Local development

This guide covers the supported setup path, everyday contributor commands, and common local failures. For the full env var reference, see [CONFIGURATION.md](CONFIGURATION.md).

## Requirements

- Node.js 20 or newer
- pnpm 9+ (enable via Corepack: `corepack enable && corepack prepare pnpm@9 --activate`)
- SQLite + sqlite-vec (included in project dependencies)
- Optional: Firebase service account JSON (for multi-tenant auth)
- Optional: NVIDIA NIM API key (for embeddings)

Check the tools before setup:

```bash
node --version
pnpm --version
```

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Set Firebase and NVIDIA credentials only when those integrations are enabled.
```

### 3. Initialize SQLite

```bash
pnpm run db-seed
```

This creates and seeds `CODEATLAS_SQLITE_PATH` with SQLite + sqlite-vec schema. Safe to rerun.

To import existing Oracle data once, configure migration-only Oracle credentials and run:

```bash
pnpm run db-migrate-oracle-to-sqlite
```

### 4. Run the server

```bash
# Production mode (SSE on :3381)
PORT=3381 pnpm start

# Development mode with hot reload
pnpm run dev

# Stdio mode (Claude Desktop — leave PORT unset)
pnpm start
```

Open <http://localhost:3381/health> to verify the server is running.

## Individual commands

| Command | Description |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm run build` | Compile TypeScript (`tsc`) |
| `pnpm start` | Run compiled server (`node dist/src/index.js`) |
| `pnpm run dev` | Run with hot reload (`tsx watch`) |
| `pnpm test` | Run unit tests (`node --test`) |
| `pnpm run db-init` | Initialize Oracle schema |
| `npx tsc --noEmit` | Type-check without emitting |

## Dashboard development

```bash
cd dashboard
pnpm install
pnpm run dev    # Vite dev server at http://localhost:5173
pnpm run build  # production build
pnpm test       # Vitest unit tests
```

Dashboard env vars (set in `dashboard/.env`, prefix with `VITE_`):

```bash
cp dashboard/.env.example dashboard/.env  # if present
# Edit with your Firebase Web config
```

## Running tests

```bash
# All unit tests
pnpm test

# With coverage
node --experimental-test-coverage --import tsx --test tests/**/*.test.ts
```

Tests use Node's native test runner (`node:test`) with `tsx` for TypeScript transpilation. Mocks via `mock.module()` for `oracledb`, `firebase-admin`, and internal services.

## Troubleshooting

### `ORA-12506: TNS:listener rejected connection`

Oracle Autonomous Database ACL is blocking your IP. Add your subnet to the ACL in Oracle Cloud Console → Autonomous Database → Network → Access Control List.

### `ORA-12514: TNS:listener does not currently know of service`

Verify `ORACLE_CONN_STRING` format: `host:port/service_name`. The service name must match the database's service name (e.g., `atlas_medium` for Autonomous Database).

### `NJS-040: connection request timeout`

Connection pool starvation. The platform generates embeddings **before** acquiring Oracle connections to prevent this. If it persists, increase pool size in `src/database/connection.ts` or reduce concurrent requests.

### `DPI-1047: 64-bit Oracle Client library cannot be loaded`

Oracle Instant Client not found. Either:
- Set `ORACLE_LIB_DIR` to the correct path, or
- Remove `ORACLE_LIB_DIR` to use Thin mode (no Instant Client required for Oracle 23ai+).

### `LD_LIBRARY_PATH not found`

Ensure Oracle Instant Client is extracted and `LD_LIBRARY_PATH` includes the Instant Client directory.

### `Firebase Service Account not found`

`GOOGLE_APPLICATION_CREDENTIALS` points to a non-existent file. Verify the path is relative to `process.cwd()` (project root) or use an absolute path.

### `Port already in use`

Change the `PORT` environment variable or kill the existing process:

```bash
lsof -i :3381
kill -9 <PID>
```

### `VITE_FIREBASE_API_KEY not set`

Dashboard falls back to API-key-only mode (no Firebase auth UI). This is expected for single-tenant deployments. To enable Firebase auth in the dashboard, set the `VITE_FIREBASE_*` env vars in `dashboard/.env`.

## Next steps

- [API examples](API_EXAMPLES.md) — curl flows and MCP configs
- [Deployment](DEPLOYMENT.md) — PM2, systemd, Nginx
- [Architecture overview](architecture/overview.md) — layers and services
