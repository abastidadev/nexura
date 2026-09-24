// Starts Nexura against the fake claude and a throwaway sandbox repo. No tokens, and it
// never touches data/, config/repos.json or ~/.claude.json.
//
//   node .claude/skills/try-fake/start.mjs [--port 4320] [--delay 2000]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4320" }, delay: { type: "string", default: "2000" } } });
const home = resolve(import.meta.dirname, "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "nexura-fake-"));
const repoPath = join(root, "sandbox");
const stateDir = join(root, "state");
mkdirSync(repoPath, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const git = (...args) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.email", "fake@nexura.local");
git("config", "user.name", "nexura-fake");
writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
writeFileSync(
  join(repoPath, "package.json"),
  JSON.stringify({ name: "sandbox", scripts: { check: "node -e \"process.exit(require('fs').existsSync('done.txt')?0:1)\"" } }, null, 2),
);
writeFileSync(join(repoPath, "README.md"), "# sandbox\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const reposFile = join(root, "repos.json");
writeFileSync(
  reposFile,
  JSON.stringify({ repos: [{ name: "sandbox", path: repoPath, baseBranch: "main", checks: ["npm run check"], nodeModules: "none" }] }, null, 2),
);

console.log(`Nexura (fake claude) at http://localhost:${values.port} · temp dir: ${root}`);
const server = spawn(process.execPath, [join(home, "apps", "server", "src", "cli", "cli.ts"), "serve", "--port", values.port], {
  cwd: home,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXURA_DATA_DIR: join(root, "data"),
    NEXURA_REPOS: reposFile,
    NEXURA_CLAUDE_BIN: join(home, "fixtures", "fake-claude.mjs"),
    NEXURA_TRUST_WORKTREES: "0",
    FAKE_STATE_DIR: stateDir,
    FAKE_SUBAGENTS: "1",
    FAKE_DELAY_MS: values.delay,
  },
});
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
