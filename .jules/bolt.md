## 2026-09-10 - Faster access count bumping
**Learning:** Sequential updates with `executeMany` can have large overhead. Doing a single UPDATE statement with an IN clause provides massive performance speedup.
**Action:** When updating rows with known IDs that can easily fit in an IN clause, generate the dynamic bindings using `buildInClause` and execute a single statement rather than batch execution over the list.
## 2026-09-19 - O(1) graph edge lookups
**Learning:** Using `.filter()` to find incoming or outgoing edges inside a `.map()` loop over graph nodes leads to O(V*E) time complexity, which becomes a major bottleneck for large graphs.
**Action:** When looking up relationships for a subset of nodes, iterate through the edges array once to construct `Map`-based adjacency lists. This pre-calculation reduces the inner loop lookup to O(1), improving overall time complexity to O(V+E).
