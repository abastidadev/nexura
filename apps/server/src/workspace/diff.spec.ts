import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Run, Worktree } from "@nexura/shared";
import { checkDiffComments, formatChangeRequest, gitHeaderPath, workingTreeDiff, parseNameStatus, pullRequestDiff, parseStatus, parseUnifiedDiff, runDiff, saveRunDiff, worktreeDiff } from "./diff.ts";

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

describe("gitHeaderPath", () => {
  it("quotes like git with core.quotepath=false: only quotes, backslashes and control characters", () => {
    expect(gitHeaderPath("a/dir con espacios/ñ.txt")).toBe("a/dir con espacios/ñ.txt");
    expect(gitHeaderPath('b/tab\there "q" \\ \u0001')).toBe('"b/tab\\there \\"q\\" \\\\ \\001"');
  });

  it("pairs files with their sections by header when -w dropped some", () => {
    const text = ["diff --git a/b c b/b c", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
    const { files } = parseUnifiedDiff(text, [{ path: "a", status: "modified" }, { path: "b c", status: "modified" }]);
    expect(files.map((file) => [file.path, file.additions])).toEqual([["b c", 1]]);
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

describe("change requests", () => {
  const text = ["diff --git a/f b/f", "@@ -1,3 +1,3 @@", " uno", "-dos ```", "+DOS ```", " tres", ""].join("\n");
  const diff = { repos: [{ repo: "demo", branch: "b", baseRef: "main", source: "worktree" as const, uncommitted: [], ...parseUnifiedDiff(text, [{ path: "f", status: "modified" }]) }] };

  it("keep comments on lines the diff shows, on either side", () => {
    const comments = checkDiffComments(
      [
        { repo: "demo", file: "f", side: "new", startLine: 2, endLine: 3, body: "  cambia esto  " },
        { repo: "demo", file: "f", side: "old", startLine: 2, body: "¿por qué se borra?" },
      ],
      diff,
    );
    expect(comments).toEqual([
      { repo: "demo", file: "f", side: "new", startLine: 2, endLine: 3, body: "cambia esto" },
      { repo: "demo", file: "f", side: "old", startLine: 2, endLine: 2, body: "¿por qué se borra?" },
    ]);
    expect(() => checkDiffComments([{ repo: "demo", file: "f", side: "new", startLine: 2, endLine: 3, body: " " }], diff)).toThrow("vacío");
    expect(() => checkDiffComments([{ repo: "otro", file: "f", side: "new", startLine: 2, endLine: 2, body: "x" }], diff)).toThrow("no está en el diff");
    expect(() => checkDiffComments([{ repo: "demo", file: "f", side: "new", startLine: 3, endLine: 2, body: "x" }], diff)).toThrow("no válidas");
    expect(() => checkDiffComments({}, diff)).toThrow("Faltan");
  });

  it("quote the code they point at in a fence the code cannot close", () => {
    const comments = checkDiffComments([{ repo: "demo", file: "f", side: "old", startLine: 2, endLine: 2, body: "Recupera esto" }], diff);
    const formatted = formatChangeRequest(comments, diff, " revisa también los tests ");
    expect(formatted).toContain("1. `f:2` (líneas borradas, numeración de la base)\n````diff\n-dos ```\n````\nRecupera esto");
    expect(formatted).toContain("Indicación general: revisa también los tests");
  });
});

describe("pullRequestDiff", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexura-prdiff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fetches the PR's head and target and diffs them without a checkout, leaving no ref behind", async () => {
    const origin = join(dir, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, origin]);
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", "-b", "main", origin, clone]);
    const diff = await pullRequestDiff({ name: "demo", path: clone }, { id: 7, provider: "azure", sourceBranch: "feat/x", targetBranch: "main" });
    expect(diff).toMatchObject({ repo: "demo", branch: "feat/x", baseRef: "origin/main", source: "pr", uncommitted: [] });
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt", "gone.txt", "img.bin", "new name.txt"]);
    expect(execFileSync("git", ["for-each-ref", "refs/nexura"], { cwd: clone, encoding: "utf8" })).toBe("");

    const missing = await pullRequestDiff({ name: "demo", path: clone }, { id: 8, provider: "azure", sourceBranch: "nope", targetBranch: "main" });
    expect(missing.error).toMatch(/No se pudo leer el diff/);
  });

  it("leaves whitespace-only changes out on request", async () => {
    git("checkout", "-q", "-b", "ws", "main");
    writeFileSync(join(repo, "main-only.txt"), "x   \n");
    git("commit", "-qam", "ws");
    const ws: Worktree = { ...worktree, branch: "ws", baseRef: "main" };
    expect((await worktreeDiff(ws, { uncommitted: false })).files).toHaveLength(1);
    const ignored = await worktreeDiff(ws, { uncommitted: false, ignoreWhitespace: true });
    expect(ignored.error).toBeUndefined();
    expect(ignored.files).toEqual([]);
    git("checkout", "-q", "feat/x");
  });
});

describe("workingTreeDiff", () => {
  it("shows what is not committed: tracked changes and new files, from any folder of the repo", async () => {
    writeFileSync(join(repo, "a.txt"), "uno\nDOS\ntres\ncuatro\ncinco");
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "bin.dat"), Buffer.from([1, 0, 2]));
    symlinkSync("/etc/hostname", join(repo, "sub", "link"));
    try {
      const diff = await workingTreeDiff(join(repo, "sub"), undefined);
      expect(diff).toMatchObject({ branch: "feat/x", baseRef: "HEAD", source: "worktree" });
      expect(diff.error).toBeUndefined();
      expect(diff.files.map((file) => [file.path, file.status, file.binary ?? false])).toEqual([
        [".mcp.json", "added", false],
        ["a.txt", "modified", false],
        ["draft.txt", "added", false],
        ["sub/bin.dat", "added", true],
        // Never followed: it could point outside the repo.
        ["sub/link", "added", true],
      ]);
      expect(diff.files.find((file) => file.path === "draft.txt")!.hunks[0]!.lines).toEqual([{ kind: "add", text: "sin commit", new: 1 }]);
    } finally {
      git("checkout", "--", "a.txt");
      rmSync(join(repo, "sub"), { recursive: true, force: true });
    }
  });

  it("reports a folder outside git", async () => {
    const outside = mkdtempSync(join(tmpdir(), "nexura-nogit-"));
    try {
      expect((await workingTreeDiff(outside, "x")).error).toMatch(/No se pudo leer el diff/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
