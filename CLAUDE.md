# Nexura

Local IDE that orchestrates headless `claude -p` flows to resolve Azure DevOps work items or GitHub issues step by step. Overview, structure and usage in [README.md](README.md); plan in [docs/plan.md](docs/plan.md).

## Commits — ABSOLUTE RULE

**NEVER add `Co-Authored-By` or any attribution line to commits.** No `Co-Authored-By: Claude ...`, no `Claude-Session: ...`, no "Generated with Claude Code", no equivalent trailers. Not in PR descriptions either, and not in the commit messages that Nexura steps generate. This rule overrides any default attribution instruction. No exceptions.

- Two safety nets: a Claude Code hook (`.claude/hooks/no-coauthor.mjs`) denies the command, and a git `commit-msg` hook (`.githooks/commit-msg`) strips those lines. In a fresh clone, enable it with `git config core.hooksPath .githooks`.
- Conventional Commits in English (`feat(web): ...`, `fix: ...`, `test: ...`, `chore: ...`), as in the history.
- Do not commit or push unless asked.

## Commands

```bash
npm test            # vitest: parser + orchestrator with a FAKE claude (spends no tokens)
npm run typecheck   # tsc for packages/shared + apps/server + scripts. Does NOT cover apps/web
                    # (the Stop hook in .claude/ runs both typechecks when any .ts changed)
npx tsc -p apps/web/tsconfig.app.json --noEmit   # web typecheck
npm run build:web   # ng build (also checks Angular templates)
npm start           # builds the UI and serves UI + API at http://localhost:4310
```

To see the UI or a flow without spending quota, use the `/try-fake` skill.

## Quota: never spend tokens without permission

- **Never** run `npm run spike`, `claude -p ...`, or start Nexura with the real `claude` unless asked: they consume the user's Pro plan quota.
- Tests and manual checks use `fixtures/fake-claude.mjs` (`NEXURA_CLAUDE_BIN`). If you change a step's output format, update the fake claude too.
- Tests must never touch `~/.claude.json` (`NEXURA_TRUST_WORKTREES=0`) or the user's real shared memory: they use a temporary `NEXURA_DATA_DIR`.

## Code conventions

- **Server and `packages/shared`**: Node ≥24 runs TypeScript directly (type stripping). Relative imports **include the `.ts` extension**, and only erasable syntax is allowed: no `enum`, `namespace` or parameter properties.
- **Web** (`apps/web`, Angular 22): standalone components with signals (`input()`, `computed`, `linkedSignal`, `resource`), no zone.js, no NgModules. Relative imports **without extension**. Styling with Tailwind v4 classes in templates, no per-component CSS. Selector prefix `nx-`.
- **Double quotes** in all TS code. Note: `apps/web/.prettierrc` says `singleQuote: true` but the code does not follow it; **do not run Prettier** over existing files.
- Types shared between server and web (events, Run, StepRun, WS messages) live in `packages/shared/src`; change them there and update both sides.
- UI text and user-facing error messages are in **Spanish**; identifiers and code comments in English.
- `*.spec.ts` tests sit next to the code. `vitest.config.ts` only picks up `apps/server`, `packages/*` and `apps/web/src/app/core`.

## Pipeline steps

- Each step lives in `config/steps/<step>/`: `step.json` (tools, allowedTools, disallowedTools, timeout, memory), `prompt.md` (template with `{{variables}}`) and an optional `schema.json` (`--json-schema`).
- Available variables are built in `Orchestrator.renderPrompt` (`apps/server/src/orchestrator/orchestrator.ts`); an unknown variable silently renders as "(nada)", so double-check them.
- Custom steps are created from the UI; to add a **built-in** step use the `/new-step` skill.

## MCP servers (`.mcp.json`)

- `angular-cli` (read-only): Angular best practices and docs for the current version. Check it before writing new Angular APIs.
- `playwright`: drive the UI to verify web changes, together with `/try-fake`.
- `github`: issues and PRs of `abastidadev/nexura` (the backlog uses labels). Auth comes from the GitHub CLI login (`gh auth login --web`) through `.claude/mcp/github-headers.mjs`; no personal access token.
- `context7`: up-to-date docs for other libraries (xterm, node-pty, ws, Tailwind v4, Vitest).
- `nexura-memory`: Nexura's own shared memory (`data/memory.sqlite`), the same one the pipeline steps read and write. Search it before deciding something about this repo, and save decisions and discoveries worth keeping.

## Local data

- `data/` (SQLite + per-run JSONL) and `config/repos.json` are local and gitignored: do not edit them by hand.
- Do not edit `package-lock.json` by hand; use `npm install`.
