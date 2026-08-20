## 2026-08-16 - Array processing in O(N^2) loops
**Learning:** When performing pairwise distance checks (e.g. cosine similarity) over N elements, checking types recursively inside the inner N^2 loop creates significant overhead. In Javascript/Typescript, repeated Array operations like Array.isArray, array property index reads, or mapping arrays directly impacts garbage collection heavily on nested loops.
**Action:** Extract bounds checking, array property type assertions, and invalid structure exclusion into a dedicated O(N) grouping preprocessing step so the inner loops only deal with guaranteed valid references.

## 2026-08-16 - Type Safety in Array Property Accesses
**Learning:** When performing length calculations on arrays, structural typing allows objects shaped like `{ length: 5 }` to bypass standard checks, leading to NaN errors in math computations. Native type protections like `Array.isArray()` and `instanceof` checks are critical to guard against prototype poisoning.
**Action:** Use defensive `Array.isArray(x) || x instanceof Float32Array` validation rather than just relying on length presence prior to array execution functions.

## 2026-08-17 - O(N^2) Math GC Overhead
**Learning:** When executing mathematical loops (e.g. `cosineSimilarity`) inside O(N^2) pairwise comparisons, repeatedly asserting type conversions on plain Javascript arrays causes high hidden object allocation and GC pressure in V8.
**Action:** When working with nested vector operations, extract type coercions to outer scopes where possible and explicitly cache pre-mapped vectors (like `Float32Array`) directly to the original row objects to bypass repetitive wrapper overhead during inner iterations.

## 2026-08-17 - Hoisting loop invariants in numeric tight loops
**Learning:** In tight nested N^2 loops (like those doing similarity measurements across large embedding arrays), redundant property access overheads (`group[i][IDX]`) or type coercions (`Number()`, `String()`) are highly penalizing to V8. Evaluating them inside the inner loop creates massive GC pressure and redundant CPU work.
**Action:** Always extract invariant evaluations (`group[i]`, coercions, and array ID strings) from the outer loop iteration block into local variables before entering the inner $O(N)$ iteration block.

## 2026-08-18 - Replacing Sequential File Checks with Batched Concurrency in N+1 scenarios
**Learning:** Checking `await fileExists()` inside sequential `for` loops (like iterating over global project registries) causes an N+1 latency bottleneck in project discovery.
**Action:** Replace sequential file system operations with bounded `Promise.all` chunking (e.g., `chunkSize = 50`) to maximize I/O throughput safely without hitting `EMFILE` limits.

## 2026-08-19 - Fast vector similarity loops
**Learning:** In highly mathematical operations inside $O(N^2)$ loops (like pairwise cosine similarity computations), redundant allocations such as extracting IDs/properties and generating arrays dynamically causes massive garbage collection overhead. Furthermore, ensuring input arrays are always passed directly as `Float32Array` enables the V8 runtime to leverage fast, unboxed vector operations natively.
**Action:** When calculating similarity matrix distances or comparisons, pre-normalize structural types like raw arrays to `Float32Array` before executing nested loops, and cache invariant lookups out of the inner loop scope.

## 2026-08-19 - Pre-parsing vectors to avoid O(N^2) inner-loop allocations
**Learning:** When calculating vector similarities or comparisons in $O(N^2)$ nested loops, repeatedly extracting properties (`getVal`) and parsing raw string/arrays into `Float32Array` within the inner loop causes massive, redundant CPU cycles and garbage collection pressure in V8.
**Action:** When calculating similarity matrix distances or comparisons, pre-parse data structures (like converting raw arrays to `Float32Array`) and extract invariant lookups during an $O(N)$ preprocessing phase, mapping the valid subset to an array of objects to iterate over, effectively eliminating redundant type coercion in the inner loop.

## 2026-08-20 - Redundant Array Lookups in Hot Math Loops
**Learning:** In hot loops involving heavy math like vector similarity, continuously evaluating array indexing (e.g. `vecA[i]`) multiplies access lookup overhead, hurting JS engine optimizations.
**Action:** Always cache `length` and array elements (e.g., `const a = vecA[i]`) locally inside tight iteration blocks to minimize property lookups and bounds checking.
