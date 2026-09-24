// Stop: if any .ts changed (tracked or new), typecheck server/shared and the web before
// Claude finishes. Errors go back to Claude (exit 2). Blocks only once per stop, so an
// error Claude cannot fix never traps it in a loop.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) {
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const run = (command) => execSync(command, { cwd: root, encoding: "utf8", stdio: "pipe" });

const changed = run("git status --porcelain --untracked-files=all")
  .split("\n")
  .some((line) => /\.ts"?$/.test(line.trim()) && !line.startsWith(" D") && !line.startsWith("D "));
if (!changed) {
  process.exit(0);
}

const checks = [
  ["server/shared", "npx tsc -p tsconfig.json"],
  ["web", "npx tsc -p apps/web/tsconfig.app.json --noEmit"],
];
const failures = [];
for (const [name, command] of checks) {
  try {
    run(command);
  } catch (error) {
    failures.push(`## ${name} (${command})\n${(error.stdout || error.stderr || error.message).trim()}`);
  }
}

if (failures.length) {
  console.error(`There are type errors; fix them before finishing:\n\n${failures.join("\n\n")}`);
  process.exit(2);
}
