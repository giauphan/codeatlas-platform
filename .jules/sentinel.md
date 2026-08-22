## 2026-08-22 - Prevent SQL Injection by Parameterizing `IN` clauses
**Vulnerability:** SQL Injection via dynamically concatenated strings in `IN` clauses (using manual escaping `.replace(/'/g, "''")`) when searching for database vectors and memories.
**Learning:** Legacy string interpolation approach inside `.execute()` and `.query()` queries bypassed native database driver bindings and exposed the system to injection vulnerabilities.
**Prevention:** Construct parameterized `IN` bindings dynamically (e.g., `id IN (:id0, :id1)`) and map them directly into a flattened `bindParams` object so the database driver handles security constraints.
