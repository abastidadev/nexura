import { Component, computed, effect, inject, input, linkedSignal, output, resource, signal } from "@angular/core";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MODELS,
  modelsFor,
  type AgentKind,
  type Effort,
  type PrReviewerState,
  type PullRequestSummary,
  type Run,
} from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { modelDetail, RUN_STATUS, timeOfDay, type Tone } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { readStorage, writeStorage } from "../../core/storage";
import { DiffPanel, type DiffLoader } from "../../shared/diff-panel";
import { FILE_STATUS } from "../../shared/diff-view";
import { Icon } from "../../shared/icon";
import { ModelPicker } from "../../shared/model-picker";
import { StatusPill } from "../../shared/status-pill";
import { EFFORTS } from "../run-view/step-inspector";

const REVIEWER_KEY = "nexura.reviewer";
const ACTIVE = new Set(["queued", "running", "waiting-rate-limit", "paused"]);

type Reviewer = { agent: AgentKind; model: string; effort: Effort };

const REVIEWER_STATE: Record<PrReviewerState, { label: string; tone: Tone }> = {
  approved: { label: "Aprobada", tone: "ok" },
  suggestions: { label: "Aprobada con sugerencias", tone: "info" },
  waiting: { label: "Pide cambios", tone: "warn" },
  rejected: { label: "Rechazada", tone: "err" },
  commented: { label: "Comentó", tone: "muted" },
  pending: { label: "Pendiente", tone: "muted" },
};

/**
 * An open PR before (or between) reviews: what it changes, who looks at it and the tickets it
 * links, all read from the provider for free; and where to launch a review, picking the agent,
 * model and effort (remembered between visits).
 */
