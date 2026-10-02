import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Run, Worktree } from "@nexura/shared";
import { parseNameStatus, parseStatus, parseUnifiedDiff, runDiff, saveRunDiff, worktreeDiff } from "./diff.ts";

const repo = mkdtempSync(join(tmpdir(), "nexura-diff-"));
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "test@nexura.local");
git("config", "user.name", "nexura-test");
writeFileSync(join(repo, "a.txt"), "uno\ndos\ntres\n");
writeFileSync(join(repo, "old name.txt"), "se mueve\ntal cual\ncon\nvarias\nlíneas\n");
writeFileSync(join(repo, "gone.txt"), "adiós\n");
git("add", "-A");
git("commit", "-qm", "init");
git("checkout", "-qb", "feat/x");
writeFileSync(join(repo, "a.txt"), "uno\nDOS\ntres\ncuatro");
git("mv", "old name.txt", "new name.txt");
git("rm", "-q", "gone.txt");
writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
git("add", "-A");
git("commit", "-qm", "work");
// main moves on: a three-dot diff ignores it.
git("checkout", "-q", "main");
writeFileSync(join(repo, "main-only.txt"), "x\n");
git("add", "-A");
git("commit", "-qm", "main");
git("checkout", "-q", "feat/x");
writeFileSync(join(repo, "draft.txt"), "sin commit\n");
writeFileSync(join(repo, ".mcp.json"), "{}\n");

const worktree: Worktree = { repo: "demo", repoPath: repo, path: repo, branch: "feat/x", baseRef: "main" };

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("worktreeDiff", () => {
  it("reads the branch against the base with numbered lines, renames, deletions and binaries", async () => {
    const diff = await worktreeDiff(worktree);
    expect(diff.error).toBeUndefined();
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ["a.txt", "modified"],
      ["gone.txt", "deleted"],
      ["img.bin", "added"],
      ["new name.txt", "renamed"],
    ]);
    const [a, gone, img, renamed] = diff.files;
    expect(a).toMatchObject({ additions: 2, deletions: 1 });
    expect(a!.hunks).toHaveLength(1);
    expect(a!.hunks[0]!.lines).toEqual([
      { kind: "context", text: "uno", old: 1, new: 1 },
      { kind: "del", text: "dos", old: 2 },
      { kind: "add", text: "DOS", new: 2 },
      { kind: "context", text: "tres", old: 3, new: 3 },
      { kind: "add", text: "cuatro", new: 4 },
    ]);
    expect(gone).toMatchObject({ deletions: 1, additions: 0 });
    expect(img!.binary).toBe(true);
    expect(renamed).toMatchObject({ oldPath: "old name.txt", additions: 0, deletions: 0, hunks: [] });
    // The local Claude files Nexura copies in are not "work in progress".
    expect(diff.uncommitted).toEqual(["draft.txt"]);
  });

  it("reports a missing base instead of throwing", async () => {
    const diff = await worktreeDiff({ ...worktree, baseRef: "nope" });
    expect(diff.files).toEqual([]);
    expect(diff.error).toMatch(/No se pudo leer el diff/);
  });
});

describe("parseUnifiedDiff", () => {
  const text = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,3 @@", " a", "+b", "+c", " d", "\\ No newline at end of file", ""].join("\n");

  it("keeps lines up to the limits and still counts the rest", () => {
    const { files, truncated } = parseUnifiedDiff(text, [{ path: "f", status: "modified" }], { fileLines: 2, totalLines: 100 });
    expect(truncated).toBe(true);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 0, truncated: true });
    expect(files[0]!.hunks[0]!.lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  it("refuses a diff that does not match the file list", () => {
    expect(() => parseUnifiedDiff(text, [])).toThrow(/1 fichero/);
  });

  it("treats an empty line inside a hunk as context (a stripped blank line)", () => {
    const blank = ["diff --git a/f b/f", "@@ -1,2 +1,2 @@", "", "-x", "+y", ""].join("\n");
    expect(parseUnifiedDiff(blank, [{ path: "f", status: "modified" }]).files[0]!.hunks[0]!.lines).toEqual([
      { kind: "context", text: "", old: 1, new: 1 },
      { kind: "del", text: "x", old: 2 },
      { kind: "add", text: "y", new: 2 },
    ]);
  });
});

describe("name and status parsers", () => {
  it("parse NUL-separated output, renames included", () => {
    expect(parseNameStatus("M\0a b\0R087\0old\0new\0A\0x\0D\0y\0")).toEqual([
      { path: "a b", status: "modified" },
      { path: "new", oldPath: "old", status: "renamed" },
      { path: "x", status: "added" },
      { path: "y", status: "deleted" },
    ]);
    expect(parseStatus(" M a.txt\0R  new\0old\0?? CLAUDE.local.md\0?? n\tew\0")).toEqual(["a.txt", "new", "n\tew"]);
  });
});

describe("runDiff", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexura-rundiff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (worktrees: Worktree[]) => ({ worktrees }) as Run;

  it("reads live worktrees, then the saved copy, then nothing", async () => {
    const saved = join(dir, "run", "diff.json");
    expect(await runDiff(run([]), saved)).toEqual({ repos: [] });
    const live = await runDiff(run([worktree]), saved);
    expect(live.repos[0]!.source).toBe("worktree");
    saveRunDiff(saved, live);
    const kept = await runDiff(run([{ ...worktree, path: join(dir, "gone") }]), saved);
    expect(kept.repos[0]).toMatchObject({ source: "saved", repo: "demo" });
    expect(kept.repos[0]!.files).toHaveLength(4);
  });

  it("skips the uncommitted list of a PR checkout (Nexura's own edits)", async () => {
    expect((await runDiff(run([{ ...worktree, detached: true }]), join(dir, "none"))).repos[0]!.uncommitted).toEqual([]);
  });
});
