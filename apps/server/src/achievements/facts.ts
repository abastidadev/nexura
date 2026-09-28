import type { AgentKind, Run, TicketDraft } from "@nexura/shared";
import type { Fact } from "./achievement-store.ts";

/** A flow that finished well (with or without a ticket). */
export type FlowFact = { runId: string; ticket?: string; agents: AgentKind[]; repos: number; firstTry: boolean; recovered: boolean };
/** The PR of a flow got merged. */
export type MergeFact = { runId: string; ticket?: string; reviewedByOthers: boolean; addressed: boolean };
/** A review of someone else's PR, published. */
export type ReviewFact = { runId: string; comments: number; suggestions: number };
/** A published comment the PR's author fixed. */
export type FixedFact = { severity: string; merged: boolean };

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);

export function isActiveFlow(run: Run): boolean {
  return run.request.kind !== "prReview" && ACTIVE.has(run.status);
}

/** The same ticket across flows: its provider and id. */
export function ticketKey(source: string | undefined, id: string | number): string {
  return `${source ?? "azure"}:${id}`;
}

export function prKey(repo: string, id: number): string {
  return `${repo}#${id}`;
}

/** When a finished run finished: its last step's end, else when it was created. */
function finishedAt(run: Run): string {
  return run.steps.map((step) => step.finishedAt ?? "").filter(Boolean).sort().at(-1) ?? run.createdAt;
}

/**
 * What a run says about the user's work. `flowPrs` = PRs opened by Nexura's flows: reviewing one
 * of those is not reviewing someone else's PR.
 */
export function factsOfRun(run: Run, flowPrs: ReadonlySet<string>): Fact[] {
  const facts: Fact[] = [];
  if (run.request.kind === "prReview") {
    const review = run.prReview;
    const target = run.request.prReview;
    const repo = run.request.repos[0];
    if (!review?.published || !target || !repo || flowPrs.has(prKey(repo, target.id))) {
      return facts;
    }
    const published = new Set(review.published.commentIds);
    const comments = review.comments.filter((comment) => published.has(comment.id));
    facts.push({
      kind: "review",
      key: prKey(repo, target.id),
      at: review.published.at,
      data: { runId: run.id, comments: comments.length, suggestions: comments.filter((comment) => comment.suggestion?.trim()).length } satisfies ReviewFact,
    });
    if (review.conventionsSaved && review.conventions.length) {
      facts.push({ kind: "conventions", key: run.id, at: review.published.at, data: {} });
    }
    const followUp = review.followUp;
    if (followUp?.headMoved) {
      const severity = new Map(review.comments.map((comment) => [comment.id, comment.severity]));
      for (const id of followUp.resolvedIds) {
        const level = severity.get(id);
        if (level && level !== "nit") {
          facts.push({
            kind: "fixed",
            key: `${prKey(repo, target.id)}:${id}`,
            at: followUp.checkedAt,
            data: { severity: level, merged: followUp.prStatus === "completed" } satisfies FixedFact,
          });
        }
      }
    }
    return facts;
  }

  const ticket = run.request.ticketId ? ticketKey(run.request.ticketSource, run.request.ticketId) : undefined;
  if (run.status === "done") {
    const agents = [...new Set(run.steps.filter((step) => step.kind !== "builtin" && step.status === "succeeded").map((step) => step.agent ?? "claude"))];
    const implementations = run.steps.filter((step) => step.step === "implement" && step.status === "succeeded").length;
    const at = finishedAt(run);
    facts.push({
      kind: "flow",
      key: run.id,
      at,
      data: {
        runId: run.id,
        ticket,
        agents,
        repos: run.request.repos.length,
        firstTry: implementations === 1,
        recovered: run.steps.some((step) => step.status === "failed"),
      } satisfies FlowFact,
    });
    if (ticket) {
      facts.push({ kind: "ticket", key: ticket, at, data: { runId: run.id } });
    }
  }
  const watch = run.reviewWatch;
  if (watch?.prStatus === "completed") {
    facts.push({
      kind: "merge",
      key: run.id,
      at: watch.mergedAt ?? watch.checkedAt,
      data: {
        runId: run.id,
        ticket,
        reviewedByOthers: Boolean(watch.reviewedByOthers),
        addressed: run.steps.some((step) => step.step === "addressReview" && step.status === "succeeded"),
      } satisfies MergeFact,
    });
  }
  return facts;
}

/** Tickets created on the board from the Tickets section. */
export function factsOfDraft(draft: TicketDraft): Fact[] {
  return draft.items.flatMap((item) =>
    item.created ? [{ kind: "created", key: ticketKey(draft.source, item.created.id), at: draft.updatedAt, data: { draftId: draft.id } }] : [],
  );
}

/** PRs that Nexura's flows opened, as `repo#id`. */
export function flowPrKeys(runs: Run[]): Set<string> {
  return new Set(runs.flatMap((run) => (run.pullRequests ?? []).map((pr) => prKey(pr.repo, pr.id))));
}
