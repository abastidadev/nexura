import { Component, computed, effect, inject, input, linkedSignal, output, signal, untracked } from "@angular/core";
import { AGENT_LABELS, agentOf, PR_REVIEW_SEVERITIES, type PrReviewSeverity, type PrVote, type Run } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { elapsedMs, formatDuration, RUN_STATUS, timeOfDay, type Tone } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { StatusPill } from "../../shared/status-pill";
import { EventTimeline } from "../run-view/event-timeline";
import { RunChanges } from "../run-view/run-changes";
import { PrReviewCommentCard, SEVERITY } from "./pr-review-comment";
import { Icon } from "../../shared/icon";

export const VOTES: Record<PrVote, { label: string; tone: Tone }> = {
  approve: { label: "Aprobar", tone: "ok" },
  approveWithSuggestions: { label: "Aprobar con sugerencias", tone: "info" },
  waitingForAuthor: { label: "Esperar al autor", tone: "warn" },
};

type Draft = { selected: boolean; post: string };

/** One PR review: live while it runs; then the proposed comments to pick, edit and publish with a vote. */
@Component({
  selector: "nx-pr-review-view",
  imports: [StatusPill, EventTimeline, PrReviewCommentCard, RunChanges, Icon],
  template: `
    @let target = run().request.prReview;
    <header class="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
      <div class="min-w-0 flex-1">
        @if (showTarget()) {
          <h2 class="text-md font-semibold tracking-tight">
            @if (target) {
              <a class="hover:underline" [href]="target.url" target="_blank" rel="noopener">PR #{{ target.id }}</a> · {{ target.title }}
            } @else {
              {{ run().request.ticketText }}
            }
          </h2>
        }
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <nx-status-pill [tone]="status().tone" [label]="cancelling() ? 'Cancelando…' : status().label" [live]="status().live" />
          @if (showTarget() && target) {
            <span class="font-mono">{{ target.sourceBranch }} → {{ target.targetBranch }}</span> · {{ target.author }} ·
          }
          <span>{{ agentLabel() }} {{ run().request.reviewConfig?.model }} ({{ run().request.reviewConfig?.effort }}) · {{ timeOfDay(run().createdAt) }} · {{ duration() }}</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        @if (run().status !== "queued") {
          <button
            type="button"
            class="nx-btn nx-btn-sm"
            [class.nx-btn-primary]="showChanges()"
            [attr.aria-pressed]="showChanges()"
            title="Diff de la PR revisada"
            (click)="showChanges.set(!showChanges())"
          >
            <nx-icon name="fork" [size]="14" />Cambios
          </button>
        }
        @if (active()) {
          <button type="button" class="nx-btn nx-btn-sm" [disabled]="busy() || cancelling()" (click)="cancel()">
            <nx-icon name="stop" [size]="14" />
            {{ cancelling() ? "Cancelando…" : "Cancelar" }}
          </button>
        } @else {
          @if (run().status === "failed" || run().status === "cancelled") {
            <button type="button" class="nx-btn nx-btn-sm" [disabled]="busy()" (click)="retry()">
              Reintentar
            </button>
          }
          @if (canRereview()) {
            <button
              type="button"
              class="nx-btn nx-btn-sm"
              [disabled]="busy()"
              title="Elige agente y modelo y lanza una revisión nueva del estado actual de la PR"
              (click)="rereview.emit()"
            >
              Revisar de nuevo…
            </button>
          }
          <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost hover:text-err!" [disabled]="busy()" title="Borrar esta revisión" (click)="remove()"><nx-icon name="trash" [size]="15" /></button>
        }
      </div>
    </header>

    @if (error(); as message) {
      <p class="mx-5 mt-3 rounded-md border border-err/40 bg-err-soft px-3 py-2 text-err" role="alert">{{ message }}</p>
    }

    @if (showChanges()) {
      <nx-run-changes class="min-h-0 flex-1" [runId]="run().id" [version]="run().status" (closed)="showChanges.set(false)" />
    } @else if (!review()) {
      @if (run().error) {
        <p class="mx-5 mt-3 rounded-md border border-err/40 bg-err-soft px-3 py-2 whitespace-pre-wrap text-err" role="alert">{{ run().error }}</p>
      }
      @if (step(); as current) {
        <nx-event-timeline class="min-h-0 flex-1" [events]="events()" [live]="current.status === 'running'" [speaker]="agentLabel()" />
      } @else {
        <p class="px-5 py-10 text-center text-muted">
          {{ run().status === "queued" ? "En cola: empezará cuando haya un hueco (concurrencia del servidor)." : "Preparando el checkout de la PR…" }}
        </p>
      }
    } @else {
      @let result = review()!;
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        @if (outdated()) {
          <p class="mb-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-warn" role="status">
            La PR tiene commits nuevos desde esta revisión: no se puede votar sobre ellos. En GitHub los comentarios se anclan al commit revisado; en
            Azure DevOps irán como comentarios generales citando fichero y línea. «Revisar de nuevo» revisa el último commit.
          </p>
        }
        @if (!result.published && result.postedIds?.length) {
          <p class="mb-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-warn" role="status">
            La publicación anterior falló a medias: {{ result.postedIds!.length }} comentario(s) ya están en la PR y no se repetirán.
          </p>
        }
        @if (result.published; as published) {
          <p class="mb-3 rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-ok" role="status">
            Publicado {{ timeOfDay(published.at) }}: {{ published.commentIds.length }} comentario(s){{ published.vote ? " y voto «" + votes[published.vote].label + "»" : "" }}.
          </p>
        }

        <section class="rounded-lg border border-border bg-surface p-4">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xs font-semibold text-muted">Veredicto</h3>
            <nx-status-pill [tone]="votes[result.verdict].tone" [label]="votes[result.verdict].label" />
            <span class="font-mono text-xs text-muted">@ {{ result.headSha.slice(0, 8) }}</span>
          </div>
          <p class="mt-2 whitespace-pre-wrap">{{ result.summary }}</p>
          @if (result.strengths.length) {
            <h3 class="mt-3 text-xs font-semibold text-muted">Lo que hace bien</h3>
            <ul class="mt-1 list-disc pl-5 text-fg-soft">
              @for (item of result.strengths; track $index) {
                <li>{{ item }}</li>
              }
            </ul>
          }
          @if (result.conventions.length) {
            <details class="mt-3">
              <summary class="cursor-pointer text-xs font-semibold text-muted">
                Convenciones del repo comprobadas ({{ result.conventions.length }})
              </summary>
              <ul class="mt-1 list-disc pl-5 text-fg-soft">
                @for (item of result.conventions; track $index) {
                  <li>{{ item }}</li>
                }
              </ul>
              @if (result.conventionsSaved) {
                <p class="mt-2 text-sm text-ok">Guardadas en las notas del repo: los próximos flujos y revisiones las tendrán en cuenta.</p>
              } @else {
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" class="nx-btn nx-btn-sm" [disabled]="busy()" (click)="learn()">
                    Guardar en las notas del repo
                  </button>
                  <span class="text-xs text-muted">Salen de leer una PR que puede haber escrito cualquiera: guárdalas solo si son ciertas.</span>
                </div>
              }
            </details>
          }
        </section>

        <div class="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Filtrar por gravedad">
          <h3 class="mr-1 text-xs font-semibold text-muted">Comentarios ({{ result.comments.length }})</h3>
          @for (severity of severities; track severity) {
            @if (counts()[severity]) {
              <button
                type="button"
                class="rounded-full border px-2 py-0.5 text-xs"
                [class]="hidden().has(severity) ? 'border-border text-muted line-through' : 'border-accent bg-accent-soft text-fg'"
                [attr.aria-pressed]="!hidden().has(severity)"
                (click)="toggleSeverity(severity)"
              >
                {{ severityLabel[severity].label }} <span class="text-muted">{{ counts()[severity] }}</span>
              </button>
            }
          }
        </div>

        @if (result.comments.length === 0) {
          <p class="mt-3 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center text-muted">Revisión limpia: nada que comentar.</p>
        }
        <div class="mt-3 flex flex-col gap-3">
          @for (comment of visible(); track comment.id) {
            <nx-pr-review-comment
              [comment]="comment"
              [post]="drafts()[comment.id]?.post ?? comment.post"
              [selected]="drafts()[comment.id]?.selected ?? false"
              [readonly]="Boolean(result.published) || publishedIds().has(comment.id)"
              [published]="publishedIds().has(comment.id)"
              (selectedChange)="patch(comment.id, { selected: $event })"
              (postChange)="patch(comment.id, { post: $event })"
            />
          }
        </div>
      </div>

      @if (!result.published) {
        <footer class="flex flex-wrap items-center gap-3 border-t border-border bg-surface px-5 py-2.5">
          <span class="text-sm text-muted">{{ selectedCount() }} de {{ result.comments.length }} seleccionado(s)</span>
          <label class="flex items-center gap-1.5 text-sm">
            Voto
            <select class="nx-input" aria-label="Voto" (change)="vote.set($any($event.target).value)">
              <option value="" [selected]="vote() === ''">Sin voto</option>
              @for (option of voteOptions; track option) {
                <option [value]="option" [selected]="vote() === option">{{ votes[option].label }}{{ option === result.verdict ? " (sugerido)" : "" }}</option>
              }
            </select>
          </label>
          <!-- On the left: the toasts pile up in the bottom right corner. -->
          <button
            type="button"
            class="nx-btn nx-btn-primary"
            [disabled]="busy() || (selectedCount() === 0 && !vote())"
            (click)="publish()"
          >
            {{ busy() ? "Publicando…" : "Publicar (" + selectedCount() + ")" }}
          </button>
          <span class="text-xs text-muted">Nada sale de Nexura hasta que publicas; se publica con tu cuenta y sin firma.</span>
        </footer>
      }
    }
  `,
  host: { class: "flex min-h-0 flex-col" },
})
export class PrReviewView {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly run = input.required<Run>();
  /** Head commit of the PR right now (from the list); another one than the reviewed = outdated. */
  public readonly currentHead = input<string>();
  /** Shows the PR's title and branches (when no PR header sits above, e.g. a PR already closed). */
  public readonly showTarget = input(false);
  /** The PR is still open: a new review can be launched. */
  public readonly canRereview = input(true);
  public readonly rereview = output<void>();
  public readonly deleted = output<void>();

