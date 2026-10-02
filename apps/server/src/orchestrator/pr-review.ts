import {
  PR_REVIEW_SEVERITIES,
  PR_VOTES,
  type DiffLine,
  type FileDiff,
  type OwnReviewComment,
  type PrReviewComment,
  type PrReviewPublish,
  type PrReviewResult,
  type PrReviewSeverity,
  type PrVote,
} from "@nexura/shared";
import type { ReviewPost } from "../forge/review-post.ts";
import { stripAttribution } from "../workspace/git.ts";
import { checkSelection } from "../workspace/diff.ts";

/** What the prReview step answers (schema.json): empty strings and 0 stand for "none" (codex strict mode). */
export type PrReviewOutput = {
  verdict: string;
  summary: string;
  conventions: string[];
  strengths: string[];
  comments: {
    severity: string;
    file: string;
    startLine: number;
    endLine: number;
    title: string;
    post: string;
    why: string;
    suggestion: string;
  }[];
};

/** The new side of one file in a diff: the line ranges its hunks cover and the lines it adds. */
export type DiffFile = { ranges: [number, number][]; added: Set<number> };

const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX_LINES = 30;

/**
 * Parses `git diff` (unified, with context) into the new-side ranges of each file's hunks:
 * GitHub only anchors a review comment on a line inside them.
 */
