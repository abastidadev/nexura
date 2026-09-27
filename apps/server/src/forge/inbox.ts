import type { DashboardInbox, InboxPrState, PullRequestSummary, RepoConfig, Run } from "@nexura/shared";
import { listPullRequests } from "./forge.ts";
import { repoRemoteOf } from "./remote.ts";
import { listTickets, type TicketTarget } from "./tickets.ts";

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);

/** Where Nexura stands on a PR: its latest review run, compared with the PR's last commit. */
export function prState(pr: PullRequestSummary, review: Run | undefined): InboxPrState {
  if (!review) {
    return "pending";
  }
  if (ACTIVE.has(review.status)) {
    return "reviewing";
  }
  if (review.status !== "done" || !review.prReview) {
    return "pending";
  }
  if (review.prReview.headSha && review.prReview.headSha !== pr.headSha) {
    return "outdated";
  }
  return review.prReview.published ? "published" : "ready";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open PRs of every configured repo and the open tickets assigned to the user on each
 * provider found in their remotes. One repo or provider failing does not hide the rest.
 */
export async function loadInbox(repos: RepoConfig[], runs: Run[]): Promise<DashboardInbox> {
  const inbox: DashboardInbox = { pullRequests: [], tickets: [], errors: [] };
  const targets = new Map<string, TicketTarget>();

  await Promise.all(
    repos.map(async (repo) => {
      const remote = await repoRemoteOf(repo.path).catch(() => undefined);
      if (!remote) {
        return;
      }
      if (remote.provider === "azure") {
        targets.set(`azure:${remote.organization}/${remote.project}`, { source: "azure", organization: remote.organization, project: remote.project });
      } else {
        targets.set(`github:${remote.owner}/${remote.repo}`, { source: "github", owner: remote.owner, repo: remote.repo });
      }
      try {
        for (const pr of await listPullRequests({ repo: repo.name, repoPath: repo.path })) {
          const ownRun = runs.some((run) => run.pullRequests?.some((created) => created.repo === repo.name && created.id === pr.id));
          if (ownRun) {
            continue;
          }
          // runs come newest first, so the first match is the latest review.
          const review = runs.find((run) => run.request.kind === "prReview" && run.request.repos[0] === repo.name && run.request.prReview?.id === pr.id);
          inbox.pullRequests.push({ ...pr, repo: repo.name, state: prState(pr, review), reviewRunId: review?.id });
        }
      } catch (error) {
        inbox.errors.push({ scope: `PRs de ${repo.name}`, message: message(error) });
      }
    }),
  );

  await Promise.all(
    [...targets.values()].map(async (target) => {
      try {
        // The whole project's open tickets (both lists are capped), the user's own flagged and first.
        const [open, mine] = await Promise.all([listTickets(target, "project"), listTickets(target, "mine").catch(() => [])]);
        const mineIds = new Set(mine.map((ticket) => ticket.id));
        for (const ticket of [...open, ...mine.filter((item) => !open.some((other) => other.id === item.id))]) {
          const run = runs.find(
            (candidate) =>
              candidate.request.kind !== "prReview" &&
              candidate.request.ticketId === String(ticket.id) &&
              (candidate.request.ticketSource ?? "azure") === target.source,
          );
          inbox.tickets.push({ ...ticket, source: target.source, mine: mineIds.has(ticket.id), runId: run?.id, runStatus: run?.status });
        }
      } catch (error) {
        const where = target.source === "azure" ? `Azure DevOps (${target.organization})` : `GitHub (${target.owner}/${target.repo})`;
        inbox.errors.push({ scope: `Tickets de ${where}`, message: message(error) });
      }
    }),
  );

  inbox.pullRequests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  inbox.tickets.sort((a, b) => Number(b.mine) - Number(a.mine) || b.changedDate.localeCompare(a.changedDate));
  return inbox;
}
