1. **Combine multiple `.filter()` passes in `get_dependencies` tool:**
   - In `src/presentation/mcpTools.ts` inside the `get_dependencies` tool handler, `links` undergoes up to 4 sequential `.filter()` passes:
     1. Filter by `relationship`
     2. Filter by `source`
     3. Filter by `target`
     4. Deduplicate using a Set
   - To avoid O(N * passes) execution overhead on potentially large datasets (like `links` array) and excessive garbage collection from intermediate arrays, these operations should be combined into a single `for...of` loop pass.
   - We must also precompute `source.toLowerCase()` and `target.toLowerCase()` string transformations outside the loop to avoid redundant allocations in each iteration.
   - Importantly, as per memory `When optimizing graph edge filtering based on node attributes, avoid using pre-computed Sets of matching node IDs if the code relies on fallback labels (e.g., nodeMap.get(l.source) || l.source), as this drops unmapped 'dangling' edges. Instead, combine multiple .filter() passes into a single for...of loop while retaining the inline string checking logic to preserve correctness.` We'll stick to a single `for...of` loop with inline `label.toLowerCase().includes(...)` checks for `source` and `target` matching to ensure unmapped dangling edges are not dropped.

2. **Run tests & typecheck to verify correctness**
   - Run `pnpm run typecheck`
   - Run `pnpm test` (or check if there are tests for this)

3. **Complete pre commit steps**
   - Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.

4. **Submit the PR**
   - Title: `⚡ Bolt: Optimize get_dependencies graph edge filtering`
   - Describe What, Why, Impact, and Measurement.
