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
| `pnpm run db-init` | Initialize SQLite schema |
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

Tests use Node's native test runner (`node:test`) with `tsx` for TypeScript transpilation. Mocks via `mock.module()` for Firebase and internal services.

## Troubleshooting


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
