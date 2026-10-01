# How the department writes agent configuration

Condensed from the ai-toolkit repository (`CLAUDE.md`, `CONTRIBUTING.md`,
`docs/writing-skills.md`, `docs/writing-agents.md`, `docs/mcp-servers.md`). When the
repository you are working on is the toolkit itself, its own files win over this copy.

## Which piece

| Need | Piece | Where |
|---|---|---|
| A rule that applies to the whole repository, always | `CLAUDE.md` (shared with Codex through `AGENTS.md`) | repo root, or a subfolder for local rules |
| A repeatable procedure with its own method (open a PR, generate a migration, check before pushing) | **skill** | `.claude/skills/<name>/SKILL.md` |
| Heavy exploration or review whose conclusion is all you need (reads 30 files to answer) | **agent** | `.claude/agents/<name>.md` |
| Something that must **always** happen, or never (block a command, format after an edit, run the typecheck before stopping) | **hook** | `.claude/settings.json` + a Node script in `.claude/hooks/` |
| Access to an external system (a tracker, a browser, library docs) | **MCP server** | `.mcp.json` |
| Several of the above shared by many repositories | **plugin** | the ai-toolkit marketplace |

- Skill or agent: if it will edit three files, it is a skill; if it will read thirty to
  answer a question, it is an agent. A skill runs in the main thread and you see each step;
  an agent works in its own context and only returns its final message.
- Not a skill: general knowledge the model already has, or rules for the whole repository
  (`CLAUDE.md`). Not a rule in `CLAUDE.md`: automation that must always run (a hook).
- **Never duplicate a built-in.** A skill competing with `/code-review`, `/simplify`,
  `/security-review` or `/init` loses the trigger and never runs.
- **Never duplicate a toolkit piece** the repository already gets from an installed plugin,
  and never declare the same MCP server twice (in `.mcp.json` and through a plugin): the
  tools appear twice under different names.

## Project or toolkit

The test: **would this rule be wrong in another repository?** Not irrelevant - wrong.

- If it only holds for this repository (its folders, its scripts, its domain), it goes in
  the repository: `.claude/skills/`, `.claude/agents/`, `CLAUDE.md`. A project skill may
  name the project's own paths and commands.
- If it holds for every repository of a stack, it belongs in the toolkit: `core` (git and
  writing, any stack or provider), `dotnet`, `angular`, `azure-devops` (anything that
  talks to the Azure DevOps server), `browser` (checking a frontend in a real browser),
  or a new plugin for a new stack.
- When a convention is shared but its mechanics differ, split it: the convention in `core`,
  the mechanics in the provider's plugin.
- **A toolkit skill names no project**: no repository names, client names, absolute paths
  or connection strings. It discovers the context (solution file, `package.json`, base
  branch) instead of assuming it. Base branches differ per repository (`dev`, `master`,
  `main`): never hardcode one.

## Writing a skill

1. Start from `SKILL.md.template`. The folder name and the frontmatter `name` match, in
   kebab-case.
2. **The `description` decides whether the skill ever fires.** It is the only thing the
   model sees before invoking it. It says what the skill does and **when to use it**, with
   the phrases people actually type ("open a PR with this", "fix the tests").
3. **Append the Spanish trigger phrases**: `Tambien en espanol - "...", "...".`, written as
   the sentences people say, without accents. Measured: without them the skill does not
   fire for Spanish prompts, and a shared technical noun ("push") is not enough.
4. The body: one or two sentences of context, then numbered steps with copy-pasteable
   commands. Start by discovering the context (an inspection command), prefer "look at X and
   act on what you see" over "always do Y", and end with how to verify.
5. **End with a `## Limits` section**: what the skill must not do (push, delete, vote, close
   tickets, install things). It prevents most of the scares.
6. Keep it under ~200 lines. Longer usually means two skills, or content for a supporting
   file next to `SKILL.md`, referenced as `${CLAUDE_PLUGIN_ROOT}/skills/<name>/<file>` in a
   plugin (never an absolute path).
