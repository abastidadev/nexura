import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freeBranchName, linkNodeModules, unlinkNodeModules } from "./git.ts";

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
