/** One issue of a codeReview answer (see config/steps/codeReview/schema.json). */
export type ReviewIssue = { severity: string; file: string; problem: string; fix: string };

export type CodeReviewOutput = {
  verdict: string;
  summary: string;
  issues: ReviewIssue[];
};

export type BlindReviewOutput = CodeReviewOutput & {
  /** Blocking issues only one judge raised: they do not send the work back. */
  unconfirmed: ReviewIssue[];
  judges: { A: string; B: string };
};

const GENERAL_FILE = "(general)";

/** Same file however the judges wrote it: case, separators, leading `./` and a `:line[:col]` suffix. */
export function normalizeReviewFile(file: string): string {
  const normalized = file
    .trim()
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/(:\d+){1,2}$/, "");
  return normalized === "" || normalized === "-" ? GENERAL_FILE : normalized;
}

const isBlocking = (issue: ReviewIssue): boolean => issue.severity !== "minor";

/**
 * Crosses the verdicts of two judges that never saw each other. A blocking issue (blocker/major)
 * is confirmed when the other judge also raised a blocking one in the same file; confirmed issues
 * of both judges are kept. Minor issues are ignored. The verdict is `changes` only when something
 * is confirmed.
 */
export function mergeJudgments(a: CodeReviewOutput, b: CodeReviewOutput): BlindReviewOutput {
  const blockingA = a.issues.filter(isBlocking);
  const blockingB = b.issues.filter(isBlocking);
  const filesA = new Set(blockingA.map((issue) => normalizeReviewFile(issue.file)));
  const filesB = new Set(blockingB.map((issue) => normalizeReviewFile(issue.file)));
  const confirmedIn = (issue: ReviewIssue, other: Set<string>): boolean => other.has(normalizeReviewFile(issue.file));

  const issues = [...blockingA.filter((issue) => confirmedIn(issue, filesB)), ...blockingB.filter((issue) => confirmedIn(issue, filesA))];
  const unconfirmed = [...blockingA.filter((issue) => !confirmedIn(issue, filesB)), ...blockingB.filter((issue) => !confirmedIn(issue, filesA))];
  return {
    verdict: issues.length > 0 ? "changes" : "approve",
    summary: `Juez A: ${a.verdict}, juez B: ${b.verdict}; confirmadas ${issues.length}, descartadas ${unconfirmed.length}`,
    issues,
    unconfirmed,
    judges: { A: a.verdict, B: b.verdict },
  };
}
