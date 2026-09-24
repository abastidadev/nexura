---
name: new-step
description: Adds a new BUILT-IN step to the Nexura pipeline (config/steps + shared + orchestrator + web + fake claude + tests). Custom steps are created from the UI; this skill is for steps the orchestrator handles with its own code.
disable-model-invocation: true
argument-hint: <stepName> [description]
---

# New built-in step: `$ARGUMENTS`

First confirm with the user that it really needs to be a **built-in** step. If all it needs is a prompt that runs after another step, it is a custom step created from the UI (Settings → Steps), with no code changes.

Use a similar existing step as reference: `classify` or `qaNotes` if it only reads, `implement` or `addressReview` if it edits code, `qaCode` or `release` if it is `builtin` (no LLM).

## Checklist

1. **`config/steps/<step>/`**
   - `step.json`: `kind` (`claude` | `builtin`), `tools` (hard allowlist for `--tools`), `allowedTools`, `disallowedTools`, `useMcp`, `memory` (`off` | `read` | `readwrite`) and `timeoutMs`. Grant the **minimum** tools. If it edits code, copy the `disallowedTools` of `implement` (no commit, push, checkout or reset).
   - `prompt.md` in Spanish (the prompts are written in Spanish). Only use variables that exist in `Orchestrator.renderPrompt` and `repoContextVars` (`apps/server/src/orchestrator/orchestrator.ts`): `ticket`, `tasks`, `repos`, `userPrompt`, `profiles`, `ledger`, `feedback`, `repoMap`, `repoNotes`, `memory` and `output.<earlierStep>`. An unknown variable silently renders as "(nada)".
   - `schema.json` if the orchestrator needs structured output: `additionalProperties: false` and every field in `required`.
2. **`packages/shared/src/flow.ts`**: add the name to `STEP_NAMES` in its pipeline position. Add its output type if needed.
3. **Orchestrator** (`apps/server/src/orchestrator/orchestrator.ts`): what it does with the output (ledger, tasks, commits, looping back to `implement`…). If it is `builtin`, it goes in `builtin-steps.ts`.
4. **Profiles** (`config/profiles/*.json`): decide which profiles enable it, with which model and effort. The cheapest step that works.
5. **Web**: add its label to `STEP_LABELS` (`apps/web/src/app/core/format.ts`). If it has its own output, show it in the inspector or in the right panel of `run-view`.
6. **Fake claude** (`fixtures/fake-claude.mjs`): detect the step from the prompt and return output that is valid for its schema. Otherwise the tests and `/try-fake` break.
7. **Tests** (`apps/server/src/orchestrator/orchestrator.spec.ts`): the step runs in the profile that has it, and its output has the expected effect.
8. **Checks**: `npm test`, `npm run typecheck`, `npx tsc -p apps/web/tsconfig.app.json --noEmit` and, to see it in the UI, `/try-fake`.
9. Update the README if the step changes the flow the user sees.
