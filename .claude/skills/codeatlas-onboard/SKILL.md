---
name: codeatlas-onboard
description: Set up a new CodeAtlas development session with SQLite defaults.
---

# CodeAtlas Onboarding

Use for first setup or a new development session.

1. Read `CLAUDE.md` and `.claude/CLAUDE.md`.
2. Check runtime:

   ```bash
   node --version
   pnpm --version
   git status --short
   ```

3. Install dependencies:

   ```bash
   pnpm install --frozen-lockfile
   ```

4. Prepare local SQLite database:

   ```bash
   pnpm run db-init
   ```

5. Verify project:

   ```bash
   pnpm run build
   pnpm test
   ```

6. Start development server when needed:

   ```bash
   pnpm run dev
   ```

Normal onboarding does not require Oracle, PostgreSQL, Firebase credentials, or an external database. Configure those only for work explicitly using those integrations. Never print secrets from `.env` or credential files.
