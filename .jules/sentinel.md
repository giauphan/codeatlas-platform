## 2026-08-23 - Parameterized SQL subqueries in searchVector

**Vulnerability:** SQL Injection in dynamic `IN` and `!=` filtering clauses within `db.searchVector` subqueries due to string interpolation (`replace(/'/g, "''")`) in `src/services/genomeService.ts`.
**Learning:** `db.searchVector()` relies on dynamic `FROM ${table}` subqueries, which previously prevented the use of parameter bindings for filters like `WHERE project = ?`. String escaping mechanisms were used instead, introducing injection vectors.
**Prevention:** The `IDatabaseAdapter.searchVector()` method must explicitly accept a `binds?: Record<string, unknown>` argument. All SQL adapters (SQLite, Oracle, and Postgres) must map these extra named bindings securely. Specifically for Postgres, an internal `processNamedParams` converter allows named binds without conflicting with `::type` casting syntax, ensuring developers can cleanly map dynamic subquery parameters safely.
