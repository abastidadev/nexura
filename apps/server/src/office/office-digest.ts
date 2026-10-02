import type { DashboardInbox, OfficeDigest, OfficeDigestFlow, QuotaInfo, RetryOptions, Run } from "@nexura/shared";

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);
/** Steps that are plumbing, not part of the pipeline people think in. */
const HIDDEN_STEPS = new Set(["classify"]);

function name(run: Run): string {
  return run.request.ticketId ? `#${run.request.ticketId}` : `Flujo ${run.id.slice(0, 6)}`;
}

function isFlow(run: Run): boolean {
  return run.request.kind !== "prReview";
}

/** The step each attempt belongs to, once, in the order the run first reached it, with its latest status. */
function pipeline(run: Run): OfficeDigestFlow["steps"] {
  const latest = new Map<string, OfficeDigestFlow["steps"][number]["status"]>();
  for (const step of [...run.steps].sort((a, b) => a.seq - b.seq)) {
    if (!HIDDEN_STEPS.has(step.step)) latest.set(step.step, step.status);
  }
  if (run.pendingStep && !latest.has(run.pendingStep.step)) latest.set(run.pendingStep.step, "pending");
  return [...latest].map(([step, status]) => ({ step, status }));
}

function waiting(run: Run): OfficeDigestFlow["waiting"] {
  const pending = run.pendingStep;
  if (run.status !== "paused" || !pending) return undefined;
  if (pending.prDrafts?.length) return "pr";
  if (pending.replies?.length) return "replies";
  return "step";
}

function local(day: Date): string {
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

/**
 * What the 3D office shows of Nexura: the flows running (the control room), the PRs the flows got
 * merged (the Hall of Fame), today in numbers (the summary board), PRs waiting for your review
 * (the reviews board) and the quota left (the vending machine). Built from what Nexura already
 * has; no tokens.
 */
export function officeDigest(input: {
  runs: Run[];
  inbox?: DashboardInbox;
  quota?: QuotaInfo;
  trophiesToday: string[];
  coinsToday: number;
  now?: Date;
}): OfficeDigest {
  const now = input.now ?? new Date();
  const today = local(now);
  const isToday = (iso: string | undefined) => Boolean(iso) && local(new Date(iso!)) === today;
  const flows = input.runs.filter(isFlow);
  const finished = (run: Run) => run.steps.map((step) => step.finishedAt ?? "").filter(Boolean).sort().at(-1) ?? run.createdAt;

  const active = flows
    .filter((run) => ACTIVE.has(run.status))
    .map((run): OfficeDigestFlow => {
      const steps = pipeline(run);
      const running = [...run.steps].sort((a, b) => b.seq - a.seq).find((step) => step.status === "running");
      return {
        runId: run.id,
        name: name(run),
        title: run.request.ticketText.split("\n")[0]!.slice(0, 120),
        status: run.status,
        agent: running?.agent ?? run.steps.at(-1)?.agent ?? "claude",
        steps,
        ...(running ? { current: running.step } : run.pendingStep ? { current: run.pendingStep.step } : {}),
        ...(waiting(run) ? { waiting: waiting(run) } : {}),
        costUsd: run.totalCostUsd,
      };
    });

  const merged = flows
    .filter((run) => run.reviewWatch?.prStatus === "completed")
    .map((run) => ({
      runId: run.id,
      name: name(run),
      title: run.pullRequests?.[0]?.title ?? run.request.ticketText.split("\n")[0]!.slice(0, 120),
      ...(run.pullRequests?.[0]?.url ? { url: run.pullRequests[0].url } : {}),
      mergedAt: run.reviewWatch!.mergedAt ?? run.reviewWatch!.checkedAt,
      agents: [...new Set(run.steps.filter((step) => step.kind !== "builtin").map((step) => step.agent ?? "claude"))],
    }))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, 24);

  const quota: OfficeDigest["quota"] = [];
  if (input.quota?.fiveHour) quota.push({ label: "Claude · 5 h", percent: Math.round(input.quota.fiveHour.utilization * 100), resetsAt: input.quota.fiveHour.resetsAt });
  if (input.quota?.sevenDay) quota.push({ label: "Claude · semana", percent: Math.round(input.quota.sevenDay.utilization * 100), resetsAt: input.quota.sevenDay.resetsAt });

  return {
    active,
    merged,
    today: {
      flowsDone: flows.filter((run) => run.status === "done" && isToday(finished(run))).length,
      prsOpened: flows.filter((run) => run.pullRequests?.length && isToday(finished(run))).length,
      prsMerged: merged.filter((merge) => isToday(merge.mergedAt)).length,
      reviews: input.runs.filter((run) => !isFlow(run) && isToday(run.prReview?.published?.at)).length,
      costUsd: Math.round(input.runs.filter((run) => isToday(run.createdAt)).reduce((sum, run) => sum + run.totalCostUsd, 0) * 100) / 100,
      trophies: input.trophiesToday,
      coins: input.coinsToday,
    },
    toReview: (input.inbox?.pullRequests ?? []).slice(0, 12).map((pr) => ({ repo: pr.repo, id: pr.id, title: pr.title, author: pr.author, url: pr.url, reviewed: pr.state === "published" })),
    quota,
  };
}

/**
 * How the office continues a paused flow: as the run proposes it (the PR drafts or replies as they
 * were written), or skipping the step. Editing them stays in Nexura.
 */
export function officeContinue(run: Run, skip: boolean): RetryOptions | undefined {
  const pending = run.pendingStep;
  if (run.status !== "paused" || !pending) {
    throw new Error("Ese flujo no está esperando a nadie");
  }
  if (skip) return { skip: true };
  if (pending.prDrafts?.length) return { prDrafts: pending.prDrafts };
  if (pending.replies?.length) return { replies: pending.replies };
  return undefined;
}
