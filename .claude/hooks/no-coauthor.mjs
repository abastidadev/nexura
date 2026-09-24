// PreToolUse (Bash|PowerShell): blocks any git commit / PR whose message carries attribution
// trailers (Co-Authored-By, Claude-Session, "Generated with Claude Code"). Project rule: NEVER.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN = /co-authored-by|claude-session|generated with \[?claude code/i;

const input = JSON.parse(readFileSync(0, "utf8"));
const command = String(input.tool_input?.command ?? "");
if (!/\bgit\b[^\n]*\bcommit\b|\bgh\s+pr\s+(create|edit)|\baz\s+repos\s+pr\b/.test(command)) {
  process.exit(0);
}

// The message may come from a file (git commit -F <file>, gh pr create --body-file <file>).
let text = command;
for (const match of command.matchAll(/(?:-F|--file|--body-file)[=\s]+("[^"]+"|'[^']+'|\S+)/g)) {
  const file = resolve(input.cwd ?? ".", match[1].replace(/^["']|["']$/g, ""));
  if (existsSync(file)) {
    text += "\n" + readFileSync(file, "utf8");
  }
}

if (FORBIDDEN.test(text)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Project rule (CLAUDE.md): NEVER add Co-Authored-By, Claude-Session or 'Generated with Claude Code' to commits or PRs. Remove those lines and run the command again.",
      },
    }),
  );
}
