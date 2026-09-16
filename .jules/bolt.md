## 2026-09-10 - Faster access count bumping
**Learning:** Sequential updates with `executeMany` can have large overhead. Doing a single UPDATE statement with an IN clause provides massive performance speedup.
**Action:** When updating rows with known IDs that can easily fit in an IN clause, generate the dynamic bindings using `buildInClause` and execute a single statement rather than batch execution over the list.
## 2026-09-16 - write-on-read elimination
**Learning:** Bumping access counts using an `await` database call in API endpoints creates a "write-on-read" bottleneck, tying up response time and asynchronous context. Replacing batch updates like `executeMany` with a single fire-and-forget `execute` call using an `IN` clause eliminates wait times on non-critical paths.
**Action:** When updating non-critical counters (like access stats), construct a single `IN` clause using `buildInClause` and omit `await` to make the call fire-and-forget, adding `.catch()` to handle potential rejections safely.
