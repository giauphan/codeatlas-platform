---
name: codeatlas-implement
description: Implement a CodeAtlas change from discovery through tests and verification.
---

# CodeAtlas Implementation

1. Run `git status --short`.
2. Identify feature entry points with CodeAtlas MCP `trace_feature_flow` or `search_entities` when available.
3. Read related source, dependencies, and tests.
4. Choose the smallest change that satisfies the request.
5. Keep HTTP/MCP code in `src/presentation`, business logic in `src/services`, and persistence in `src/database` or repositories.
6. Use SQLite + `sqlite-vec` as default behavior. Do not make Oracle or PostgreSQL required for local work.
7. Add regression coverage for changed behavior.
8. Run:

   ```bash
   pnpm run build
   pnpm test
   ```

9. Review `git diff --check` and final diff.
10. Call `sync_system_memory` with a concise change description.

Do not reset, clean, stash, commit, push, or alter unrelated files. Report any unavailable or failing check.
