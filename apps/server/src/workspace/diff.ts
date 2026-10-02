import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DiffComment, DiffHunk, DiffLine, FileDiff, PrFileStatus, RepoDiff, Run, RunDiff, Worktree } from "@nexura/shared";
import { azureGitEnv } from "../azure/azure-client.ts";
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

/** A path as git writes it in a `diff --git` header with core.quotepath=false: C-quoted only when it has to be. */
export function gitHeaderPath(path: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(path)) {
    return path;
  }
  const named: Record<string, string> = { "\x07": "a", "\b": "b", "\t": "t", "\n": "n", "\v": "v", "\f": "f", "\r": "r", '"': '"', "\\": "\\" };
  const escaped = path.replace(/["\\\x00-\x1f\x7f]/g, (char) => "\\" + (named[char] ?? char.charCodeAt(0).toString(8).padStart(3, "0")));
  return `"${escaped}"`;
}

/**
 * Pairs each file of the list with its section of the patch. Normally there is one each, in
 * the same order; with -w git drops the sections of whitespace-only changes, so then they are
 * found by their header and the files without one are left out.
 */
function matchSections(sections: { header: string; lines: string[] }[], names: NameEntry[]): [NameEntry, string[]][] {
  if (sections.length === names.length) {
    return names.map((name, index) => [name, sections[index]!.lines]);
  }
  const pairs: [NameEntry, string[]][] = [];
  let next = 0;
  for (const section of sections) {
    while (next < names.length) {
      const name = names[next++]!;
      if (section.header === `diff --git ${gitHeaderPath(`a/${name.oldPath ?? name.path}`)} ${gitHeaderPath(`b/${name.path}`)}`) {
        pairs.push([name, section.lines]);
        break;
      }
    }
    if (pairs.at(-1)?.[1] !== section.lines) {
      throw new Error(`el diff tiene ${sections.length} fichero(s) y la lista ${names.length}`);
    }
  }
  return pairs;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified `git diff` output into files with numbered lines. The paths come from
 * `names` (the same diff with `--name-status -z`, in the same order): the `diff --git` header
 * is ambiguous with spaces and quoted with odd characters. Past the limits the lines are
 * counted but not kept.
 */
export function parseUnifiedDiff(text: string, names: NameEntry[], limits = DIFF_LIMITS): { files: FileDiff[]; truncated: boolean } {
  const sections: { header: string; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      sections.push({ header: line, lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  const matched = matchSections(sections, names);

  let total = 0;
  let truncated = false;
  const files = matched.map(([name, section]): FileDiff => {
    const file: FileDiff = { ...name, additions: 0, deletions: 0, hunks: [] };
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

export type DiffOptions = {
  /** List the uncommitted files too (default true). */
  uncommitted?: boolean;
  /** `git diff -w`: changes of whitespace only are left out. */
  ignoreWhitespace?: boolean;
};

/** `git diff <range>` in `cwd`, parsed. Throws on git errors. */
async function readDiff(cwd: string, range: string, options: DiffOptions = {}): Promise<{ files: FileDiff[]; truncated: boolean }> {
  const args = options.ignoreWhitespace ? [...DIFF_ARGS, "-w"] : DIFF_ARGS;
  const [names, text] = await Promise.all([gitRaw(cwd, [...args, "--name-status", "-z", range, "--"]), gitRaw(cwd, [...args, range, "--"])]);
  return parseUnifiedDiff(text, parseNameStatus(names));
}

function diffError(error: unknown): string {
  const detail = String((error as { stderr?: string }).stderr || (error as Error).message).trim();
  return `No se pudo leer el diff: ${detail}`;
}

/** What a worktree's branch changes against its base, as a PR would show it. Errors come back in `error`. */
export async function worktreeDiff(worktree: Worktree, options: DiffOptions = {}): Promise<RepoDiff> {
  const base = { repo: worktree.repo, branch: worktree.branch, baseRef: worktree.baseRef, source: "worktree" as const };
  try {
    const [{ files, truncated }, status] = await Promise.all([
      readDiff(worktree.path, `${worktree.baseRef}...HEAD`, options),
      options.uncommitted === false ? "" : gitRaw(worktree.path, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]),
    ]);
    return { ...base, files, uncommitted: parseStatus(status).slice(0, MAX_UNCOMMITTED), ...(truncated ? { truncated } : {}) };
  } catch (error) {
    return { ...base, files: [], uncommitted: [], error: diffError(error) };
  }
}

/**
 * The diff of an open PR before any review, without a checkout: its head and target branch
 * are fetched into the repo (GitHub serves `refs/pull/<id>/head`, forks included) and
 * compared there. The head's ref is dropped afterwards. Zero tokens.
 */
export async function pullRequestDiff(
  repo: { name: string; path: string },
  pr: { id: number; provider: "azure" | "github"; sourceBranch: string; targetBranch: string },
  options: DiffOptions = {},
): Promise<RepoDiff> {
  const head = `refs/nexura/pr-diff/${pr.id}`;
  const baseRef = `origin/${pr.targetBranch}`;
  const base = { repo: repo.name, branch: pr.sourceBranch, baseRef, source: "pr" as const, uncommitted: [] };
  try {
    const source = pr.provider === "github" ? `refs/pull/${pr.id}/head` : `refs/heads/${pr.sourceBranch}`;
    await gitRaw(repo.path, ["fetch", "--quiet", "--no-tags", "origin", `+${source}:${head}`, `+refs/heads/${pr.targetBranch}:refs/remotes/${baseRef}`], azureGitEnv());
    const { files, truncated } = await readDiff(repo.path, `${baseRef}...${head}`, options);
    return { ...base, files, ...(truncated ? { truncated } : {}) };
  } catch (error) {
    return { ...base, files: [], error: diffError(error) };
  } finally {
    await gitRaw(repo.path, ["update-ref", "-d", head]).catch(() => undefined);
  }
}

/**
 * The changes of a run: live from its worktrees while they exist, else the copy saved when
 * they were removed (PR reviews), else nothing.
 */
export async function runDiff(run: Run, savedFile: string, options: Pick<DiffOptions, "ignoreWhitespace"> = {}): Promise<RunDiff> {
  const live = run.worktrees.filter((worktree) => existsSync(worktree.path));
  if (live.length) {
    // A PR checkout carries Nexura's own uncommitted edits (agent config reset, the review folder).
    return { repos: await Promise.all(live.map((worktree) => worktreeDiff(worktree, { ...options, uncommitted: !worktree.detached }))) };
  }
  if (existsSync(savedFile)) {
    // Kept as it was: whitespace is not left out of a saved copy.
    return JSON.parse(readFileSync(savedFile, "utf8")) as RunDiff;
  }
  return { repos: [] };
}

export function saveRunDiff(file: string, diff: RunDiff): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ repos: diff.repos.map((repo) => ({ ...repo, source: "saved" })) } satisfies RunDiff));
}

export const MAX_DIFF_COMMENTS = 50;
const MAX_COMMENT_LENGTH = 4000;
/** Lines of code quoted under each comment, at most. */
const QUOTE_LINES = 12;

/** The diff lines a comment covers, on its side (a removed line has no new number, an added one no old number). */
export function commentedLines(file: FileDiff, comment: Pick<DiffComment, "side" | "startLine" | "endLine">): DiffLine[] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => {
      const number = comment.side === "new" ? line.new : line.old;
      return number !== undefined && number >= comment.startLine && number <= comment.endLine;
    }),
  );
}