  /** The PR's diff in place of the comments (same run: kept while it changes status). */
  protected readonly showChanges = linkedSignal<string, boolean>({ source: () => this.run().id, computation: () => false });

  protected readonly Boolean = Boolean;
  protected readonly timeOfDay = timeOfDay;
  protected readonly votes = VOTES;
  protected readonly voteOptions = Object.keys(VOTES) as PrVote[];
  protected readonly severities = PR_REVIEW_SEVERITIES;
  protected readonly severityLabel = SEVERITY;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hidden = signal<ReadonlySet<PrReviewSeverity>>(new Set());

  protected readonly status = computed(() => RUN_STATUS[this.run().status]);
  protected readonly active = computed(() => ["queued", "running", "waiting-rate-limit", "paused"].includes(this.run().status));
  /** From the click until the run stops: the server may need a moment (checkout, cleanup). Reset on every start and stop. */
  private readonly cancelRequested = linkedSignal({ source: () => `${this.run().id}:${this.active()}`, computation: () => false });
  protected readonly cancelling = computed(() => this.cancelRequested() && this.active());
  protected readonly agentLabel = computed(() => AGENT_LABELS[agentOf(this.run().request.reviewConfig)]);
  protected readonly duration = computed(() => {
    const step = this.run().steps.at(-1);
    return step ? formatDuration(elapsedMs(step.startedAt, step.finishedAt, this.store.now())) : "—";
  });
  protected readonly step = computed(() => this.run().steps.at(-1));
  protected readonly events = computed(() => {
    const step = this.step();
    return step ? this.store.events(this.run().id, step.id)() : [];
  });
  protected readonly review = computed(() => this.run().prReview);
  protected readonly outdated = computed(() => {
    const head = this.currentHead();
    const review = this.review();
    return Boolean(head && review && !review.published && head !== review.headSha);
  });
  /** On the PR already: published, or left there by a publish that failed halfway. */
  protected readonly publishedIds = computed(() => new Set([...(this.review()?.published?.commentIds ?? []), ...(this.review()?.postedIds ?? [])]));

