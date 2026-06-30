💡 **What:**
Optimized `SecurityScanner.scan` by pre-computing a Map of nodes (`nodesMap`) for O(1) lookups instead of using `Array.prototype.find()` in a loop inside `isSqlRelated`.

🎯 **Why:**
The previous implementation iterated over `connectedNodeIds` and used `analysis.graph.nodes.find(n => n.id === id)` to lookup the connected node. This resulted in an O(N*M) complexity (where N is the number of nodes and M is the number of connected nodes). Creating a Map of nodes beforehand reduces the time complexity of the lookup to O(1), improving the overall complexity to O(N+M).

📊 **Measured Improvement:**
Measured performance in a worst-case scenario (1 highly-connected node with 20000 links across 20000 nodes):
* **Baseline:** ~2648 ms
* **Optimized:** ~66 ms
* **Improvement:** ~40x speedup
