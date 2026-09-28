import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Worktree } from "@nexura/shared";
import { commitAll, copyLocalClaudeConfig, defaultBranch, freeBranchName, linkNodeModules, removeWorktree, unlinkNodeModules } from "./git.ts";

const repo = mkdtempSync(join(tmpdir(), "nexura-git-"));
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "test@nexura.local");
git("config", "user.name", "nexura-test");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-qm", "init");

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("freeBranchName", () => {
  it("keeps the name when it is free and adds -2, -3… when a previous run left the branch", async () => {
    expect(await freeBranchName(repo, "feat/2-ticket")).toBe("feat/2-ticket");
    git("branch", "feat/2-ticket");
    expect(await freeBranchName(repo, "feat/2-ticket")).toBe("feat/2-ticket-2");
    git("branch", "feat/2-ticket-2");
    expect(await freeBranchName(repo, "feat/2-ticket")).toBe("feat/2-ticket-3");
  });
});

describe("defaultBranch", () => {
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "nexura-base-"));
    dirs.push(dir);
    return dir;
  };
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("takes the remote's default branch of a clone, whatever its name", async () => {
    const origin = scratch();
    execFileSync("git", ["clone", "-q", "--bare", repo, join(origin, "origin.git")]);
    execFileSync("git", ["--git-dir", join(origin, "origin.git"), "branch", "-m", "main", "master"]);
    execFileSync("git", ["--git-dir", join(origin, "origin.git"), "symbolic-ref", "HEAD", "refs/heads/master"]);
    const clone = join(origin, "clone");
    execFileSync("git", ["clone", "-q", join(origin, "origin.git"), clone]);
    execFileSync("git", ["checkout", "-qb", "feat/x"], { cwd: clone });
    expect(await defaultBranch(clone)).toBe("master");
  });

  it("falls back to a usual base branch, then to the checked out one", async () => {
    expect(await defaultBranch(repo)).toBe("main");
    const other = scratch();
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: other });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: other });
    expect(await defaultBranch(other)).toBe("trunk");
    expect(await defaultBranch(scratch())).toBeUndefined();
  });
});

describe("local Claude config in a worktree", () => {
  afterAll(() => {
    git("worktree", "remove", "--force", join(`${repo}.worktrees`, "wt-claude"));
    git("branch", "-D", "feat/wt-claude");
    rmSync(join(repo, ".claude"), { recursive: true, force: true });
    rmSync(join(repo, ".mcp.json"), { force: true });
  });

  it("copies the uncommitted Claude files of the main checkout and never commits them", async () => {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.local.json"), '{"enabledMcpjsonServers":["db"]}');
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{}}');
    const path = join(`${repo}.worktrees`, "wt-claude");
    git("worktree", "add", "-q", "-b", "feat/wt-claude", path, "main");
    const worktree: Worktree = { repo: "repo", repoPath: repo, path, branch: "feat/wt-claude", baseRef: "main" };

    expect(copyLocalClaudeConfig(repo, path)).toEqual([".claude/settings.local.json", ".mcp.json"]);
    expect(readFileSync(join(path, ".claude", "settings.local.json"), "utf8")).toContain("db");
    // Already there (e.g. tracked by the repo): left alone.
    expect(copyLocalClaudeConfig(repo, path)).toEqual([]);

    expect(await commitAll(worktree, "chore: nothing")).toBeUndefined();
    writeFileSync(join(path, "c.txt"), "c\n");
    expect(await commitAll(worktree, "feat: c")).toBeDefined();
    const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
    expect(committed).toBe("c.txt");
  });
});

describe("removeWorktree", () => {
  // Folder names that are not `nexura-<id>`, so forgetWorktree never touches ~/.claude.json.
  const addWorktree = (name: string): Worktree => {
    const path = join(`${repo}.worktrees`, name);
    git("worktree", "add", "-q", "-b", `feat/${name}`, path, "main");
    return { repo: "repo", repoPath: repo, path, branch: `feat/${name}`, baseRef: "main" };
  };
  const branches = (): string => git("branch", "--list", "feat/*");
  afterAll(() => rmSync(`${repo}.worktrees`, { recursive: true, force: true }));

  it("drops a branch without commits of its own and keeps one with commits", async () => {
    const empty = addWorktree("wt-empty");
    const worked = addWorktree("wt-worked");
    writeFileSync(join(worked.path, "b.txt"), "b\n");
    execFileSync("git", ["add", "-A"], { cwd: worked.path });
    execFileSync("git", ["commit", "-qm", "work"], { cwd: worked.path });

    await removeWorktree(empty);
    await removeWorktree(worked);

    expect(existsSync(empty.path)).toBe(false);
    expect(existsSync(worked.path)).toBe(false);
    expect(git("worktree", "list")).not.toContain("wt-");
    expect(branches()).not.toContain("feat/wt-empty");
    expect(branches()).toContain("feat/wt-worked");
    // The branch is free again: a new run of the same ticket gets the same name.
    expect(await freeBranchName(repo, "feat/wt-empty")).toBe("feat/wt-empty");
    git("branch", "-D", "feat/wt-worked");
  });

  it("tolerates a folder deleted by hand and a branch that no longer exists", async () => {
    const gone = addWorktree("wt-gone");
    rmSync(gone.path, { recursive: true, force: true });
    await removeWorktree(gone, true);
    expect(git("worktree", "list")).not.toContain("wt-gone");
    expect(branches()).not.toContain("feat/wt-gone");
    await expect(removeWorktree(gone, true)).resolves.toBeUndefined();
  });
});

describe("linkNodeModules", () => {
  it("links dependencies to the main checkout but workspace packages to the worktree's own copy", () => {
    const root = mkdtempSync(join(tmpdir(), "nexura-link-"));
    const main = join(root, "main");
    const worktree = join(root, "worktree");
    const write = (path: string, text: string): void => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(main, "node_modules", "dep", "index.js"), "dep");
    write(join(main, "packages", "shared", "index.ts"), "main shared");
    write(join(main, "apps", "web", "node_modules", "builder", "index.js"), "builder");
    mkdirSync(join(main, "node_modules", "@scope"));
    symlinkSync(join(main, "packages", "shared"), join(main, "node_modules", "@scope", "shared"), "junction");
    symlinkSync(join(main, "apps", "web"), join(main, "node_modules", "@scope", "web"), "junction");
    write(join(worktree, "packages", "shared", "index.ts"), "worktree shared");
    write(join(worktree, "apps", "web", "main.ts"), "web");

    try {
      linkNodeModules(main, worktree);
      expect(readFileSync(join(worktree, "node_modules", "dep", "index.js"), "utf8")).toBe("dep");
      expect(readFileSync(join(worktree, "node_modules", "@scope", "shared", "index.ts"), "utf8")).toBe("worktree shared");
      expect(readFileSync(join(worktree, "apps", "web", "node_modules", "builder", "index.js"), "utf8")).toBe("builder");

      unlinkNodeModules(worktree);
      expect(existsSync(join(worktree, "node_modules"))).toBe(false);
      expect(existsSync(join(worktree, "apps", "web", "node_modules"))).toBe(false);
      // The main checkout is untouched.
      expect(existsSync(join(main, "node_modules", "dep", "index.js"))).toBe(true);
      expect(existsSync(join(main, "apps", "web", "node_modules", "builder", "index.js"))).toBe(true);
    } finally {
      unlinkNodeModules(worktree);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
