import type { PrFileStatus } from "./flow.ts";

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
  /** Read from the live worktree, or the copy saved when it was removed (PR reviews). */
  source: "worktree" | "saved";
  /** The diff hit the size limit: later files come without their lines. */
  truncated?: boolean;
  error?: string;
};

export type RunDiff = { repos: RepoDiff[] };
