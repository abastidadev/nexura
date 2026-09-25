import { describe, expect, it } from "vitest";
import { mergeJudgments, normalizeReviewFile, type CodeReviewOutput, type ReviewIssue } from "./blind-review.ts";

const issue = (file: string, severity = "major", problem = "p"): ReviewIssue => ({ severity, file, problem, fix: "f" });
const review = (...issues: ReviewIssue[]): CodeReviewOutput => ({
  verdict: issues.some((i) => i.severity !== "minor") ? "changes" : "approve",
  summary: "s",
  issues,
});

describe("normalizeReviewFile", () => {
  it("ignores case, separators, leading ./ and :line suffixes", () => {
    expect(normalizeReviewFile(".\\src\\A.ts:12")).toBe("src/a.ts");
    expect(normalizeReviewFile("./src/a.ts:12:4")).toBe("src/a.ts");
    expect(normalizeReviewFile(" src/a.ts ")).toBe("src/a.ts");
  });

  it("treats empty and dash as general", () => {
    expect(normalizeReviewFile("")).toBe(normalizeReviewFile("-"));
  });
});

describe("mergeJudgments", () => {
  it("approves when both approve", () => {
    const merged = mergeJudgments(review(), review());
    expect(merged).toMatchObject({ verdict: "approve", issues: [], unconfirmed: [], judges: { A: "approve", B: "approve" } });
  });

  it("asks for changes with the issues of both judges when they flag the same file", () => {
    const merged = mergeJudgments(review(issue(".\\src\\A.ts:12", "blocker", "de A")), review(issue("src/a.ts", "major", "de B")));
    expect(merged.verdict).toBe("changes");
    expect(merged.issues.map((i) => i.problem)).toEqual(["de A", "de B"]);
    expect(merged.unconfirmed).toEqual([]);
  });

  it("drops what only one judge flags", () => {
    const different = mergeJudgments(review(issue("a.ts")), review(issue("b.ts")));
    expect(different).toMatchObject({ verdict: "approve", issues: [] });
    expect(different.unconfirmed).toHaveLength(2);

    const alone = mergeJudgments(review(issue("a.ts", "blocker")), review());
    expect(alone).toMatchObject({ verdict: "approve", judges: { A: "changes", B: "approve" } });
    expect(alone.unconfirmed).toHaveLength(1);
  });

  it("ignores minor issues, even when both raise them", () => {
    const merged = mergeJudgments(review(issue("a.ts", "minor")), review(issue("a.ts", "minor")));
    expect(merged).toMatchObject({ verdict: "approve", issues: [], unconfirmed: [] });
  });

  it("confirms general issues (no file) raised by both", () => {
    const merged = mergeJudgments(review(issue("")), review(issue("-")));
    expect(merged.verdict).toBe("changes");
    expect(merged.issues).toHaveLength(2);
  });
});
