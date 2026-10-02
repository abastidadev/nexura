import type { PrFileStatus, PrReviewSeverity } from "./flow.ts";

/** One line of a hunk: its numbers on the old and new side (only the side it exists on). */
export type DiffLine = { kind: "context" | "add" | "del"; text: string; old?: number; new?: number };

export type DiffHunk = {
  /** The `@@ -a,b +c,d @@ section` line as git wrote it. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  /** Previous path of a renamed file. */
  oldPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  hunks: DiffHunk[];
  /** Too long to show whole: the hunks stop early (the counts still cover the whole file). */
  truncated?: boolean;
};

/** What a run changed in one repo: its branch against the base (`git diff <baseRef>...HEAD`). */
export type RepoDiff = {
  repo: string;
  branch: string;
  baseRef: string;
  files: FileDiff[];
  /** Files changed in the worktree but not committed yet (they are not part of the diff). */
  uncommitted: string[];
  /** Read from the live worktree, the copy saved when it was removed, or an open PR fetched without a checkout. */
  source: "worktree" | "saved" | "pr";
  /** The diff hit the size limit: later files come without their lines. */
  truncated?: boolean;
  error?: string;
};

export type RunDiff = { repos: RepoDiff[] };

/** A comment of the user on some lines of a diff: `side` says which numbers they are (old for removed lines). */
export type DiffComment = {
  repo: string;
  file: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  body: string;
};

/** Diff comments sent back to the agent of a flow: implement runs again with them as corrections. */
export type ChangeRequest = { comments: DiffComment[]; note?: string; /** The comments were written on the diff without whitespace changes. */ ignoreWhitespace?: boolean };

/** A comment of the user added to a PR review, on new-side lines of the PR's diff. */
export type OwnReviewComment = { file: string; startLine: number; endLine: number; post: string; severity?: PrReviewSeverity };
