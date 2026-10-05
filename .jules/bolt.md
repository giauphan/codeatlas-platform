## 2026-10-04 - [Optimize array lookups in Security Scanner]
**Learning:** In frequently executed paths like AST traversal during security scanning, arrays declared inside function loops for inclusion checking (.includes()) cause unnecessary reallocation and O(N) lookup overhead.
**Action:** Always hoist static arrays to the module scope and convert them into `Set`s for O(1) `.has()` lookups to eliminate this bottleneck, especially in tools like `SecurityScanner.ts`.