/**
 * Checks the comments of a change request against the diff they were written on: each one
 * names a file of the diff and lines it shows, with some text. Errors are for the user.
 */
export function checkDiffComments(input: unknown, diff: RunDiff): DiffComment[] {
  if (!Array.isArray(input)) {
    throw new Error("Faltan los comentarios");
  }
  if (input.length > MAX_DIFF_COMMENTS) {
    throw new Error(`Demasiados comentarios (máximo ${MAX_DIFF_COMMENTS})`);
  }
  return input.map((raw: Partial<DiffComment>, index): DiffComment => {
    const label = `Comentario ${index + 1}`;
    const body = typeof raw?.body === "string" ? raw.body.trim() : "";
    if (!body) {
      throw new Error(`${label}: está vacío`);
    }
    if (body.length > MAX_COMMENT_LENGTH) {
      throw new Error(`${label}: es demasiado largo (máximo ${MAX_COMMENT_LENGTH} caracteres)`);
    }
    const file = diff.repos.find((repo) => repo.repo === raw.repo)?.files.find((candidate) => candidate.path === raw.file);
    if (!file) {
      throw new Error(`${label}: ${String(raw.repo)}/${String(raw.file)} no está en el diff`);
    }
    const side = raw.side === "old" ? "old" : "new";
    const startLine = Number(raw.startLine);
    const endLine = Number(raw.endLine ?? raw.startLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error(`${label}: líneas no válidas`);
    }
    const comment = { repo: raw.repo!, file: file.path, side, startLine, endLine, body } satisfies DiffComment;
    if (commentedLines(file, comment).length === 0) {
      throw new Error(`${label}: las líneas ${startLine}-${endLine} de ${file.path} no están en el diff (actualízalo y vuelve a comentar)`);
    }
    return comment;
  });
}

