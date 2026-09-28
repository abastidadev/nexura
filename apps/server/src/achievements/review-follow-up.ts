import type { PrReviewComment, PrReviewFollowUp, ReviewThread, Run } from "@nexura/shared";
import { getActiveThreads, getPrStatus, listPullRequests } from "../forge/forge.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";

const MS_PER_SECOND = 1000;
/** Reviews older than this are no longer followed. */
const MAX_AGE_MS = 60 * 86_400_000;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

/**
 * The thread a published comment opened: on the same file and lines when it was inline, else
 * a PR-level thread that starts with its text. Only open threads can be matched, so this is
 * tried on every check until each comment has its thread.
 */
export function matchThread(comment: PrReviewComment, threads: ReviewThread[], taken: ReadonlySet<number>): ReviewThread | undefined {
  return threads.find((thread) => {
    if (taken.has(thread.threadId)) {
      return false;
    }
    if (comment.inline && comment.file && comment.startLine) {
      const end = comment.endLine ?? comment.startLine;
      return (
        Boolean(thread.filePath) &&
        normalizePath(thread.filePath!) === normalizePath(comment.file) &&
        thread.line !== undefined &&
        thread.line >= comment.startLine - 1 &&
        thread.line <= end + 1
      );
    }
    const first = thread.comments[0]?.content ?? "";
    return !thread.filePath && normalize(first).includes(normalize(comment.post).slice(0, 60));
  });
}

/** One step of a review's follow-up: the PR's state now, and which of its threads are gone. */
export function nextFollowUp(
  run: Run,
  previous: PrReviewFollowUp | undefined,
  now: { prStatus: string; headSha?: string; threads: ReviewThread[] },
  at = new Date().toISOString(),
): PrReviewFollowUp {
  const review = run.prReview!;
  const published = new Set(review.published?.commentIds ?? []);
  const threads = { ...(previous?.threads ?? {}) };
  const taken = new Set(Object.values(threads));
  for (const comment of review.comments.filter((item) => published.has(item.id) && threads[item.id] === undefined)) {
    const thread = matchThread(comment, now.threads, taken);
    if (thread) {
      threads[comment.id] = thread.threadId;
      taken.add(thread.threadId);
    }
  }
  const headMoved = Boolean(previous?.headMoved) || Boolean(now.headSha && review.headSha && now.headSha !== review.headSha);
  const open = new Set(now.threads.map((thread) => thread.threadId));
  const resolvedIds = Object.entries(threads)
    .filter(([, threadId]) => !open.has(threadId))
    .map(([commentId]) => Number(commentId));
  const merged = now.prStatus === "completed";
  return {
    checkedAt: at,
    prStatus: now.prStatus,
    threads,
    resolvedIds,
    headMoved,
    ...(merged ? { mergedAt: previous?.mergedAt ?? at } : {}),
  };
}

function isFollowed(run: Run, now: number): boolean {
  const published = run.prReview?.published;
  return (
    run.request.kind === "prReview" &&
    Boolean(published?.commentIds.length) &&
    now - Date.parse(published!.at) < MAX_AGE_MS &&
    (run.prReview?.followUp?.prStatus ?? "active") === "active"
  );
}

/**
 * Follows the PRs of published reviews over plain REST (free): which of the comments the user
 * posted got resolved after the author pushed commits. It never posts anything; what it finds
 * goes to `prReview.followUp`, which the achievements read.
 */
export class ReviewFollowUp {
  private readonly orchestrator: Orchestrator;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  public constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    orchestrator.on("settings", () => this.reschedule());
  }

  public start(): void {
    this.reschedule();
  }

  public stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private reschedule(): void {
    this.stop();
    const seconds = this.orchestrator.getSettings().prPollSeconds;
    if (seconds > 0) {
      this.timer = setInterval(() => void this.tick(), seconds * MS_PER_SECOND);
      this.timer.unref?.();
    }
  }

  /** One pass over every followed review. Public for tests. */
  public async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const now = Date.now();
      for (const run of this.orchestrator.listRuns().filter((candidate) => isFollowed(candidate, now))) {
        await this.check(run);
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(run: Run): Promise<void> {
    const repo = this.orchestrator.repo(run.request.repos[0] ?? "");
    const target = run.request.prReview;
    const review = run.prReview;
    if (!repo || !target || !review) {
      return;
    }
    const location = { repo: repo.name, repoPath: repo.path };
    try {
      const open = (await listPullRequests(location)).find((pr) => pr.id === target.id);
      const prStatus = open ? "active" : await getPrStatus(location, target.id);
      const threads = await getActiveThreads(location, { id: target.id });
      this.orchestrator.patchRun(run.id, { prReview: { ...review, followUp: nextFollowUp(run, review.followUp, { prStatus, headSha: open?.headSha, threads }) } });
    } catch (error) {
      const previous = review.followUp;
      this.orchestrator.patchRun(run.id, {
        prReview: {
          ...review,
          followUp: {
            checkedAt: new Date().toISOString(),
            prStatus: previous?.prStatus ?? "active",
            threads: previous?.threads ?? {},
            resolvedIds: previous?.resolvedIds ?? [],
            headMoved: previous?.headMoved ?? false,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }
}
