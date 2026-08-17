# Database Configuration

CodeAtlas Platform supports **three database backends** via the `IDatabaseAdapter` interface:

| Database | Use Case | Setup Difficulty |
| :--- | :--- | :--- |
| **Oracle 26ai** | Production cloud (default) | 🔴 Hard (Wallet + Instant Client) |
| **SQLite + sqlite-vec** | Local dev / single-user | 🟢 Zero-config |
| **PostgreSQL + pgvector** | Self-hosted production | 🟡 Easy (Supabase/Neon) |

## Quick Start

### Option 1: SQLite (Recommended for Local Dev)

```bash
# Set environment variable
export CODEATLAS_DB_TYPE=sqlite
export CODEATLAS_SQLITE_PATH=./data/codeatlas.db

# Install dependencies
pnpm add better-sqlite3 sqlite-vec

# Run seeder
pnpm run db-seed

# Start server
pnpm start
```

### Option 2: PostgreSQL (Self-hosted Production)

```bash
# Set environment variables
export CODEATLAS_DB_TYPE=postgres
export PGHOST=localhost
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=your_password
export PGDATABASE=codeatlas

# Install dependencies
pnpm add pg pgvector

# Run seeder
pnpm run db-seed

# Start server
pnpm start
```

### Option 3: Oracle 26ai (Default, Cloud Production)

```bash
# Set environment variables (existing)
export CODEATLAS_DB_TYPE=oracle  # or leave unset (default)
export ORACLE_CONN_STRING=host:port/service_name
export ORACLE_USER=ADMIN
export ORACLE_PASSWORD=your_password
export ORACLE_WALLET_DIR=./wallet  # optional, for mTLS

# Start server
pnpm start
```

## Architecture

### Adapter Pattern

```
src/database/
├── factory.ts                    # Creates adapter based on CODEATLAS_DB_TYPE
└── adapters/
    ├── interface.ts              # IDatabaseAdapter interface
    ├── oracleAdapter.ts          # Oracle 26ai implementation
    ├── sqliteAdapter.ts          # SQLite + sqlite-vec implementation
    └── postgresAdapter.ts        # PostgreSQL + pgvector implementation
```

### Usage in Services

```typescript
import { createDatabaseAdapter } from "../database/factory";

const db = createDatabaseAdapter();

await db.connect();
await db.initializeSchema();
const results = await db.searchVector("ai_dreaming_memory", embedding, 10, tenantId);
await db.disconnect();
```

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CODEATLAS_DB_TYPE` | `oracle` | Database type: `oracle`, `sqlite`, or `postgres` |
| `CODEATLAS_SQLITE_PATH` | `./data/codeatlas.db` | Path to SQLite database file |
| `PGHOST` | (none) | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | (none) | PostgreSQL user |
| `PGPASSWORD` | (none) | PostgreSQL password |
| `PGDATABASE` | (none) | PostgreSQL database name |

## Migration Path

### From Oracle to SQLite (Local Dev)

1. Set `CODEATLAS_DB_TYPE=sqlite`
2. Run `pnpm run db-seed` to populate initial data
3. Existing Oracle data is **not** migrated automatically — fresh start

### From SQLite to PostgreSQL (Production)

1. Set `CODEATLAS_DB_TYPE=postgres`
2. Configure `PG*` environment variables
3. Run `pnpm run db-seed` to populate initial data
4. SQLite data can be exported via `sqlite3 data.db .dump` and adapted

## Schema

All adapters create identical tables with DB-appropriate types:

| Table | Purpose | Vector Column |
| :--- | :--- | :--- |
| `ai_dreaming_memory` | Dream memories | `embedding` (1024-dim) |
| `codeatlas_genome` | Genome patterns | `embedding` (1024-dim) |
| `ai_semantic_memory` | Code entities | `embedding` (1024-dim) |
| `ai_relational_memory` | Code relationships | (none) |
| `ai_episodic_memory` | Event logs | (none) |
| `codeatlas_concepts` | Concepts | `embedding` (1024-dim) |

## Troubleshooting

### SQLite: "database is locked"

Enable WAL mode (already configured by default):
```bash
sqlite3 data.db "PRAGMA journal_mode=WAL;"
```

### SQLite: "no such module: vec0"

Install `sqlite-vec`:
```bash
pnpm add sqlite-vec
```

### Postgres: "extension vector does not exist"

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Oracle: "DPI-1047: Cannot locate a 64-bit Oracle Client library"

Use Thin Mode (remove `ORACLE_LIB_DIR` and `ORACLE_WALLET_DIR`):
```bash
unset ORACLE_LIB_DIR
unset ORACLE_WALLET_DIR
```

## Future Improvements (P2)

- [ ] Add Knex.js or Drizzle for schema migrations
- [ ] Implement dual-write mode for Oracle → Postgres migration
- [ ] Add HNSW index for Postgres (better recall than IVF)
- [ ] Add connection pooling config for SQLite (WAL + busy_timeout)
- [ ] Add data migration script (Oracle → SQLite/Postgres)