/** A fence longer than any backtick run in the code, so quoted code cannot close it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The user's comments as corrections for implement: where (file and lines), the code they
 * point at as the diff shows it, and what to change.
 */
export function formatChangeRequest(comments: DiffComment[], diff: RunDiff, note?: string): string {
  const several = new Set(comments.map((comment) => comment.repo)).size > 1 || diff.repos.length > 1;
  const parts = ["Comentarios del usuario sobre el diff de la rama. Aplícalos todos; si alguno no se puede o no se debe hacer, explica por qué en tu resumen."];
  comments.forEach((comment, index) => {
    const range = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
    const where = [several ? `repo ${comment.repo}` : "", comment.side === "old" ? "líneas borradas, numeración de la base" : ""].filter(Boolean).join(", ");
    const file = diff.repos.find((repo) => repo.repo === comment.repo)?.files.find((candidate) => candidate.path === comment.file);
    const lines = file ? commentedLines(file, comment) : [];
    const code = lines
      .slice(0, QUOTE_LINES)
      .map((line) => (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text)
      .concat(lines.length > QUOTE_LINES ? ["…"] : [])
      .join("\n");
    const marks = fence(code);
    parts.push(
      [
        `${index + 1}. \`${comment.file}:${range}\`${where ? ` (${where})` : ""}`,
        code ? `${marks}diff\n${code}\n${marks}` : "",
        comment.body,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });
  if (note?.trim()) {
    parts.push(`Indicación general: ${note.trim()}`);
  }
  return parts.join("\n\n");
}

/** Untracked files listed with their content, at most (a build folder nobody ignored would flood the view). */
const MAX_UNTRACKED = 100;
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** The empty tree: what a repo without commits is compared against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A new file as an all-added diff: regular files only (a symlink may point outside the repo), text ones shown. */
function untrackedFile(root: string, path: string, budget: { lines: number }): FileDiff {
  const file: FileDiff = { path, status: "added", additions: 0, deletions: 0, hunks: [] };
  const full = join(root, path);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_UNTRACKED_BYTES) {
    return { ...file, binary: true };
  }
  const content = readFileSync(full);
  if (content.includes(0)) {
    return { ...file, binary: true };
  }
  const lines = content.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") {
    return file;
  }
  file.additions = lines.length;
  const kept = Math.max(0, Math.min(lines.length, DIFF_LIMITS.fileLines, budget.lines));
  budget.lines -= kept;
  file.hunks = kept
    ? [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, newStart: 1, lines: lines.slice(0, kept).map((text, index) => ({ kind: "add" as const, text, new: index + 1 })) }]
    : [];
  return kept < lines.length ? { ...file, truncated: true } : file;
}

/**
 * Everything not committed in the repo a folder belongs to (the Terminal's conversations):
 * `git diff HEAD` plus the untracked files as added ones. Errors come back in `error`.
 */
export async function workingTreeDiff(cwd: string, name: string | undefined, options: Pick<DiffOptions, "ignoreWhitespace"> = {}): Promise<RepoDiff> {
  const base = { repo: name ?? basename(cwd), branch: "", baseRef: "HEAD", source: "worktree" as const, uncommitted: [] };
  try {
    const root = (await gitRaw(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const hasHead = await gitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
    const [branch, { files, truncated }, others] = await Promise.all([
      gitRaw(root, ["rev-parse", "--abbrev-ref", "HEAD"]).then((out) => out.trim(), () => ""),
      readDiff(root, hasHead ? "HEAD" : EMPTY_TREE, options),
      gitRaw(root, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const untracked = others.split("\0").filter(Boolean);
    const budget = { lines: DIFF_LIMITS.totalLines - files.reduce((sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0), 0) };
    const added = untracked.slice(0, MAX_UNTRACKED).map((path) => untrackedFile(root, path, budget));
    const all = [...files, ...added].sort((a, b) => a.path.localeCompare(b.path));
    const cut = truncated || untracked.length > MAX_UNTRACKED || added.some((file) => file.truncated);
    return { ...base, branch: branch === "HEAD" ? "(HEAD separado)" : branch, files: all, ...(cut ? { truncated: true } : {}) };
  } catch (error) {
    return { ...base, files: [], error: diffError(error) };
  }
}
