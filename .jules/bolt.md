## 2026-09-10 - Faster access count bumping
**Learning:** Sequential updates with `executeMany` can have large overhead. Doing a single UPDATE statement with an IN clause provides massive performance speedup.
**Action:** When updating rows with known IDs that can easily fit in an IN clause, generate the dynamic bindings using `buildInClause` and execute a single statement rather than batch execution over the list.
## 2026-09-19 - O(1) graph edge lookups
**Learning:** Using `.filter()` to find incoming or outgoing edges inside a `.map()` loop over graph nodes leads to O(V*E) time complexity, which becomes a major bottleneck for large graphs.
**Action:** When looking up relationships for a subset of nodes, iterate through the edges array once to construct `Map`-based adjacency lists. This pre-calculation reduces the inner loop lookup to O(1), improving overall time complexity to O(V+E).
## 2026-09-23 - Independent Connection Pools for Fire-and-Forget
**Learning:** When attempting to make database updates non-blocking (fire-and-forget) to fix "Write on Read" bottlenecks, reusing the main request's database connection is unsafe. The surrounding code will often close or return the connection to the pool while the async background task is still running, leading to race conditions and "Connection closed" errors.
**Action:** When implementing fire-and-forget updates in services, explicitly acquire a new background connection (`initPool().then(pool => pool.getConnection())`), capture synchronous context (like `tenantId`) to prevent async state loss, and handle errors/cleanup in a standalone promise chain that ends with `.finally(() => bgConn.close())`.
## 2026-10-24 - Hoist loop-invariant string operations in array filters
**Learning:** In React functional components, filtering lists using inline `.filter()` often repeats expensive invariant string operations (like `.toLowerCase()` or `.trim()`) inside the loop. This causes O(N) recalculations and unnecessary memory allocations for intermediate strings on every render, especially when the filtering isn't memoized.
**Action:** When filtering lists in React components based on state (e.g., search queries), wrap the filtering logic in `useMemo` with correct dependencies and explicitly hoist loop-invariant operations (like `.toLowerCase()` or `.trim()`) outside the `.filter` loop to optimize performance.

## 2026-10-24 - CI Dependency Audit Failure
**Learning:** `pnpm audit --prod --audit-level=high` failed in CI due to `body-parser` < 1.20.9 (CVE-2024-4068 / GHSA-27r3-jxmh-p828) being pulled in transitively. Standard `pnpm update` did not resolve it cleanly because it was deeply nested within Express and the MCP SDK.
**Action:** When a transitive dependency triggers a high-severity audit failure and `pnpm update` fails to resolve it across the workspace, use `pnpm`'s `"overrides"` field in `package.json` (e.g., `"body-parser": ">=1.20.9"`) to force the patched version globally, then regenerate the lockfile by removing it and running `pnpm install`.
