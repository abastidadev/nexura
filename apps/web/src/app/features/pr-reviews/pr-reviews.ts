import { Component, computed, effect, inject, input, linkedSignal, resource, signal } from "@angular/core";
import { Router } from "@angular/router";
import { AGENT_KINDS, AGENT_LABELS, AGENT_MODELS, modelsFor, type AgentKind, type Effort, type PullRequestSummary, type Run } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { RUN_STATUS, timeOfDay } from "../../core/format";
import { isPrReview, NexuraStore } from "../../core/nexura-store";
import { readStorage, writeStorage } from "../../core/storage";
import { ModelPicker } from "../../shared/model-picker";
import { StatusPill } from "../../shared/status-pill";
import { SOURCE_LABELS } from "../new-run/ticket-picker";
import { EFFORTS } from "../run-view/step-inspector";
import { PrReviewView } from "./pr-review-view";

const REVIEWER_KEY = "nexura.reviewer";
const ACTIVE = new Set(["queued", "running", "waiting-rate-limit", "paused"]);

type Reviewer = { agent: AgentKind; model: string; effort: Effort };

type PrRow = {
  pr: PullRequestSummary;
  last?: Run;
  status?: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
  reviewing: boolean;
  outdated: boolean;
  comments?: number;
};

/**
 * Revisiones: the open PRs of each configured repo (GitHub or Azure DevOps, from its origin),
 * reviewed by a headless agent against the repo's own conventions. Several can run at once;
 * each one ends in proposed comments that the user picks, edits and publishes.
 */
