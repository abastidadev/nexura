import type { Run, Worktree } from "@nexura/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { getPrStatus, getPullRequestDetail } from "./forge.ts";

const MS_PER_SECOND = 1000;

/**
 * Polls, over plain REST (free), the open PRs of finished runs: active thread count and PR
 * status. It only informs (reviewWatch + a notice when comments arrive or the PR closes);
 * it never launches Claude. Stops watching a PR once it is completed or abandoned.
 */
export class PrWatcher {
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

  /** One pass over every watchable run. Public for tests. */
  public async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      for (const run of this.orchestrator.listRuns().filter(isWatchable)) {
        await this.check(run);
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(run: Run): Promise<void> {
    const pr = run.pullRequests![0]!;
    const worktree = run.worktrees.find((candidate) => candidate.repo === pr.repo);
    if (!worktree) {
      return;
    }
    const previous = run.reviewWatch;
    try {
      const prStatus = await getPrStatus(worktree, pr.id);
      const activeThreads = prStatus === "active" ? (await this.orchestrator.reviewThreads(run.id)).length : 0;
      const checkedAt = new Date().toISOString();
      const merged = prStatus === "completed";
      this.orchestrator.patchRun(run.id, {
        reviewWatch: {
          checkedAt,
          activeThreads,
          prStatus,
          ...(merged ? { mergedAt: checkedAt } : {}),
          ...((previous?.reviewedByOthers || activeThreads > 0 || (merged && (await approvedByOthers(worktree, pr.id)))) ? { reviewedByOthers: true } : {}),
        },
      });
      const title = `PR #${pr.id} · ${run.request.ticketId ? `#${run.request.ticketId}` : run.id}`;
      if (activeThreads > (previous?.activeThreads ?? 0)) {
        this.orchestrator.notice({
          runId: run.id,
          level: "info",
          title,
          body: `${activeThreads} comentario(s) pendiente(s) de revisión. Puedes atenderlos desde el flujo.`,
        });
      }
      if (prStatus !== "active" && previous?.prStatus !== prStatus) {
        this.orchestrator.notice({
          runId: run.id,
          level: "info",
          title,
          body: prStatus === "completed" ? "La PR se ha completado (merge). Ya no se vigila." : `La PR está ${prStatus}. Ya no se vigila.`,
        });
      }
    } catch (error) {
      // Keep the last known counts; surface the error without spamming notices.
      this.orchestrator.patchRun(run.id, {
        reviewWatch: {
          checkedAt: new Date().toISOString(),
          activeThreads: previous?.activeThreads ?? 0,
          prStatus: previous?.prStatus ?? "active",
          ...(previous?.reviewedByOthers ? { reviewedByOthers: true } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

/** Whether a reviewer approved the merged PR (or approved with suggestions). A failure counts as no. */
async function approvedByOthers(worktree: Worktree, prId: number): Promise<boolean> {
  try {
    const detail = await getPullRequestDetail(worktree, prId);
    return detail.reviewers.some((reviewer) => reviewer.state === "approved" || reviewer.state === "suggestions");
  } catch {
    return false;
  }
}

function isWatchable(run: Run): boolean {
  return (
    run.status === "done" &&
    Boolean(run.pullRequests?.length) &&
    run.worktrees.length > 0 &&
    (run.reviewWatch?.prStatus ?? "active") === "active"
  );
}
