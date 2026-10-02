import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiffHunk, DiffLine, FileDiff, PrFileStatus, RepoDiff, Run, RunDiff, Worktree } from "@nexura/shared";
import { gitRaw, LOCAL_CLAUDE_FILES } from "./git.ts";

/** Lines kept per file and per diff: the UI renders every one of them. */
export const DIFF_LIMITS = { fileLines: 3000, totalLines: 20000 };

/** Where a run keeps the diff of a worktree that is gone (see RunStore.runFile). */
export const RUN_DIFF_FILE = "diff.json";

/** Uncommitted paths listed at most. */
const MAX_UNCOMMITTED = 200;

/**
 * The worktree may hold someone else's code (a PR under review): its .gitattributes must not
 * pick a diff driver or textconv program of the user's, and the prefixes are fixed whatever
 * the user's diff config says.
 */
const DIFF_ARGS = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

export type NameEntry = { path: string; oldPath?: string; status: PrFileStatus };

/** `git diff --name-status -z`: exact paths, whatever characters they have. */
export function parseNameStatus(output: string): NameEntry[] {
  const parts = output.split("\0");
  const entries: NameEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) {
      continue;
    }
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      entries.push(letter === "R" ? { path, oldPath, status: "renamed" } : { path, status: "added" });
    } else {
      const path = parts[i++] ?? "";
      entries.push({ path, status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified" });
    }
  }
  return entries;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified `git diff` output into files with numbered lines. The paths come from
 * `names` (the same diff with `--name-status -z`, in the same order): the `diff --git` header
 * is ambiguous with spaces and quoted with odd characters. Past the limits the lines are
 * counted but not kept.
 */
export function parseUnifiedDiff(text: string, names: NameEntry[], limits = DIFF_LIMITS): { files: FileDiff[]; truncated: boolean } {
  const sections: string[][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      sections.push([]);
    } else {
      sections.at(-1)?.push(line);
    }
  }
  if (sections.length !== names.length) {
    throw new Error(`el diff tiene ${sections.length} fichero(s) y la lista ${names.length}`);
  }

  let total = 0;
  let truncated = false;
  const files = sections.map((section, index): FileDiff => {
    const file: FileDiff = { ...names[index]!, additions: 0, deletions: 0, hunks: [] };
    let hunk: DiffHunk | undefined;
    let oldLeft = 0;
    let newLeft = 0;
    let oldNo = 0;
    let newNo = 0;
    let kept = 0;
    for (const line of section) {
      if (oldLeft > 0 || newLeft > 0) {
        const sign = line[0];
        let entry: DiffLine;
        if (sign === "+") {
          entry = { kind: "add", text: line.slice(1), new: newNo++ };
          newLeft--;
          file.additions++;
        } else if (sign === "-") {
          entry = { kind: "del", text: line.slice(1), old: oldNo++ };
          oldLeft--;
          file.deletions++;
        } else if (sign === " " || line === "") {
          entry = { kind: "context", text: line.slice(1), old: oldNo++, new: newNo++ };
          oldLeft--;
          newLeft--;
        } else if (sign === "\\") {
          continue;
        } else {
          oldLeft = newLeft = 0;
          continue;
        }
        if (kept < limits.fileLines && total < limits.totalLines) {
          hunk?.lines.push(entry);
          kept++;
          total++;
        } else {
          file.truncated = true;
          truncated = true;
        }
        continue;
      }
      const header = HUNK_HEADER.exec(line);
      if (header) {
        oldNo = Number(header[1]);
        newNo = Number(header[3]);
        oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        newLeft = header[4] === undefined ? 1 : Number(header[4]);
        hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
        if (kept < limits.fileLines && total < limits.totalLines) {
          file.hunks.push(hunk);
        } else {
          hunk = undefined;
        }
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        file.binary = true;
      }
    }
    return file;
  });
  return { files, truncated };
}

/** `git status --porcelain -z`: the paths with uncommitted changes (a rename lists its new path). */
export function parseStatus(output: string): string[] {
  const parts = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") {
      i++;
    }
  }
  // Copied in by Nexura from the main checkout (see copyLocalClaudeConfig), never committed.
  return paths.filter((path) => !LOCAL_CLAUDE_FILES.includes(path));
}

/** What a worktree's branch changes against its base, as a PR would show it. Errors come back in `error`. */
export async function worktreeDiff(worktree: Worktree, options: { uncommitted?: boolean } = {}): Promise<RepoDiff> {
  const base = { repo: worktree.repo, branch: worktree.branch, baseRef: worktree.baseRef, source: "worktree" as const };
  try {
    const range = `${worktree.baseRef}...HEAD`;
    const [names, text, status] = await Promise.all([
      gitRaw(worktree.path, [...DIFF_ARGS, "--name-status", "-z", range, "--"]),
      gitRaw(worktree.path, [...DIFF_ARGS, range, "--"]),
      options.uncommitted === false ? "" : gitRaw(worktree.path, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]),
    ]);
    const { files, truncated } = parseUnifiedDiff(text, parseNameStatus(names));
    return { ...base, files, uncommitted: parseStatus(status).slice(0, MAX_UNCOMMITTED), ...(truncated ? { truncated } : {}) };
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim();
    return { ...base, files: [], uncommitted: [], error: `No se pudo leer el diff: ${detail}` };
  }
}

/**
 * The changes of a run: live from its worktrees while they exist, else the copy saved when
 * they were removed (PR reviews), else nothing.
 */
export async function runDiff(run: Run, savedFile: string): Promise<RunDiff> {
  const live = run.worktrees.filter((worktree) => existsSync(worktree.path));
  if (live.length) {
    // A PR checkout carries Nexura's own uncommitted edits (agent config reset, the review folder).
    return { repos: await Promise.all(live.map((worktree) => worktreeDiff(worktree, { uncommitted: !worktree.detached }))) };
  }
  if (existsSync(savedFile)) {
    return JSON.parse(readFileSync(savedFile, "utf8")) as RunDiff;
  }
  return { repos: [] };
}

export function saveRunDiff(file: string, diff: RunDiff): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ repos: diff.repos.map((repo) => ({ ...repo, source: "saved" })) } satisfies RunDiff));
}
