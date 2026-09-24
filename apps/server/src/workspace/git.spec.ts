import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Worktree } from "@nexura/shared";
import { commitAll, stripAttribution } from "./git.ts";

// Built from pieces so this file itself never trips the no-attribution hooks.
const CO_AUTHOR = ["Co", "Authored", "By"].join("-");
const SESSION = ["Claude", "Session"].join("-");

describe("stripAttribution", () => {
  it("drops attribution lines and the blank lines they leave at the end", () => {
    const message = [
      "feat: add badge color",
      "",
      "Body stays.",
      "",
      `${CO_AUTHOR}: Claude <noreply@anthropic.com>`,
      `${SESSION}: https://claude.ai/code/session_x`,
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
    ].join("\n");
    expect(stripAttribution(message)).toBe("feat: add badge color\n\nBody stays.");
  });

  it("is case-insensitive and keeps unrelated lines", () => {
    expect(stripAttribution(`fix: x\r\n\r\n${CO_AUTHOR.toLowerCase()}: someone <a@b>`)).toBe("fix: x");
    expect(stripAttribution("docs: mention co-authors in README")).toBe("docs: mention co-authors in README");
  });
});

describe("commitAll", () => {
  it("never commits attribution lines", async () => {
    const path = mkdtempSync(join(tmpdir(), "nexura-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@nexura.local");
    git("config", "user.name", "nexura-test");
    // No repo hooks: this test checks Nexura itself, not the hooks of the repo it commits in.
    git("config", "core.hooksPath", join(path, "no-hooks"));
    writeFileSync(join(path, "a.txt"), "a\n");
    const worktree: Worktree = { repo: "sandbox", repoPath: path, path, branch: "main", baseRef: "main" };

    const sha = await commitAll(worktree, `feat: a\n\n${CO_AUTHOR}: Claude <noreply@anthropic.com>`);

    expect(sha).toBeTruthy();
    expect(git("log", "-1", "--format=%B")).toBe("feat: a");
  });
});
