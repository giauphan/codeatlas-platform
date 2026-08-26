# Release checklist

Run through this checklist before tagging a release. Each item is a gate — if any fails, block the release.

## 1. Pre-release verification

- [ ] All tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm run build`
- [ ] Dashboard builds: `cd dashboard && pnpm run build`
- [ ] TypeScript type-check clean: `npx tsc --noEmit --skipLibCheck`
- [ ] No secrets in diff: `git diff main --check` and grep for `ghp_`, `sk-`, `ca_`, `firebase-adminsdk`
- [ ] `CHANGELOG.md` updated with new version + entry
- [ ] Version bumped in `package.json` (semver: patch/minor/major)
- [ ] `ROADMAP.md` updated (move items to Shipped)

## 2. Package boundary check

- [ ] `pnpm pack --dry-run` shows only: `dist/src`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`
- [ ] No `tests/`, `src/`, `scripts/`, `benchmark_*.ts`, `*.sh` in pack output
- [ ] No secret files in pack output (`.env`, `serviceAccountKey.json`)

## 3. Security review

- [ ] `git remote -v` shows no embedded credentials in URL
- [ ] `git log --all --source --remotes -- serviceAccountKey.json .env` returns nothing on `main`
- [ ] No new `.sh` files with hardcoded tokens tracked in git
- [ ] `.gitignore` covers all secret-bearing files
- [ ] Dependencies audited: `pnpm audit --prod` (no high/critical vulnerabilities)

## 4. Documentation

- [ ] `README.md` badges reflect current version
- [ ] All internal markdown links resolve (`grep -oE '\]\([^)]+\.md[^)]*\)' README.md`)
- [ ] `CHANGELOG.md` date is correct
- [ ] `docs/CONFIGURATION.md` env var table matches actual env vars used in `src/config/env.ts`
- [ ] `docs/API_EXAMPLES.md` endpoints match actual routes

## 5. Commit and tag

- [ ] Stage only intended files: `git status` shows no surprises
- [ ] Commit with message: `chore(release): vX.Y.Z`
- [ ] Tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
- [ ] Push tag: `git push origin vX.Y.Z`
- [ ] Push main: `git push origin main`

## 6. Publish (npm)

- [ ] `pnpm publish --access public` (for `codeatlas-ai` package)
- [ ] Verify on npmjs.com: `https://www.npmjs.com/package/codeatlas-ai`
- [ ] Test install in clean dir: `npm install codeatlas-ai && npx codeatlas-mcp --help`

## 7. GitHub release

- [ ] Create release on GitHub: `https://github.com/giauphan/codeatlas-platform/releases/new`
- [ ] Use tag `vX.Y.Z`
- [ ] Copy `CHANGELOG.md` entry into release notes
- [ ] Attach any binary artifacts if applicable

## 8. Post-release

- [ ] Announce in GitHub Discussions
- [ ] Update `ROADMAP.md` — move shipped items to "Shipped" section
- [ ] Bump version in `package.json` to next `-dev` suffix (e.g., `2.15.0-dev.0`)
- [ ] Commit: `chore: bump to X.Y.Z-dev.0`

## Rollback

If a release is broken:

1. `npm unpublish codeatlas@X.Y.Z` (within 72 hours only)
2. `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`
3. Delete GitHub release
4. Notify users via GitHub Discussions
5. Fix forward and re-release as `X.Y.Z+1`
