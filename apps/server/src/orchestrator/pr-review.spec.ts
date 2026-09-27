import { describe, expect, it } from "vitest";
import { isAgentConfigPath } from "../workspace/git.ts";
import { cleanPost, normalizePrReview, normalizeReviewPath, parseDiffHunks, reviewPosts, type PrReviewOutput } from "./pr-review.ts";

const DIFF = `diff --git a/src/greet.js b/src/greet.js
index 1111111..2222222 100644
--- a/src/greet.js
+++ b/src/greet.js
@@ -1,3 +1,5 @@
-export function greet(name) {
+export function greet(name) {
+  const who = name.trim();
   return "hi";
 }
+// end
@@ -20,2 +22,3 @@ function other() {
   a();
+  b();
   c();
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

const FILE = ["export function greet(name) {", "  const who = name.trim();", '  return "hi";', "}", "// end", ...Array.from({ length: 30 }, (_, index) => `line ${index + 6}`)];

function comment(overrides: Partial<PrReviewOutput["comments"][number]>): PrReviewOutput["comments"][number] {
  return { severity: "minor", file: "src/greet.js", startLine: 2, endLine: 2, title: "t", post: "Use it", why: "porque", suggestion: "", ...overrides };
}

function review(comments: PrReviewOutput["comments"], verdict = "approveWithSuggestions"): PrReviewOutput {
  return { verdict, summary: " Bien ", conventions: [" Usa inject() ", ""], strengths: ["Pequeña"], comments };
}

const context = {
  headSha: "abc",
  changedFiles: new Set(["src/greet.js", "old.txt"]),
  hunks: parseDiffHunks(DIFF),
  readFile: (path: string) => (path === "src/greet.js" ? FILE : path === "README.md" ? ["# readme"] : undefined),
};

describe("parseDiffHunks", () => {
  it("keeps the new-side ranges and added lines of each file, skipping deleted files", () => {
    const hunks = parseDiffHunks(DIFF);
    expect([...hunks.keys()]).toEqual(["src/greet.js"]);
    expect(hunks.get("src/greet.js")!.ranges).toEqual([
      [1, 5],
      [22, 24],
    ]);
    expect([...hunks.get("src/greet.js")!.added]).toEqual([1, 2, 5, 23]);
  });
});

describe("normalizePrReview", () => {
  it("anchors comments inside a hunk, sends the rest to the PR and drops invented files", () => {
    const result = normalizePrReview(
      review([
        comment({ severity: "nit", startLine: 2, endLine: 3 }),
        comment({ severity: "major", startLine: 10, endLine: 10 }),
        comment({ severity: "blocker", file: "nope/ghost.ts" }),
        comment({ severity: "minor", file: "README.md", startLine: 1, endLine: 1 }),
        comment({ severity: "minor", file: "", startLine: 0, endLine: 0, post: "Add a description" }),
        comment({ severity: "major", file: "old.txt", startLine: 1 }),
        comment({ severity: "bogus", post: "   " }),
      ]),
      context,
    );
    expect(result.comments.map((item) => [item.id, item.severity, item.file, item.inline])).toEqual([
      [1, "major", "src/greet.js", false],
      [2, "major", "old.txt", false],
      [3, "minor", "README.md", false],
      [4, "minor", undefined, false],
      [5, "nit", "src/greet.js", true],
    ]);
    expect(result).toMatchObject({ verdict: "approveWithSuggestions", summary: "Bien", conventions: ["Usa inject()"], headSha: "abc" });
  });

  it("clamps lines to the file and attaches the code around them with the added lines", () => {
    const [nit] = normalizePrReview(review([comment({ startLine: 2, endLine: 99 })]), context).comments;
    expect(nit).toMatchObject({ startLine: 2, endLine: FILE.length, inline: false });
    const [inline] = normalizePrReview(review([comment({ startLine: 2, endLine: 2 })]), context).comments;
    expect(inline!.snippet).toEqual({ startLine: 1, lines: FILE.slice(0, 5), added: [1, 2, 5] });
    // The anchor starts at the first non-blank character and ends one past the line.
    expect(inline!.anchor).toEqual({ startOffset: 3, endOffset: FILE[1]!.length + 1 });
    const [long] = normalizePrReview(review([comment({ startLine: 1, endLine: 35 })]), context).comments;
    expect(long!.snippet!.lines).toHaveLength(30);
  });

  it("derives the verdict when the model gives an unknown one", () => {
    expect(normalizePrReview(review([comment({ severity: "blocker" })], "reject"), context).verdict).toBe("waitingForAuthor");
    expect(normalizePrReview(review([], "?"), context).verdict).toBe("approve");
  });
});

describe("helpers", () => {
  it("normalizes the paths a model may write", () => {
    expect(normalizeReviewPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeReviewPath("/src\\a.ts:42-45")).toBe("src/a.ts");
  });

  it("never posts long dashes or `--`", () => {
    expect(cleanPost("Validate it — before use -- please ")).toBe("Validate it, before use, please");
    expect(cleanPost("Use `--force` here")).toBe("Use `--force` here");
  });

  it("posts only comments of the review, with the edited text and the review's own anchor", () => {
    const result = normalizePrReview(
      review([comment({ severity: "nit", startLine: 2, endLine: 2 }), comment({ severity: "major", startLine: 10, endLine: 12 }), comment({ file: "" })]),
      context,
    );
    const selection = [
      { id: 1, post: "Why 10 to 12?\nCo-Authored-By: Claude <noreply@anthropic.com>" },
      { id: 3, post: "Rename it — please" },
      { id: 2, post: "" },
      { id: 99, post: "invented" },
      { id: 1, post: "twice" },
    ];
    expect(reviewPosts(result, selection)).toEqual([
      { body: "`src/greet.js:10-12` Why 10 to 12?", commentId: 1 },
      { path: "src/greet.js", startLine: 2, endLine: 2, startOffset: 3, endOffset: FILE[1]!.length + 1, body: "Rename it, please", commentId: 3 },
      { body: "Use it", commentId: 2 },
    ]);
    // Not anchored (lines that may have moved): every comment goes on the PR naming its place.
    expect(reviewPosts(result, selection, false)[1]).toEqual({ body: "`src/greet.js:2` Rename it, please", commentId: 3 });
  });
});

describe("isAgentConfigPath", () => {
  it("covers what Claude Code, Codex and Copilot load from a checkout", () => {
    for (const file of [
      ".claude/settings.json",
      ".claude/settings.local.json",
      "packages/app/.claude/skills/x/SKILL.md",
      "CLAUDE.md",
      "apps/web/CLAUDE.md",
      "AGENTS.md",
      ".codex/config.toml",
      ".mcp.json",
      ".vscode/mcp.json",
      ".github/copilot-instructions.md",
      ".github/instructions/web.instructions.md",
      ".github/hooks/hooks.json",
    ]) {
      expect(isAgentConfigPath(file), file).toBe(true);
    }
    for (const file of ["src/claude.ts", "docs/CLAUDE.md.bak", ".github/workflows/ci.yml", "README.md"]) {
      expect(isAgentConfigPath(file), file).toBe(false);
    }
  });
});