@Component({
  selector: "nx-pr-reviews",
  imports: [ModelPicker, StatusPill, PrReviewView],
  templateUrl: "./pr-reviews.html",
  host: { class: "flex h-full min-h-0 flex-col lg:flex-row" },
})
export class PrReviewsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  /** Query params (withComponentInputBinding). */
  public readonly repo = input<string>();
  public readonly run = input<string>();

  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly efforts = EFFORTS;
  protected readonly sourceLabels = SOURCE_LABELS;
  protected readonly timeOfDay = timeOfDay;

  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  protected readonly selectedRepo = computed(() => this.repo() || this.repos()[0]?.name);

  /** Provider of every repo's origin, to label them (one request each, free). */
  protected readonly providers = resource({
    params: () => this.repos().map((repo) => repo.name),
    loader: async ({ params }) =>
      Object.fromEntries(await Promise.all(params.map(async (name) => [name, await this.api.repoProvider(name).catch(() => null)] as const))),
  });

  protected readonly pullRequests = resource({
    params: () => this.selectedRepo(),
    loader: ({ params }) => this.api.listPullRequests(params),
  });
  protected readonly prError = computed(() => apiError(this.pullRequests.error(), "No se pudieron cargar las PRs"));
  private readonly prList = computed<PullRequestSummary[]>(() => (this.pullRequests.hasValue() ? this.pullRequests.value() : []));

  protected readonly query = signal("");
  protected readonly selected = linkedSignal<string | undefined, ReadonlySet<number>>({ source: this.selectedRepo, computation: () => new Set() });

  /** Reviews of the selected repo, newest first. */
  protected readonly reviews = computed(() => this.store.runs().filter((run) => isPrReview(run) && run.request.repos[0] === this.selectedRepo()));

  protected readonly rows = computed<PrRow[]>(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.prList()
      .filter((pr) => {
        const haystack = `${pr.id} ${pr.title} ${pr.author} ${pr.sourceBranch} ${pr.targetBranch}`.toLowerCase();
        return words.every((word) => haystack.includes(word.replace(/^#/, "")));
      })
      .map((pr) => {
        const last = this.reviews().find((run) => run.request.prReview?.id === pr.id);
        const reviewed = last?.prReview;
        return {
          pr,
          last,
          status: last ? RUN_STATUS[last.status] : undefined,
          reviewing: Boolean(last && ACTIVE.has(last.status)),
          outdated: Boolean(reviewed && pr.headSha && reviewed.headSha !== pr.headSha),
          comments: reviewed?.comments.length,
        };
      });
  });

  /** Reviews of PRs that are no longer open (merged, closed) or not in the current list. */
  protected readonly olderReviews = computed(() => {
    const open = new Set(this.prList().map((pr) => pr.id));
    return this.reviews().filter((run) => !open.has(run.request.prReview?.id ?? -1));
  });

  protected readonly selectedRun = computed(() => {
    const id = this.run();
    return id ? this.store.runs().find((run) => run.id === id && isPrReview(run)) : undefined;
  });
  protected readonly selectedHead = computed(() => {
    const prId = this.selectedRun()?.request.prReview?.id;
    return this.prList().find((pr) => pr.id === prId)?.headSha;
  });

  // ---- who reviews: remembered between visits
  protected readonly reviewer = signal<Reviewer>(readStorage<Reviewer>(REVIEWER_KEY, { agent: "claude", model: "sonnet", effort: "high" }));
  private readonly agentInfo = resource({ loader: () => this.api.getAgents() });
  protected readonly models = computed(() => modelsFor(this.reviewer().agent, this.agentInfo.hasValue() ? this.agentInfo.value() : undefined));

  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);

  public constructor() {
    effect(() => writeStorage(REVIEWER_KEY, this.reviewer()));
  }

  protected unseen(run: Run): boolean {
    return this.store.unseenReviews().includes(run.id);
  }

  protected reviewStatus(run: Run): (typeof RUN_STATUS)[keyof typeof RUN_STATUS] {
    return RUN_STATUS[run.status];
  }

  protected selectRepo(name: string): void {
    void this.router.navigate([], { queryParams: { repo: name } });
  }

  protected openReview(run: Run): void {
    void this.router.navigate([], { queryParams: { repo: run.request.repos[0], run: run.id } });
  }

  protected openRow(row: PrRow): void {
    if (row.last) {
      this.openReview(row.last);
    }
  }

  protected toggle(prId: number, checked: boolean): void {
    this.selected.update((selected) => {
      const next = new Set(selected);
      if (checked) {
        next.add(prId);
      } else {
        next.delete(prId);
      }
      return next;
    });
  }

  protected setAgent(agent: AgentKind): void {
    this.reviewer.update((reviewer) => ({ ...reviewer, agent, model: AGENT_MODELS[agent][0]! }));
  }

  protected patchReviewer(change: Partial<Reviewer>): void {
    this.reviewer.update((reviewer) => ({ ...reviewer, ...change }));
  }

  protected reviewSelected(): Promise<void> {
    return this.review([...this.selected()]);
  }

  protected rereview(): Promise<void> {
    const prId = this.selectedRun()?.request.prReview?.id;
    return prId ? this.review([prId]) : Promise.resolve();
  }

  /** Queues one review per PR (they run in parallel up to the server's concurrency) and opens the last one. */
  protected async review(prIds: number[]): Promise<void> {
    const repo = this.selectedRepo();
    if (!repo || prIds.length === 0) {
      return;
    }
    this.starting.set(true);
    this.error.set(null);
    const failures: string[] = [];
    let last: Run | undefined;
    for (const prId of prIds) {
      try {
        const run = await this.api.startPrReview({ repo, prId, ...this.reviewer() });
        this.store.upsertRun(run);
        last = run;
      } catch (error) {
        failures.push(`#${prId}: ${apiError(error, "no se pudo lanzar")}`);
      }
    }
    this.starting.set(false);
    this.selected.set(new Set());
    if (failures.length) {
      this.error.set(failures.join(" · "));
    }
    if (last) {
      this.openReview(last);
    }
  }

  protected afterDelete(): void {
    void this.router.navigate([], { queryParams: { repo: this.selectedRepo() } });
  }
}
