# ai-toolkit templates

Copied verbatim from the ai-toolkit repository (`templates/` and an existing trigger eval). Start every new skill, agent or plugin from these.

## templates/SKILL.md.template

````markdown
---
name: name-in-kebab-case
description: What it does, in one sentence. Then "Use when the user ..." with the actual words people will say when they ask for it. This line is the only thing Claude sees until it decides to invoke the skill: if it does not say when to use it, the skill will never fire. Tambien en espanol - "the phrases", "people type in Spanish", "without accents".
---

# Skill title

One or two sentences of context: what problem it solves and the principle that guides
the steps below.

## 1. Get your bearings

Always start by discovering the context instead of assuming it. Concrete commands for
finding out which project, stack or configuration you are working with.

```
inspection command
```

## 2. Do the work

Numbered steps. Each one a concrete, verifiable action.
Prefer "look at X and act on what you see" over "always do Y".

## 3. Verify

How to check it went well. The command to run and the expected result.

## Limits

What the skill must NOT do. This matters as much as everything above: it is what keeps
Claude from overreaching (pushing, deleting, closing tickets, installing dependencies).
````

## templates/agent.md.template

````markdown
---
name: name-in-kebab-case
description: What the agent is for and when to launch it. Written so that whoever delegates can tell whether this is the right agent.
tools: Read, Glob, Grep, Bash
model: sonnet
---

A sentence defining the role in the second person: "You review...", "You locate...",
"You migrate...".

Method:
1. Concrete step.
2. Concrete step.

Deliver:
- What the agent returns and in what format.
- Paths with line numbers where applicable.

Limits:
- What it must not do (for example, modifying files if it is read-only).

Notes:
- `tools` restricts the available tools. A read-only agent must not include Edit or Write.
- `model` is optional; omit it to inherit the main thread's model.
````

## templates/plugin.json.template

````json
{
  "name": "plugin-name",
  "description": "What this plugin groups together and who it is for. It shows up in the /plugin listing, so it has to stand apart from the others at a glance.",
  "version": "0.1.0",
  "author": { "name": "Development Department" }
}
````

## Trigger eval: plugins/<plugin>/evals/<skill>-es/prompt.md

````markdown
---
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
tags: [trigger, es]
---

haz commit de los cambios que tengo pendientes
````

## Trigger eval: plugins/<plugin>/evals/<skill>-es/graders/skill-fired.md

````markdown
---
type: tool_used
tool: Skill
---
````

## Trigger eval: plugins/<plugin>/evals/<skill>-es/graders/right-skill.md

````markdown
---
type: llm
focus: trace
---

The trace shows a Skill tool call whose skill is `core:commit` (or `commit`).
Pass only if that exact skill was invoked, whatever else happened.
````

## A plugin hook that auto-approves the plugin's own MCP server (plugins/<plugin>/hooks/hooks.json)

````json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^mcp__plugin_core_context7__.*$",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "-e",
              "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))"
            ]
          }
        ]
      },
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/guard-git.js\""
          }
        ]
      }
    ]
  }
}
````
