// A throwaway sandbox repo for the fake agents, with a "GitHub" origin for Revisiones: the URL is
// github.com's (so Nexura sees a GitHub repo) but git reaches a local bare repo through insteadOf, and
// the API is fixtures/fake-github.mjs. Used by /try-fake (.claude/skills/try-fake/start.mjs) and by
// `npm run demo` (scripts/demo.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const home = resolve(import.meta.dirname, "..");

/**
 * Builds the sandbox under `root`: the repo, its bare origin with two PRs, the PRs for the fake GitHub
 * and a repos.json pointing at the repo.
 */
export function makeSandbox(root) {
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

  const originUrl = "https://github.com/nexura-fake/sandbox.git";
  const bare = join(root, "sandbox.git").replace(/\\/g, "/");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  git("remote", "add", "origin", originUrl);
  git("config", `url.${bare}.insteadOf`, originUrl);
  git("push", "-q", "origin", "main");
  const prs = [
    {
      number: 1,
      branch: "feature/greet",
      title: "feat: saludo con nombre",
      body: "Añade `greet(name)` para saludar al usuario.\n\nCloses #6",
      closes: [{ number: 6, title: "Customers / Detail - Contact panel" }],
      labels: [{ name: "enhancement" }],
      requested_reviewers: [{ login: "nexura-fake" }],
      files: { "src/greet.js": 'export function greet(name) {\n  const who = name.trim();\n  return "Hola " + who;\n}\n' },
    },
    {
      number: 2,
      branch: "docs/readme",
      title: "docs: cómo arrancar el sandbox",
      body: "",
      files: { "README.md": "# sandbox\n\nArranca con `npm run check`.\n" },
    },
  ].map((pr) => {
    git("checkout", "-q", "-b", pr.branch, "main");
    for (const [file, content] of Object.entries(pr.files)) {
      mkdirSync(join(repoPath, file, ".."), { recursive: true });
      writeFileSync(join(repoPath, file), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", pr.title);
    // GitHub serves every PR's head as refs/pull/<n>/head.
    git("push", "-q", "origin", `${pr.branch}:refs/heads/${pr.branch}`, `${pr.branch}:refs/pull/${pr.number}/head`);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      user: { login: "ana-fake" },
      head: { ref: pr.branch, sha },
      base: { ref: "main" },
      draft: pr.number === 2,
      files: Object.entries(pr.files).map(([filename, content]) => ({ filename, status: "added", additions: content.split("\n").length - 1, deletions: 0 })),
      labels: pr.labels ?? [],
      requested_reviewers: pr.requested_reviewers ?? [],
      closes: pr.closes ?? [],
      html_url: `https://github.com/nexura-fake/sandbox/pull/${pr.number}`,
      created_at: new Date().toISOString(),
    };
  });
  git("checkout", "-q", "main");
  const prsFile = join(root, "prs.json");
  writeFileSync(prsFile, JSON.stringify(prs, null, 2));

  const reposFile = join(root, "repos.json");
  writeFileSync(
    reposFile,
    JSON.stringify({ repos: [{ name: "sandbox", path: repoPath, baseBranch: "main", checks: ["npm run check"], nodeModules: "none" }] }, null, 2),
  );
  return { repoPath, stateDir, prsFile, reposFile };
}

/** What Nexura runs with to use the fake agents and the fake GitHub on `githubPort`, keeping everything under `root`. */
export function fakeAgentsEnv({ root, stateDir, githubPort, delay }) {
  return {
    NEXURA_CLAUDE_BIN: join(home, "fixtures", "fake-claude.mjs"),
    NEXURA_CODEX_BIN: join(home, "fixtures", "fake-codex.mjs"),
    NEXURA_COPILOT_BIN: join(home, "fixtures", "fake-copilot.mjs"),
    NEXURA_TRUST_WORKTREES: "0",
    // Revisiones: the sandbox's PRs come from the fake GitHub, never from the real one.
    NEXURA_GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
    GH_TOKEN: "fake",
    FAKE_STATE_DIR: stateDir,
    FAKE_SUBAGENTS: "1",
    FAKE_DELAY_MS: String(delay),
    // Terminal conversations: the fakes' interactive mode writes its session transcripts here, like the real CLIs.
    CLAUDE_CONFIG_DIR: join(root, "claude-home"),
    CODEX_HOME: join(root, "codex-home"),
    COPILOT_HOME: join(root, "copilot-home"),
  };
}
