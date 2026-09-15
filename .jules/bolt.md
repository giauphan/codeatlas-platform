## 2026-09-10 - Faster access count bumping
**Learning:** Sequential updates with `executeMany` can have large overhead. Doing a single UPDATE statement with an IN clause provides massive performance speedup.
**Action:** When updating rows with known IDs that can easily fit in an IN clause, generate the dynamic bindings using `buildInClause` and execute a single statement rather than batch execution over the list.
## 2026-09-15 - Graph Node Search Adjacency Pre-computation
**Learning:** In `src/presentation/mcpTools.ts` functions like `search_entities` and `get_file_entities`, fetching relationships by chaining `links.filter(...).map(...)` inside loop scopes mapping nodes caused O(V*E) complexity.
**Action:** In graph traversal algorithms, compute node adjacencies by pre-calculating adjacency lists using Maps in a single pass before iterating nodes. This avoids nested `Array.prototype.filter()` loops for every node.

## 2026-09-15 - Graph Adjacency Object Destructuring Defaults
**Learning:** In TypeScript, relying on `= { incoming: true, outgoing: true }` in the parameter list means `{}` or `{ outgoing: true }` overwrites the entire default object, setting `incoming` to `undefined`.
**Action:** When parsing optional configuration objects, normalize options using nullish coalescing and default destructuring (`const { incoming = true, outgoing = true } = options ?? {};`) instead of manually checking properties. This ensures empty objects `{}` are safely handled and defaults are properly applied across partial properties.
