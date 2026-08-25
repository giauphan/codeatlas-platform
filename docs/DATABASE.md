# Database Configuration

CodeAtlas Platform supports **two database backends** via the `IDatabaseAdapter` interface:

| Database | Use Case | Setup Difficulty |
| :--- | :--- | :--- |
| **SQLite + sqlite-vec** | Local dev / single-user (default) | 🟢 Zero-config |
| **PostgreSQL + pgvector** | Self-hosted production | 🟡 Easy (Supabase/Neon) |


## Quick Start

### Option 1: SQLite + sqlite-vec (Default)

```bash
cp .env.example .env
export CODEATLAS_DB_TYPE=sqlite
export CODEATLAS_SQLITE_PATH=./data/codeatlas.db

pnpm install
pnpm run db-seed
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

## Architecture

### Adapter Pattern

```
src/database/
├── factory.ts                    # Creates adapter based on CODEATLAS_DB_TYPE
└── adapters/
    ├── interface.ts              # IDatabaseAdapter interface
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
| `CODEATLAS_DB_TYPE` | `sqlite` | Database type: `sqlite` or `postgres` |
| `CODEATLAS_SQLITE_PATH` | `./data/codeatlas.db` | Path to SQLite database file |
| `PGHOST` | (none) | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | (none) | PostgreSQL user |
| `PGPASSWORD` | (none) | PostgreSQL password |
| `PGDATABASE` | (none) | PostgreSQL database name |

## Migration Path


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

## Future Improvements (P2)

- [ ] Add Knex.js or Drizzle for schema migrations
- [ ] Add HNSW index for Postgres (better recall than IVF)
- [ ] Add connection pooling config for SQLite (WAL + busy_timeout)
