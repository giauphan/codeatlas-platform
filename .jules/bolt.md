## 2026-08-16 - Array processing in O(N^2) loops
**Learning:** When performing pairwise distance checks (e.g. cosine similarity) over N elements, checking types recursively inside the inner N^2 loop creates significant overhead. In Javascript/Typescript, repeated Array operations like Array.isArray, array property index reads, or mapping arrays directly impacts garbage collection heavily on nested loops.
**Action:** Extract bounds checking, array property type assertions, and invalid structure exclusion into a dedicated O(N) grouping preprocessing step so the inner loops only deal with guaranteed valid references.
## 2026-08-16 - Type Safety in Array Property Accesses
**Learning:** When performing length calculations on arrays, structural typing allows objects shaped like `{ length: 5 }` to bypass standard checks, leading to NaN errors in math computations. Native type protections like `Array.isArray()` and `instanceof` checks are critical to guard against prototype poisoning.
**Action:** Use defensive `Array.isArray(x) || x instanceof Float32Array` validation rather than just relying on length presence prior to array execution functions.
## 2026-08-18 - Replacing Sequential File Checks with Batched Concurrency in N+1 scenarios
**Learning:** Checking `await fileExists()` inside sequential `for` loops (like iterating over global project registries) causes an N+1 latency bottleneck in project discovery.
**Action:** Replace sequential file system operations with bounded `Promise.all` chunking (e.g., `chunkSize = 50`) to maximize I/O throughput safely without hitting `EMFILE` limits.
