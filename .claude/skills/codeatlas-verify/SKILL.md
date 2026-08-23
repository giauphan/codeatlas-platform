---
name: codeatlas-verify
description: Run CodeAtlas build, tests, and final diff checks.
---

# CodeAtlas Verification

Run checks relevant to changed code:

```bash
pnpm run build
pnpm test
git diff --check
git status --short
```

For dashboard changes, also run from `dashboard/`:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

Do not claim success if a check fails or was skipped. Do not modify unrelated files while fixing verification failures.