  /** Stable per review: the drafts survive the run updates the WebSocket keeps sending. */
  private readonly reviewKey = computed(() => {
    const review = this.review();
    return review ? `${this.run().id}@${review.headSha}:${review.comments.length}` : "";
  });
  /** Everything but the nits goes by default; edits stay until the review changes. */
  protected readonly drafts = linkedSignal<string, Partial<Record<number, Draft>>>({
    source: this.reviewKey,
    computation: () =>
      Object.fromEntries((untracked(this.review)?.comments ?? []).map((comment) => [comment.id, { selected: comment.severity !== "nit", post: comment.post }])),
  });
  protected readonly vote = linkedSignal<string, PrVote | "">({ source: this.reviewKey, computation: () => untracked(this.review)?.verdict ?? "" });

  protected readonly counts = computed(() => {
    const counts: Partial<Record<PrReviewSeverity, number>> = {};
    for (const comment of this.review()?.comments ?? []) {
      counts[comment.severity] = (counts[comment.severity] ?? 0) + 1;
    }
    return counts;
  });
  protected readonly visible = computed(() => (this.review()?.comments ?? []).filter((comment) => !this.hidden().has(comment.severity)));
  protected readonly selectedCount = computed(() => this.chosen().length);
  /** What "Publicar" sends: ticked, not empty, not on the PR yet. */
  private readonly chosen = computed(() =>
    Object.entries(this.drafts())
      .filter(([id, draft]) => draft?.selected && draft.post.trim() && !this.publishedIds().has(Number(id)))
      .map(([id, draft]) => ({ id: Number(id), post: draft!.post.trim() })),
  );

