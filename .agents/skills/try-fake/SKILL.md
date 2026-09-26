---
name: try-fake
description: Run Nexura UI and API with fake Claude, Codex and Copilot agents in an isolated temporary sandbox, without consuming agent quota. Use for manual UI and flow verification.
---

Read and follow [the shared try-fake workflow](../../../.claude/skills/try-fake/SKILL.md).
Keep the existing launcher at `.claude/skills/try-fake/start.mjs`; it resolves
the repository relative to its own location.

For the background-launch step, use a persistent Codex shell session and retain
its process/session handle so it can be stopped afterwards. If using PowerShell
`Start-Process`, include `-WindowStyle Hidden`, redirect stdout/stderr to temporary
log files and retain the returned process with `-PassThru`. Do not use Claude's
`run_in_background` parameter. Check startup output before opening the browser.

Use the Playwright MCP if available. If it is unavailable, report that browser
verification could not be performed; do not claim that an HTTP check verifies
the UI. Stop only the process started for this check. Preserve the real Nexura
instance on port 4310 and all real local data.
