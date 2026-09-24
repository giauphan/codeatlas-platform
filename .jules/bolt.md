## 2026-09-10 - Faster access count bumping
**Learning:** Sequential updates with `executeMany` can have large overhead. Doing a single UPDATE statement with an IN clause provides massive performance speedup.
**Action:** When updating rows with known IDs that can easily fit in an IN clause, generate the dynamic bindings using `buildInClause` and execute a single statement rather than batch execution over the list.
## 2026-09-19 - O(1) graph edge lookups
**Learning:** Using `.filter()` to find incoming or outgoing edges inside a `.map()` loop over graph nodes leads to O(V*E) time complexity, which becomes a major bottleneck for large graphs.
**Action:** When looking up relationships for a subset of nodes, iterate through the edges array once to construct `Map`-based adjacency lists. This pre-calculation reduces the inner loop lookup to O(1), improving overall time complexity to O(V+E).
## 2026-09-23 - Independent Connection Pools for Fire-and-Forget
**Learning:** When attempting to make database updates non-blocking (fire-and-forget) to fix "Write on Read" bottlenecks, reusing the main request's database connection is unsafe. The surrounding code will often close or return the connection to the pool while the async background task is still running, leading to race conditions and "Connection closed" errors.
**Action:** When implementing fire-and-forget updates in services, explicitly acquire a new background connection (`initPool().then(pool => pool.getConnection())`), capture synchronous context (like `tenantId`) to prevent async state loss, and handle errors/cleanup in a standalone promise chain that ends with `.finally(() => bgConn.close())`.
## 2026-09-24 - Single Pass Filter Deduplication
**Learning:** Multiple sequential `.filter()` operations over large arrays (like knowledge graph edges) cause O(N * passes) time and memory overhead, resulting in excessive garbage collection pressure.
**Action:** When applying multiple filters and deduplication to large arrays, combine them into a single loop pass. Also, hoist repeated string transformations like `.toLowerCase()` outside the loop body.