7. The body is in English. Only the trigger phrases are bilingual.
8. Two kinds: **adaptive** (detect what the project does and follow it) and
   **prescriptive** (state the department's standard). Both start from the same rule: the
   code in front of you outranks the skill.
9. Invocation: `disable-model-invocation: true` for user-only skills with side effects
   (deploy, release); omit it otherwise.

## Writing an agent

1. Start from `agent.md.template`. One file per agent, one responsibility per agent: an
   "agent that reviews, fixes and documents" does all three badly.
2. `description`: written for whoever decides to delegate - what it does and when to pick it.
3. **`tools` is always restricted.** A read-only agent carries no `Edit` or `Write`; a
   `*-reviewer` never can write. `model` is optional: omit it to inherit, `sonnet` for
   mechanical, high-volume work.
4. Body in the second person, three blocks: **Method** (steps), **Deliver** (what it returns:
   paths with line numbers, a concrete failure scenario) and **Limits**.
5. The final message is the only thing the agent returns, so it must stand on its own, and
   it states what it looked for and **did not** find instead of padding with suspicions.

## Writing a hook

- A Node script (`node "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.mjs"` in a project,
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"` in a plugin) registered in `settings.json`
  or the plugin's `hooks/hooks.json`. No shell-specific one-liners: people run Windows.
- Shell guards match `Bash|PowerShell`: on Windows the model can use either.
- Deny with a reason the model can act on; never silently rewrite a command.
- A hook that guards commands gets its test cases (known commands and the expected verdict).

## MCP servers

- Declared in `.mcp.json` (project) or in the plugin that needs it, never pasted into each
  person's config.
- **Pinned version** (`npx -y package@1.2.3`): without it the whole team's tooling changes
  under them. Bump it deliberately.
- **No secrets in the file.** Authenticate through an existing login (`az login`,
  `gh auth login`) or an environment variable expanded with a default
  (`"${CONTEXT7_API_KEY:-}"`). Never a token in a committed file.
- Limit the tool surface (domains, read-only flags): every connected server puts all its
  tool definitions into every session.

## Plugins (toolkit repository only)

- Layout: `plugins/<plugin>/.claude-plugin/plugin.json`, `skills/<name>/SKILL.md`,
  `agents/<name>.md`, `hooks/hooks.json`, `.mcp.json`, `evals/<skill>-<lang>/`. Every plugin is
  listed in `.claude-plugin/marketplace.json`.
- Finishing a change: bump `version` in the plugin's `plugin.json` (new skill or agent:
  minor; fix: patch; rename or removal: major), keep `description` identical in
  `plugin.json` and `marketplace.json`, add a line to `CHANGELOG.md`
  (`- **plugin** vX.Y.Z - description` under today's date), update the README plugin table
  when a skill or agent is added, moved or removed.
- Every new skill gets a trigger eval: `evals/<skill>-es/prompt.md` (frontmatter with
  `max_turns: 3` or more) plus the graders `skill-fired.md` (`tool_used: Skill`) and
  `right-skill.md` (`llm`, `focus: trace`, naming `plugin:skill`). Run it with
  `claude plugin eval plugins/<plugin> --case "<skill>-*" --runs 3 --ablation none`.
- Validate with `.\scripts\validate.ps1`, `node scripts/test-hooks.js` and
  `claude plugin validate .`.

## Working agreements

- Everything committed is in **English**; prose to the user is in Spanish.
- **No AI attribution**: no `Co-Authored-By`, no "Generated with", in commits, PRs or in
  any text a piece makes the model write. Prefer `"attribution": { "commit": "", "pr": "" }`
  in settings.
- Nothing is published without a go-ahead: commits, pushes, PRs, comments, votes and work
  items are the person's call. Skills that draft them show the draft and wait.
- A piece is not "working" until it has been seen firing in a real repository.