@Component({
  selector: "nx-pr-detail",
  imports: [ModelPicker, StatusPill, Icon, DiffPanel],
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-4">
        <section class="nx-card p-4" aria-labelledby="pr-review-launch">
          <div class="flex flex-wrap items-start gap-3">
            <div class="min-w-0 flex-1">
              <h3 id="pr-review-launch" class="nx-panel-title">{{ reviews().length ? "Revisar de nuevo" : "Revisar esta PR" }}</h3>
              <p class="mt-0.5 text-sm text-muted">
                El agente lee el código de la PR con las convenciones del propio repo y propone comentarios. Nada se publica hasta que los eliges.
              </p>
            </div>
          </div>
          @if (running(); as current) {
            <div class="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm text-info" role="status">
              <span class="flex-1">Ya hay una revisión de esta PR en marcha.</span>
              <button type="button" class="nx-btn nx-btn-sm" (click)="open.emit(current)">Ver la revisión</button>
            </div>
          } @else {
            @if (outdated()) {
              <p class="mt-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
                La PR tiene commits nuevos desde la última revisión.
              </p>
            }
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1">
                <span class="nx-label">Agente</span>
                <select class="nx-input" (change)="setAgent($any($event.target).value)">
                  @for (option of agentKinds; track option) {
                    <option [value]="option" [selected]="option === reviewer().agent">{{ agentLabels[option] }}</option>
                  }
                </select>
              </label>
              <div class="flex w-40 flex-col gap-1">
                <span class="nx-label" aria-hidden="true">Modelo</span>
                <nx-model-picker field [models]="models()" [value]="reviewer().model" label="Modelo que revisa" (valueChange)="patchReviewer({ model: $event })" />
              </div>
              <label class="flex flex-col gap-1">
                <span class="nx-label">Esfuerzo</span>
                <select class="nx-input" (change)="patchReviewer({ effort: $any($event.target).value })">
                  @for (option of efforts; track option) {
                    <option [value]="option" [selected]="option === reviewer().effort">{{ option }}</option>
                  }
                </select>
              </label>
              <button type="button" class="nx-btn nx-btn-primary ml-auto" [disabled]="starting()" (click)="review()">
                <nx-icon name="play" [size]="15" />
                {{ starting() ? "Lanzando…" : reviews().length ? "Revisar de nuevo" : "Revisar" }}
              </button>
            </div>
          }
          @if (error(); as message) {
            <p class="mt-3 rounded-md border border-err/40 bg-err-soft px-3 py-2 text-sm text-err" role="alert">{{ message }}</p>
          }
        </section>

        @if (detail.hasValue()) {
          @let info = detail.value();
          <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="nx-stat-card py-3!">
              <dt class="nx-eyebrow">Ficheros</dt>
              <dd class="mt-1 text-lg font-semibold tabular-nums">{{ info.changedFiles }}</dd>
            </div>
            <div class="nx-stat-card py-3!">
              <dt class="nx-eyebrow">Líneas</dt>
              <dd class="mt-1 text-lg font-semibold tabular-nums">
                @if (info.additions !== undefined) {
                  <span class="text-ok">+{{ info.additions }}</span>&nbsp;<span class="text-err">−{{ info.deletions }}</span>
                } @else {
                  <span class="text-muted" title="Azure DevOps no da el recuento de líneas">—</span>
                }
              </dd>
            </div>
            <div class="nx-stat-card py-3!">
              <dt class="nx-eyebrow">Commits</dt>
              <dd class="mt-1 text-lg font-semibold tabular-nums">{{ info.commits ?? "—" }}</dd>
            </div>
            <div class="nx-stat-card py-3!">
              <dt class="nx-eyebrow">Revisiones</dt>
              <dd class="mt-1 text-lg font-semibold tabular-nums">{{ reviews().length }}</dd>
            </div>
          </dl>
        } @else if (detail.isLoading()) {
          <p class="text-sm text-muted" role="status">Cargando los detalles de la PR…</p>
        } @else if (detail.error()) {
          <p class="rounded-md border border-err/40 bg-err-soft px-3 py-2 text-sm text-err" role="alert">
            {{ detailError() }}
            <button type="button" class="ml-2 underline" (click)="detail.reload()">Reintentar</button>
          </p>
        }

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div class="flex min-w-0 flex-col gap-4">
            <section class="nx-card p-4" aria-labelledby="pr-description">
              <h3 id="pr-description" class="nx-panel-title">Descripción</h3>
              @if (pr().description.trim()) {
                <p class="mt-2 max-h-80 overflow-y-auto text-sm whitespace-pre-wrap text-fg-soft">{{ pr().description.trim() }}</p>
              } @else {
                <p class="mt-2 text-sm text-muted">La PR no tiene descripción.</p>
              }
            </section>

            @if (detail.hasValue()) {
              @let info = detail.value();
              <section class="nx-card p-4" aria-labelledby="pr-files">
                <div class="flex items-center gap-2">
                  <h3 id="pr-files" class="nx-panel-title">Ficheros cambiados ({{ info.changedFiles }})</h3>
                  @if (info.files.length) {
                    <button
                      type="button"
                      class="nx-btn nx-btn-sm ml-auto"
                      [class.nx-btn-primary]="showDiff()"
                      [attr.aria-pressed]="showDiff()"
                      title="El diff completo de la PR, sin revisarla (git, sin tokens)"
                      (click)="showDiff.set(!showDiff())"
                    >
                      <nx-icon name="fork" [size]="14" />Ver diff
                    </button>
                  }
                </div>
                @if (showDiff()) {
                  <p class="mt-2 text-sm text-muted">El diff completo está debajo.</p>
                } @else if (info.files.length === 0) {
                  <p class="mt-2 text-sm text-muted">No hay ficheros cambiados.</p>
                } @else {
                  <ul class="mt-2 max-h-96 divide-y divide-border overflow-y-auto">
                    @for (file of info.files; track file.path) {
                      @let status = fileStatus[file.status];
                      <li class="flex items-center gap-2 py-1.5 text-sm">
                        <span class="inline-flex size-5 shrink-0 items-center justify-center rounded font-mono text-2xs font-semibold" [class]="status.classes" [attr.title]="status.label" [attr.aria-label]="status.label">
                          {{ status.letter }}
                        </span>
                        <span class="min-w-0 flex-1 truncate font-mono" [attr.title]="file.path">
                          <span class="text-muted">{{ dirOf(file.path) }}</span>{{ baseOf(file.path) }}
                        </span>
                        @if (file.additions !== undefined) {
                          <span class="shrink-0 font-mono text-xs tabular-nums">
                            <span class="text-ok">+{{ file.additions }}</span>&nbsp;<span class="text-err">−{{ file.deletions }}</span>
                          </span>
                        }
                      </li>
                    }
                  </ul>
                  @if (info.files.length < info.changedFiles) {
                    <p class="mt-2 text-xs text-muted">
                      Y {{ info.changedFiles - info.files.length }} más:
                      <a class="text-accent hover:underline" [href]="pr().url" target="_blank" rel="noopener">verlos en la PR</a>.
                    </p>
                  }
                }
              </section>
            }
          </div>

          <aside class="flex min-w-0 flex-col gap-4" aria-label="Contexto de la PR">
            <section class="nx-card p-4" aria-labelledby="pr-tickets">
              <h3 id="pr-tickets" class="nx-panel-title">Tickets vinculados</h3>
              @if (detail.hasValue() && detail.value().tickets.length) {
                <ul class="mt-2 flex flex-col gap-1.5">
                  @for (ticket of detail.value().tickets; track ticket.id) {
                    <li>
                      <a class="group flex items-start gap-1.5 text-sm hover:text-accent" [href]="ticket.url" target="_blank" rel="noopener">
                        <span class="shrink-0 font-mono text-muted group-hover:text-accent">#{{ ticket.id }}</span>
                        <span class="min-w-0 flex-1">{{ ticket.title || "Sin título" }}</span>
                        <nx-icon class="mt-0.5 shrink-0 text-muted" name="external" [size]="13" />
                      </a>
                    </li>
                  }
                </ul>
              } @else {
                <p class="mt-2 text-sm text-muted">{{ detail.hasValue() ? "Ninguno." : "…" }}</p>
              }
            </section>

            <section class="nx-card p-4" aria-labelledby="pr-reviewers">
              <h3 id="pr-reviewers" class="nx-panel-title">Revisores</h3>
              @if (detail.hasValue() && detail.value().reviewers.length) {
                <ul class="mt-2 flex flex-col gap-1.5">
                  @for (person of detail.value().reviewers; track person.name) {
                    <li class="flex items-center gap-2 text-sm">
                      <span class="min-w-0 flex-1 truncate">{{ person.name }}</span>
                      <nx-status-pill [tone]="reviewerState[person.state].tone" [label]="reviewerState[person.state].label" />
                    </li>
                  }
                </ul>
              } @else {
                <p class="mt-2 text-sm text-muted">{{ detail.hasValue() ? "Nadie todavía." : "…" }}</p>
              }
              @if (detail.hasValue() && detail.value().labels.length) {
                <h3 class="mt-4 nx-panel-title">Etiquetas</h3>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  @for (label of detail.value().labels; track label) {
                    <span class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-fg-soft">{{ label }}</span>
                  }
                </div>
              }
            </section>

            @if (reviews().length) {
              <section class="nx-card p-4" aria-labelledby="pr-history">
                <h3 id="pr-history" class="nx-panel-title">Revisiones de Nexura</h3>
                <ul class="mt-2 flex flex-col gap-1">
                  @for (past of reviews(); track past.id) {
                    @let status = runStatus[past.status];
                    <li>
                      <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2" (click)="open.emit(past)">
                        <span class="min-w-0 flex-1">
                          <span class="block truncate font-mono text-xs">{{ past.request.reviewConfig ? modelDetail(past.request.reviewConfig) : "" }}</span>
                          <span class="block text-xs text-muted">
                            {{ timeOfDay(past.createdAt) }}{{ past.prReview ? " · " + past.prReview.comments.length + " comentario(s)" : "" }}{{ past.prReview?.published ? " · publicada" : "" }}
                          </span>
                        </span>
                        <nx-status-pill [tone]="status.tone" [label]="status.label" [live]="status.live" />
                      </button>
                    </li>
                  }
                </ul>
              </section>
            }
          </aside>
        </div>
        @if (showDiff()) {
          <nx-diff-panel
            class="h-[80vh] overflow-hidden rounded-lg border border-border"
            heading="Diff de la PR"
            [load]="diffLoad()"
            [version]="pr().headSha"
            [emptyText]="'No se pudo leer el diff de la PR.'"
            [noChangesText]="'La PR no cambia ningún fichero respecto a su rama destino.'"
            (closed)="showDiff.set(false)"
          />
        }
      </div>
    </div>
  `,
  host: { class: "flex min-h-0 flex-col" },
})
export class PrDetail {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly repo = input.required<string>();
  public readonly pr = input.required<PullRequestSummary>();
  /** Nexura's reviews of this PR, newest first. */
  public readonly reviews = input<Run[]>([]);
  /** A review was launched, or one of the list was picked. */
  public readonly open = output<Run>();

  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly efforts = EFFORTS;
  protected readonly fileStatus = FILE_STATUS;
  protected readonly reviewerState = REVIEWER_STATE;
  protected readonly runStatus = RUN_STATUS;
  protected readonly timeOfDay = timeOfDay;
  protected readonly modelDetail = modelDetail;

  protected readonly detail = resource({
    params: () => ({ repo: this.repo(), id: this.pr().id }),
    loader: ({ params }) => this.api.getPullRequestDetail(params.repo, params.id),
  });
  protected readonly detailError = computed(() => apiError(this.detail.error(), "No se pudieron cargar los detalles de la PR"));

  /** The PR's diff in place of the file list (fetched into the repo, no checkout, zero tokens). */
  protected readonly showDiff = linkedSignal<number, boolean>({ source: () => this.pr().id, computation: () => false });
  private readonly prId = computed(() => this.pr().id);
  /** Stable per PR: the list reloading must not read the diff again (a new head does, through `version`). */
  protected readonly diffLoad = computed<DiffLoader>(() => {
    const repo = this.repo();
    const id = this.prId();
    return (ignoreWhitespace) => this.api.getPullRequestDiff(repo, id, ignoreWhitespace);
  });

  protected readonly running = computed(() => this.reviews().find((run) => ACTIVE.has(run.status)));
  protected readonly outdated = computed(() => {
    const reviewed = this.reviews().find((run) => run.prReview)?.prReview;
    return Boolean(reviewed && this.pr().headSha && reviewed.headSha !== this.pr().headSha);
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

  protected dirOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/") + 1);
  }

  protected baseOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  protected setAgent(agent: AgentKind): void {
    this.reviewer.update((reviewer) => ({ ...reviewer, agent, model: AGENT_MODELS[agent][0]! }));
  }

  protected patchReviewer(change: Partial<Reviewer>): void {
    this.reviewer.update((reviewer) => ({ ...reviewer, ...change }));
  }

  /** Queues the review (it runs up to the server's concurrency) and opens it. */
  protected async review(): Promise<void> {
    this.starting.set(true);
    this.error.set(null);
    try {
      const run = await this.api.startPrReview({ repo: this.repo(), prId: this.pr().id, ...this.reviewer() });
      this.store.upsertRun(run);
      this.open.emit(run);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo lanzar la revisión"));
    } finally {
      this.starting.set(false);
    }
  }
}
