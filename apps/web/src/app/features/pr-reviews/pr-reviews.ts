import { Component, computed, effect, inject, input, resource, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { PullRequestSummary, Run } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { RUN_STATUS, timeAgo } from "../../core/format";
import { isPrReview, NexuraStore } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";
import { SOURCE_LABELS } from "../new-run/ticket-picker";
import { PrDetail } from "./pr-detail";
import { PrReviewView } from "./pr-review-view";

const ACTIVE = new Set(["queued", "running", "waiting-rate-limit", "paused"]);

type PrRow = {
  pr: PullRequestSummary;
  last?: Run;
  status?: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
  reviewing: boolean;
  outdated: boolean;
  comments?: number;
};

/**
 * Revisiones: the open PRs of each configured repo (GitHub or Azure DevOps, from its origin).
 * Picking one shows what it changes and where to launch a review with the agent and model of
 * choice; a PR already reviewed opens on its review, which ends in proposed comments that the
 * user picks, edits and publishes. Several reviews can run at once.
 */
@Component({
  selector: "nx-pr-reviews",
  imports: [StatusPill, PrReviewView, PrDetail, Icon],
  templateUrl: "./pr-reviews.html",
  host: { class: "flex h-full min-h-0 flex-col lg:flex-row" },
})
export class PrReviewsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  /** Query params (withComponentInputBinding): `pr` picks a PR, `run` one of its reviews. */
  public readonly repo = input<string>();
  public readonly pr = input<string>();
  public readonly run = input<string>();

  protected readonly sourceLabels = SOURCE_LABELS;

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
    // Until the list arrives every PR would look closed.
    if (!this.pullRequests.hasValue()) {
      return [];
    }
    const open = new Set(this.prList().map((pr) => pr.id));
    return this.reviews().filter((run) => !open.has(run.request.prReview?.id ?? -1));
  });

  protected readonly selectedRun = computed(() => {
    const id = this.run();
    return id ? this.store.runs().find((run) => run.id === id && isPrReview(run)) : undefined;
  });
  /** The PR in the URL, or the one of the review in it (links from toasts and tabs only name the run). */
  protected readonly selectedPrId = computed(() => Number(this.pr()) || this.selectedRun()?.request.prReview?.id);
  /** Open PR picked; undefined for a review of a PR that is no longer open. */
  protected readonly selectedPr = computed(() => this.prList().find((pr) => pr.id === this.selectedPrId()));
  /** Nexura's reviews of the picked PR, newest first. */
  protected readonly prReviews = computed(() => this.reviews().filter((run) => run.request.prReview?.id === this.selectedPrId()));

  protected readonly providerLabel = computed(() => {
    const repo = this.selectedRepo();
    const provider = repo && this.providers.hasValue() ? this.providers.value()[repo] : undefined;
    return provider ? SOURCE_LABELS[provider] : "el proveedor";
  });

  protected readonly now = this.store.now;
  protected readonly timeAgo = timeAgo;

  public constructor() {
    // An opened review gets its header tab, like flows and terminals.
    effect(() => {
      const run = this.selectedRun();
      if (run) {
        this.store.openTab(run.id);
      }
    });
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

  /** A PR with reviews opens on its latest one; otherwise on its details. */
  protected openRow(row: PrRow): void {
    void this.router.navigate([], { queryParams: { repo: this.selectedRepo(), pr: row.pr.id, run: row.last?.id } });
  }

  protected openReview(run: Run): void {
    void this.router.navigate([], { queryParams: { repo: run.request.repos[0], pr: run.request.prReview?.id, run: run.id } });
  }

  /** The PR's details (and where to launch a new review). */
  protected openDetails(): void {
    void this.router.navigate([], { queryParams: { repo: this.selectedRepo(), pr: this.selectedPrId() } });
  }

  protected afterDelete(): void {
    const next = this.prReviews().find((run) => run.id !== this.run());
    void this.router.navigate([], { queryParams: { repo: this.selectedRepo(), pr: this.selectedPr()?.id, run: next?.id } });
  }
}
