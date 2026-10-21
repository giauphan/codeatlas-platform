# CodeAtlas Platform agent guide

## Scope and layout

This repository is the CodeAtlas backend platform. The Express/MCP/API code is
under `src/`; tests are under `tests/`; operational scripts are under
`scripts/`; and the React/Vite dashboard is a separate project in `dashboard/`.
The default local database is `data/codeatlas.db`.

## Working conventions

- Prefer small, project-scoped changes. Inspect existing patterns and focused
  tests before editing a behavior.
- Keep TypeScript strict. Use `unknown` plus narrowing at untrusted boundaries;
  do not introduce `any` to bypass typing.
- Use ESM imports and comments that explain non-obvious decisions, not syntax.
- Add or update a focused `node:test` test whenever behavior changes.
- Preserve project and tenant identity boundaries. Memory, checkpoint, and
  reconciliation changes must remain scoped by canonical `project_id`.

## Commands

Run commands from the repository root unless a command says otherwise:

```bash
npm run typecheck
npm run build
npm test
npm run test:memory-pipeline
```

Use the smallest relevant test while iterating. Run the memory-pipeline
acceptance check for changes to hooks, capture, checkpoints, dreams, or
reconciliation. Dashboard changes require their own checks:

```bash
cd dashboard
pnpm test
pnpm run build
```

## Safety

- Never commit `.env`, service-account files, API keys, SQLite databases,
  logs, `node_modules`, or generated `dist` output.
- Treat external requests, transcript payloads, memory records, and MCP input
  as untrusted. Validate schemas and redact secrets before persistence or logs.
- Do not remove ignored files or `data/` as cleanup; they may contain active
  local state.
- Stage only files belonging to the current task. Do not reset, overwrite, or
  discard unrelated work in a dirty tree.

## Git and handoff

Use a focused branch and Conventional Commit message. Before opening a PR,
run the relevant checks above and report any checks that require configured
local services or credentials instead of fabricating a result.
