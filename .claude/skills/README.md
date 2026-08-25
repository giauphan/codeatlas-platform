# CodeAtlas AI Skills

Project skills use Claude Code’s `SKILL.md` format.

## Available skills

- `codeatlas-onboard` — install, initialize SQLite, build, and test a new checkout.
- `codeatlas-implement` — trace, implement, test, and verify a focused change.
- `codeatlas-verify` — run build, tests, and final diff checks.

Run a skill by name, for example: `/codeatlas-onboard`.

SQLite + `sqlite-vec` is default for local development and tests. Firebase and PostgreSQL only need configuration for work explicitly involving those integrations.
