// Starts Nexura against the fake agents (claude, codex, copilot) and a throwaway sandbox repo. No tokens, and it
// never touches data/, config/repos.json or ~/.claude.json.
//
//   node .claude/skills/try-fake/start.mjs [--port 4320] [--delay 2000]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fakeAgentsEnv, makeSandbox } from "../../../fixtures/sandbox.mjs";

const { values } = parseArgs({ options: { port: { type: "string", default: "4320" }, delay: { type: "string", default: "2000" } } });
const home = resolve(import.meta.dirname, "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "nexura-fake-"));
const { stateDir, prsFile, reposFile } = makeSandbox(root);

const githubPort = String(Number(values.port) + 1);
const github = spawn(process.execPath, [join(home, "fixtures", "fake-github.mjs"), "--port", githubPort, "--prs", prsFile, "--state", stateDir], {
  stdio: "inherit",
});

console.log(`Nexura (fake claude/codex/copilot, fake GitHub with 2 PRs) at http://localhost:${values.port} · temp dir: ${root}`);
const server = spawn(process.execPath, [join(home, "apps", "server", "src", "cli", "cli.ts"), "serve", "--port", values.port], {
  cwd: home,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXURA_DATA_DIR: join(root, "data"),
    NEXURA_REPOS: reposFile,
    ...fakeAgentsEnv({ root, stateDir, githubPort, delay: values.delay }),
  },
});
server.on("exit", (code) => {
  github.kill();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    github.kill(signal);
    server.kill(signal);
  });
}
