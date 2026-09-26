---
name: try-fake
description: Starts Nexura (UI + API) with FAKE agents (claude, codex, copilot) and a temporary sandbox repo, to see the UI, the pixel-art office or a full flow without spending quota. Use it to manually verify web or orchestrator changes, or when the user asks to "run", "try" or "see" Nexura without tokens.
---

# Nexura without tokens

`start.mjs` sets up an isolated environment in a temp directory and starts the server:

- a `sandbox` git repo with an `npm run check` check (like the orchestrator tests);
- `NEXURA_REPOS` pointing at that repo (never touches `config/repos.json`);
- a temporary `NEXURA_DATA_DIR` (never touches `data/`);
- `NEXURA_CLAUDE_BIN=fixtures/fake-claude.mjs` with subagents and a delay between events, plus `NEXURA_CODEX_BIN` / `NEXURA_COPILOT_BIN` pointing at `fixtures/fake-codex.mjs` and `fixtures/fake-copilot.mjs`;
- `NEXURA_TRUST_WORKTREES=0` (never touches `~/.claude.json`);
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` in the temp directory: in the **Terminal** section the fakes run in interactive mode (`fixtures/fake-interactive.mjs`, a line REPL that answers every message) and save their sessions there, so resuming and switching agent (handoff) work without tokens.

## Steps

1. If `apps/web/dist/web/browser` does not exist or you changed the web, build first: `npm run build:web`.
2. Start it **in the background** (Bash with `run_in_background`):
   ```bash
   node .claude/skills/try-fake/start.mjs            # port 4320 by default
   node .claude/skills/try-fake/start.mjs --port 4330 --delay 500
   ```
   The first output line shows the URL and the temp directory.
3. Open `http://localhost:<port>` (with the Playwright MCP if available) and create a flow on the **sandbox** repo. The fake claude creates `done.txt` in `implement`, so the `npm run check` QA check passes.
4. Optional fake variables (see the header of `fixtures/fake-steps.mjs`, shared by the three fakes): `FAKE_REVIEW_REJECTS=1` (codeReview rejects once), `FAKE_FAIL_MARKER=<text>` (enrich fails if the prompt contains it).
5. To see a flow that mixes agents, create a profile in Configuración → Perfiles with some steps on Codex or Copilot (and, with the blind review, judge B on another agent). Do not add it to `config/profiles/` by hand: that folder is tracked.
6. When done, stop the background process.

Do not use port 4310: the user's real Nexura usually runs there.
