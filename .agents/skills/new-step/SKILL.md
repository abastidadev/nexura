---
name: new-step
description: Add a built-in Nexura pipeline step across configuration, shared types, orchestrator, UI and fake-agent tests. Custom prompt-only steps belong in the UI.
---

Read and follow [the shared new-step workflow](../../../.claude/skills/new-step/SKILL.md).
Treat `$ARGUMENTS` as the user's step name and description. An explicit request
for a built-in step already supplies the workflow's initial confirmation; ask
only if that distinction is unresolved.

Use `$try-fake` where the shared workflow says `/try-fake`. Fake responses live
in `fixtures/fake-steps.mjs`, shared by all three fake agent entrypoints.
Use Codex file and shell tools for the checklist. Do not invoke Claude to carry
out the skill.
