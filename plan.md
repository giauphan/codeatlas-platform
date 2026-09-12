1. **Identify the performance bottleneck:**
   In `src/presentation/mcpTools.ts`, within the `trace_feature_flow` tool (around lines 1180-1250), there is a bottleneck when building the `executionOrder` array.
   Inside the topological sort loop (and the subsequent loop for remaining nodes), the code does:
   ```typescript
   const callsTo = dedupLinks
     .filter((l) => l.source === current)
     .map((l) => nodeNameMap.get(l.target) || l.target);
   const calledBy = dedupLinks
     .filter((l) => l.target === current)
     .map((l) => nodeNameMap.get(l.source) || l.source);
   ```
   This iterates over `dedupLinks` (an array) for every node in `traceNodes`. This makes it an O(V * E) operation (where V is the number of nodes and E is the number of edges), which is basically O(N^2) for dense graphs.

2. **Optimize with O(N) preprocessing:**
   We can pre-calculate the `callsTo` and `calledBy` relationships for all nodes in a single pass over `dedupLinks`.
   ```typescript
   // Pre-calculate relationship arrays to avoid O(V*E) nested loops
   const callsToMap = new Map<string, string[]>();
   const calledByMap = new Map<string, string[]>();

   for (const link of dedupLinks) {
     const sourceName = nodeNameMap.get(link.source) || link.source;
     const targetName = nodeNameMap.get(link.target) || link.target;

     if (!callsToMap.has(link.source)) callsToMap.set(link.source, []);
     callsToMap.get(link.source)!.push(targetName);

     if (!calledByMap.has(link.target)) calledByMap.set(link.target, []);
     calledByMap.get(link.target)!.push(sourceName);
   }
   ```
   Then inside the loops, we can just do O(1) lookups:
   ```typescript
   const callsTo = callsToMap.get(current) || [];
   const calledBy = calledByMap.get(current) || [];
   ```

3. **Update `.jules/bolt.md`:**
   Add a learning about replacing nested O(N^2) `.filter()` loops inside graphing algorithms with O(N) adjacency maps.

4. **Verify the optimization:**
   - Pre-commit instructions for formatting and testing.
   - Wait for pre-commit instructions response.
   - Fix any failing tests or linting errors.

5. **Submit the PR:**
   Submit the changes using the required PR format for Bolt:
   Title: "⚡ Bolt: [performance improvement]"
   Description containing: What, Why, Impact, and Measurement.
