# Nexura — Codex

Read and follow [CLAUDE.md](CLAUDE.md) before working on this repository. It is
the shared source of project conventions, commands, quota limits and local-data
rules for both assistants. Its project rules take precedence over generic skills
(in particular: no automatic commit/push and no formatting existing files).

## Codex integration

- Project configuration: `.codex/config.toml`; start Codex from the repository root.
- Skills: `.agents/skills/new-step` and `.agents/skills/try-fake`. They reuse the
  workflows in `.claude/skills/`; use `$new-step` and `$try-fake` in Codex.
- Custom reviewers: `step-config-reviewer` and `security-reviewer` under
  `.codex/agents/`. Delegate to them when a task calls for the relevant review;
  give them a bounded scope. They inherit the parent model and only read.
- MCPs: `angular-cli`, `playwright`, `github`, `context7`, `nexura-memory`.
  Search memory before repository decisions when available. If a required MCP
  is unavailable, report that and use an appropriate local/read-only fallback.
- Never read `.env` or `.env.*`. Never hand-edit `data/`, `config/repos.json`
  or `package-lock.json`. Use the supported application/API/MCP workflows for
  local data and npm for the lockfile.
- After TypeScript edits run `npm run typecheck` and
  `npx tsc -p apps/web/tsconfig.app.json --noEmit`; run `npm run build:web` when
  Angular templates change. Run relevant tests as described in `CLAUDE.md`.
  These instructions also apply if hooks are not yet trusted or are unavailable.
- Do not run real Nexura agents to verify this configuration. Use fake agents.

Claude permissions and its TypeScript LSP plugin are not Codex configuration.
Codex uses its own tool permissions and the TypeScript compiler checks above.
Setup, hook activation and validation: [docs/codex.md](docs/codex.md).