  public constructor() {
    // Looking at a finished review is what "seen" means.
    effect(() => {
      const run = this.run();
      if (run.status === "done") {
        untracked(() => this.store.markReviewSeen(run.id));
      }
    });
  }

  protected patch(id: number, change: Partial<Draft>): void {
    this.drafts.update((drafts) => ({ ...drafts, [id]: { ...drafts[id]!, ...change } }));
  }

  protected toggleSeverity(severity: PrReviewSeverity): void {
    this.hidden.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(severity)) {
        next.add(severity);
      }
      return next;
    });
  }

  protected learn(): Promise<void> {
    return this.act(async () => this.store.upsertRun(await this.api.learnConventions(this.run().id)), "No se pudieron guardar las convenciones");
  }

  protected publish(): Promise<void> {
    const comments = this.chosen();
    const vote = this.vote() || undefined;
    const target = this.run().request.prReview;
    const what = `${comments.length} comentario(s)${vote ? ` y el voto «${VOTES[vote].label}»` : ""}`;
    if (!confirm(`¿Publicar ${what} en la PR #${target?.id ?? ""} con tu cuenta?`)) {
      return Promise.resolve();
    }
    return this.act(async () => this.store.upsertRun(await this.api.publishPrReview(this.run().id, { comments, vote })), "No se pudo publicar en la PR");
  }

  protected async cancel(): Promise<void> {
    this.cancelRequested.set(true);
    await this.act(() => this.api.cancel(this.run().id), "No se pudo cancelar");
    if (this.error()) {
      this.cancelRequested.set(false);
    }
  }

  protected retry(): Promise<void> {
    return this.act(async () => this.store.upsertRun(await this.api.retry(this.run().id, {})), "No se pudo reintentar");
  }

  protected remove(): Promise<void> {
    if (!confirm("¿Borrar esta revisión? Solo se borra de Nexura; la PR no cambia.")) {
      return Promise.resolve();
    }
    return this.act(async () => {
      await this.store.deleteRun(this.run().id);
      this.deleted.emit();
    }, "No se pudo borrar");
  }

  private async act(action: () => Promise<unknown>, fallback: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (error) {
      this.error.set(apiError(error, fallback));
    } finally {
      this.busy.set(false);
    }
  }
}
