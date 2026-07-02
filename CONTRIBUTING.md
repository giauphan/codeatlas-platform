# Contributing to CodeAtlas AI

Thank you for your interest in contributing! We welcome contributions from the community.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. **Fork** the repository
2. **Clone** your fork:
   ```bash
   git clone git@github.com:your-username/codeatlas-platform.git
   cd codeatlas-platform
   ```
3. **Install dependencies**:
   ```bash
   pnpm install
   ```
4. **Build**:
   ```bash
   pnpm run build
   ```
5. **Run tests**:
   ```bash
   pnpm test
   ```

## Development Workflow

- Create a feature branch: `git checkout -b feat/your-feature`
- Make your changes
- Write or update tests as needed
- Run the full test suite: `pnpm test`
- Ensure TypeScript compiles: `pnpm run build`
- Commit with conventional commits (see below)
- Push and open a Pull Request

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `test:` — Adding or fixing tests
- `chore:` — Maintenance, dependencies, tooling
- `perf:` — Performance improvement
- `security:` — Security fix

## Pull Request Process

1. Update the README or documentation if your change requires it
2. Add tests for new functionality
3. Ensure all tests pass
4. Your PR will be reviewed by maintainers
5. Squash merge will be used

## Code Style

- TypeScript strict mode
- Prettier for formatting
- Meaningful variable names
- Comments for non-obvious logic
- No `any` types — use `unknown` and type guards

## Project Structure

```
src/
  config/        — Configuration and environment validation
  database/      — Oracle 26ai database connection
  middleware/     — Express middleware (auth, rate limiting)
  presentation/  — HTTP server, MCP tools, REST routes
  repositories/  — Data access layer
  services/      — Business logic (project, embedding, auth, memory)
  utils/         — Logger, context, helpers
tests/
  unit/          — Unit tests
  integration/   — Integration tests
dashboard/       — React dashboard frontend
docs/            — Documentation
scripts/         — Utility scripts
```

## Questions?

Open a [discussion](https://github.com/giauphan/codeatlas-platform/discussions) or [issue](https://github.com/giauphan/codeatlas-platform/issues).
