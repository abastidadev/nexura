# Catalogue of the department's ai-toolkit

The ai-toolkit is a Claude Code plugin marketplace. Install from it before writing anything
new: a piece that already exists there is maintained by everyone.

| Plugin | Contents | Install |
|---|---|---|
| `core` | skills `commit`, `pre-push-check`, `write-docs`; agent `code-explorer`; a hook that blocks destructive git commands and AI-signed commits (Bash and PowerShell); the Context7 MCP server. Also installs Anthropic's read-only `claude-code-setup` recommender. | once per person (user scope) |
| `azure-devops` | skills `create-pr`, `pr-mechanics`, `address-pr-feedback`, `pipeline-failure`, `work-item`, `create-work-item`; agent `pr-reviewer`; the Azure DevOps MCP server and a hook that rejects AI-signed text | once per person (user scope) |
| `angular` | the department's Angular standard: `ng-conventions`, `ng-architecture`, `ng-signalstore`, `ng-i18n`, `ng-devextreme`, `ng-test`, `ng-upgrade`; agents `angular-developer`, `angular-reviewer`; the Angular CLI MCP server | per Angular repository (project scope) |
| `browser` | skill `browser-check`; the Playwright and chrome-devtools MCP servers | per frontend repository (project scope) |
| `dotnet` | skills `dotnet-test`, `dotnet-scaffold-api`, `ef-migration`; agent `dotnet-reviewer`; the Microsoft Learn MCP server | per .NET repository (project scope) |

Commands:

```
claude plugin marketplace add https://github.com/abastidadev/ai-toolkit
claude plugin install core@ai-toolkit
claude plugin install azure-devops@ai-toolkit
claude plugin install angular@ai-toolkit --scope project   # writes .claude/settings.json: commit it
claude plugin install browser@ai-toolkit --scope project
claude plugin install dotnet@ai-toolkit --scope project
```

- A stack plugin installed for the user loads in every repository: its skills compete for the
  trigger with the other stack's, and its MCP servers start in every session. Stack plugins
  go in each repository with `--scope project`.
- The prescriptive Angular skills target Angular 17+ with signals, Transloco and DevExtreme;
  on a project that does not use those libraries, recommend only what applies.
- `core` already ships Context7: a repository that also declares `context7` in `.mcp.json`
  gets the tools twice. Same for `angular-cli` (angular plugin) and `playwright` (browser).
- Other agents (Copilot, Cursor, Codex) get the skills only, with
  `npx skills add https://github.com/abastidadev/ai-toolkit --skill '*' -a <agent>`. Never both
  routes for the same agent.
- The toolkit deliberately ships no code review skill: `/code-review` is built in.
- `templates/CLAUDE.base.md` (the department's working agreements: Spanish to the user,
  English in the repository, nothing published without a go-ahead, no AI attribution) is
  copied by hand into a repository's `CLAUDE.md`; no plugin installs it.

## claude-code-setup (Anthropic, claude-plugins-official)

Its `claude-automation-recommender` skill analyses a codebase and recommends the top one or
two hooks, subagents, skills, plugins and MCP servers, read-only. Nexura's assessment follows
the same method, adapted to the toolkit. It arrives with `core@ai-toolkit`; on its own:
`claude plugin install claude-code-setup@claude-plugins-official`.