export function parseDiffHunks(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let current: DiffFile | undefined;
  let line = 0;
  for (const text of diff.split(/\r?\n/)) {
    if (text.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).trim();
      current = path === "/dev/null" ? undefined : { ranges: [], added: new Set() };
      if (current) {
        files.set(path.replace(/^b\//, ""), current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (current && count > 0) {
        current.ranges.push([line, line + count - 1]);
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (text.startsWith("+")) {
      current.added.add(line++);
    } else if (text.startsWith(" ")) {
      line++;
    }
  }
  return files;
}

/** `./src/a.ts`, `/src/a.ts`, `src\a.ts` or `src/a.ts:42` → `src/a.ts`. */
export function normalizeReviewPath(file: string): string {
  return file
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/(?::\d+(?:-\d+)?)+$/, "");
}

/** Posted text never carries `--` or long dashes (the pr-reviewer rule): they read as generated. */
export function cleanPost(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .trim();
}

const SEVERITY_ORDER = new Map(PR_REVIEW_SEVERITIES.map((severity, index) => [severity, index]));

function fallbackVerdict(comments: PrReviewComment[]): PrVote {
  if (comments.some((comment) => comment.severity === "blocker" || comment.severity === "major")) {
    return "waitingForAuthor";
  }
  return comments.length ? "approveWithSuggestions" : "approve";
}

export type NormalizeContext = {
  headSha: string;
  /** Files the PR touches (`git diff --name-only`), deleted ones included. */
  changedFiles: ReadonlySet<string>;
  hunks: ReadonlyMap<string, DiffFile>;
  /** The file's lines at the PR's head, or undefined when it does not exist there. */
  readFile: (path: string) => string[] | undefined;
};

/**
 * Checks the reviewer's answer against the PR: comments on files that neither exist nor are
 * in the diff are dropped (the model cannot invent targets), lines are clamped to the file,
 * a comment is anchored only when its lines are inside a hunk (else it goes on the PR naming
 * `file:line`), and each one gets the code around it to show. Sorted by severity.
 */
export function normalizePrReview(output: PrReviewOutput, context: NormalizeContext): PrReviewResult {
  const comments: PrReviewComment[] = [];
  for (const raw of output.comments ?? []) {
    const post = cleanPost(raw.post ?? "");
    if (!post) {
      continue;
    }
    const severity: PrReviewSeverity = PR_REVIEW_SEVERITIES.includes(raw.severity as PrReviewSeverity) ? (raw.severity as PrReviewSeverity) : "minor";
    const base = {
      severity,
      title: raw.title?.trim() || post.slice(0, 80),
      post,
      why: raw.why?.trim() ?? "",
      ...(raw.suggestion?.trim() ? { suggestion: raw.suggestion.replace(/\s+$/, "") } : {}),
    };
    const file = raw.file ? normalizeReviewPath(raw.file) : "";
    if (!file) {
      comments.push({ id: 0, ...base, inline: false });
      continue;
    }
    const lines = context.readFile(file);
    if (!lines && !context.changedFiles.has(file)) {
      continue;
    }
    if (!lines || !(raw.startLine > 0)) {
      comments.push({ id: 0, ...base, file, inline: false });
      continue;
    }
    const last = Math.max(1, lines.length);
    const startLine = Math.min(Math.max(1, Math.trunc(raw.startLine)), last);
    const endLine = Math.min(Math.max(startLine, Math.trunc(raw.endLine) || startLine), last);
    const diff = context.hunks.get(file);
    const inline = Boolean(diff?.ranges.some(([from, to]) => startLine >= from && endLine <= to));
    const from = Math.max(1, startLine - SNIPPET_CONTEXT);
    const to = Math.min(lines.length, endLine + SNIPPET_CONTEXT, from + SNIPPET_MAX_LINES - 1);
    const first = lines[startLine - 1] ?? "";
    const final = (lines[endLine - 1] ?? "").trimEnd();
    comments.push({
      id: 0,
      ...base,
      file,
      startLine,
      endLine,
      inline,
      snippet: {
        startLine: from,
        lines: lines.slice(from - 1, to),
        added: [...(diff?.added ?? [])].filter((line) => line >= from && line <= to).sort((a, b) => a - b),
      },
      ...(inline ? { anchor: { startOffset: first.length - first.trimStart().length + 1, endOffset: final.length + 1 } } : {}),
    });
  }
  comments.sort((a, b) => SEVERITY_ORDER.get(a.severity)! - SEVERITY_ORDER.get(b.severity)!);
  comments.forEach((comment, index) => (comment.id = index + 1));
  const verdict = PR_VOTES.includes(output.verdict as PrVote) ? (output.verdict as PrVote) : fallbackVerdict(comments);
  return {
    verdict,
    summary: output.summary?.trim() ?? "",
    conventions: (output.conventions ?? []).map((item) => item.trim()).filter(Boolean),
    strengths: (output.strengths ?? []).map((item) => item.trim()).filter(Boolean),
    comments,
    headSha: context.headSha,
  };
}

/** `src/a.ts:42` or `src/a.ts:42-45`, as a PR-level comment names its place. */
export function commentPlace(comment: Pick<PrReviewComment, "file" | "startLine" | "endLine">): string {
  if (!comment.file) {
    return "";
  }
  if (!comment.startLine) {
    return comment.file;
  }
  const range = comment.endLine && comment.endLine > comment.startLine ? `-${comment.endLine}` : "";
  return `${comment.file}:${comment.startLine}${range}`;
}

/**
 * The approved comments as they are posted: only ids of the review, each once, with the
 * (possibly edited) text; the anchor always comes from the review, never from the request.
 * `anchored: false` posts them all on the PR naming their place (lines that may have moved).
 */
export function reviewPosts(result: PrReviewResult, selection: PrReviewPublish["comments"], anchored = true): ReviewPost[] {
  const posts: ReviewPost[] = [];
  const seen = new Set<number>();
  for (const chosen of selection) {
    const comment = result.comments.find((candidate) => candidate.id === chosen.id);
    // Attribution is dropped before the place is prefixed: a trailer only matches at the start of a line.
    const text = stripAttribution(cleanPost(String(chosen.post ?? ""))).trim() || comment?.post;
    if (!comment || !text || seen.has(comment.id)) {
      continue;
    }
    seen.add(comment.id);
    if (anchored && comment.inline && comment.file && comment.startLine) {
      posts.push({
        path: comment.file,
        startLine: comment.startLine,
        endLine: comment.endLine ?? comment.startLine,
        startOffset: comment.anchor?.startOffset,
        endOffset: comment.anchor?.endOffset,
        body: text,
        commentId: comment.id,
      });
    } else {
      const place = commentPlace(comment);
      posts.push({ body: place ? `\`${place}\` ${text}` : text, commentId: comment.id });
    }
  }
  return posts;
}

const MAX_OWN_POST = 4000;

/**
 * A comment the user writes on new-side lines of the PR's diff, shaped like the reviewer's
 * so that it is picked, edited and published with them. Its lines must sit inside one hunk:
 * that is where the forges accept an inline comment.
 */
export function ownReviewComment(file: FileDiff, input: OwnReviewComment, id: number): PrReviewComment {
  const post = typeof input?.post === "string" ? input.post.trim() : "";
  if (!post) {
    throw new Error("El comentario está vacío");
  }
  if (post.length > MAX_OWN_POST) {
    throw new Error(`El comentario es demasiado largo (máximo ${MAX_OWN_POST} caracteres)`);
  }
  const startLine = Number(input.startLine);
  const endLine = Number(input.endLine ?? input.startLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("Líneas no válidas");
  }
  const newSide = (lines: DiffLine[]) => lines.filter((line): line is DiffLine & { new: number } => line.new !== undefined);
  const hunk = file.hunks
    .map((candidate) => newSide(candidate.lines))
    .find((lines) => lines.some((line) => line.new === startLine) && lines.some((line) => line.new === endLine));
  if (!hunk) {
    throw new Error(`Las líneas ${startLine}-${endLine} de ${file.path} no están en un mismo bloque del diff`);
  }
  const from = Math.max(hunk[0]!.new, startLine - SNIPPET_CONTEXT);
  const to = Math.min(hunk.at(-1)!.new, endLine + SNIPPET_CONTEXT);
  const shown = hunk.filter((line) => line.new >= from && line.new <= to);
  const first = hunk.find((line) => line.new === startLine)!.text;
  const final = hunk.find((line) => line.new === endLine)!.text.trimEnd();
  const severity: PrReviewSeverity = PR_REVIEW_SEVERITIES.includes(input.severity as PrReviewSeverity) ? input.severity! : "minor";
  return {
    id,
    severity,
    file: file.path,
    startLine,
    endLine,
    title: post.split(/\r?\n/)[0]!.trim().slice(0, 80),
    post,
    why: "",
    inline: true,
    own: true,
    snippet: { startLine: from, lines: shown.map((line) => line.text), added: shown.filter((line) => line.kind === "add").map((line) => line.new) },
    // A selection anchors on its exact columns (Azure DevOps marks that text); else the lines' code, without indentation.
    anchor: checkSelection(file, { side: "new", startLine, endLine }, input) ?? {
      startOffset: first.length - first.trimStart().length + 1,
      endOffset: final.length + 1,
    },
  };
}
