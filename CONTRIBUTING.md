# Contributing to CodeAtlas Platform

Thank you for helping make CodeAtlas Platform more secure, reliable, and useful. Contributions to code, tests, documentation, issue triage, and examples are all welcome.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use GitHub Discussions for usage questions and early-stage ideas.
- Open an issue before starting a large or breaking change.
- Never report a suspected vulnerability in a public issue; follow [SECURITY.md](SECURITY.md).

Issues labeled `good first issue` are intentionally small and suitable for a first contribution. Issues labeled `help wanted` have an agreed direction and are ready for community implementation.

## Development setup

### Requirements

- Node.js 20 or newer
- pnpm 9+ (enable via Corepack: `corepack enable && corepack prepare pnpm@9 --activate`)
- Oracle 26ai (Autonomous Database or self-hosted with VECTOR support)
- Firebase service account JSON (for multi-tenant auth)

### Install and build

```bash
git clone https://github.com/giauphan/codeatlas-platform.git
cd codeatlas-platform
cp .env.example .env  # then edit with your credentials
pnpm install
pnpm run build
```

Read [DEVELOPMENT.md](docs/DEVELOPMENT.md) for external Oracle setup, individual commands, and troubleshooting.

### Dashboard development

```bash
cd dashboard
pnpm install
pnpm run dev    # Vite dev server at http://localhost:5173
pnpm run build  # production build
pnpm test       # Vitest unit tests
```

## Make a focused change

Create a branch from the latest `main`:

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description
```

Keep commits focused. Recommended commit prefixes (Conventional Commits):

```text
feat: add a backward-compatible capability
fix: correct broken behavior
docs: improve documentation
test: add or improve coverage
refactor: restructure without changing behavior
chore: maintain tooling or dependencies
perf: improve performance
security: security fix
```

## Run the quality gate

Before opening a pull request, run:

```bash
pnpm run build
pnpm test
cd dashboard && pnpm test && cd ..
```

New behavior must include tests. Changes to configuration, endpoints, or deployment behavior must also update the relevant documentation.

## Open a pull request

A reviewable pull request should:

- solve one clearly described problem;
- link its issue with `Fixes #123` when applicable;
- explain user-visible and security impact;
- include tests or explain why tests are not needed;
- preserve backward compatibility, or explicitly document the break;
- contain no credentials, personal data, generated databases, or build output.

Maintainers may ask for a smaller scope when a pull request mixes unrelated changes. This keeps reviews fast and makes releases safer.

## Code style

- TypeScript strict mode (enforced via `tsconfig.json`)
- No `any` types — use `unknown` and type guards
- Meaningful variable names
- Comments only for non-obvious logic (why, not what)
- ESM modules (`"type": "module"`)

## Project structure

```
src/
  config/          — Environment validation
  database/        — Oracle 26ai connection + schema
  middleware/      — Express middleware (auth, rate limiting)
  presentation/    — HTTP server, MCP tools, REST routes, A2A
  services/        — Business logic (project, embedding, auth, memory)
  utils/           — Logger, context, helpers
  types/           — Shared TypeScript types
tests/
  unit/            — Unit tests (node:test)
  e2e/             — End-to-end tests
dashboard/         — React + Vite management dashboard
docs/              — Public documentation
scripts/           — Utility scripts (db-init, migrations)
sql/               — SQL schemas (A2A registry)
```

## Reporting bugs

Use the GitHub bug report template and include:

- the smallest reproducible example;
- expected and actual behavior;
- operating system and Node.js version;
- project version or commit SHA;
- database and deployment environment;
- redacted logs or stack traces.

## Questions?

Open a [discussion](https://github.com/giauphan/codeatlas-platform/discussions) or [issue](https://github.com/giauphan/codeatlas-platform/issues).

Thank you for contributing.
