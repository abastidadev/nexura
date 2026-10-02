import { Component, computed, effect, inject, input, linkedSignal, output, signal } from "@angular/core";
import type { DiffComment, Run } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { readStorage, removeStorage, writeStorage } from "../../core/storage";
import { DiffPanel, type DiffLoader } from "../../shared/diff-panel";
import type { Commentable, NewDiffComment, ShownComment } from "../../shared/diff-view";

/**
 * What the user's comments do with this run, by its state (the server has the same rules):
 * pause = back to implement from the pause; live = into the turn of the step at work;
 * pr = addressReview with the PR open; restart = a stopped flow relaunched from implement;
 * review = own comments added to an unpublished PR review.
 */
type Mode = "pause" | "live" | "pr" | "restart" | "review" | "none";

const FINAL = new Set(["done", "failed", "cancelled"]);
const SEVERITY_LABELS: Record<string, string> = { blocker: "bloqueante", major: "importante", minor: "menor", nit: "detalle" };
const SEND_LABELS: Record<Mode, string> = {
  pause: "Devolver a implement",
  live: "Mandar al paso en curso",
  pr: "Corregir sobre la PR",
  restart: "Relanzar desde implement",
  review: "",
  none: "",
};

/** Comments not sent yet, per run: they survive closing the panel or reloading the page. */
const draftsKey = (runId: string): string => `nexura.diffComments.${runId}`;

/**
 * What a run changed in its repos (`git diff <base>...HEAD` of each worktree). On a flow the
 * user comments lines and sends them to the agent; on a finished PR review, they add their
 * own comments to the review.
 */
@Component({
  selector: "nx-run-changes",
  imports: [DiffPanel],
  template: `
    <nx-diff-panel
      class="min-h-0 flex-1"
      [load]="load()"
      [version]="version()"
      [closable]="closable()"
      [emptyText]="'No queda worktree ni copia guardada: los cambios no se pueden leer desde aquí. Si no borraste la rama, sigue en el repo.'"
      [noChangesText]="'La rama aún no tiene commits con cambios respecto a su base.'"
      [commentable]="commentable()"
      [comments]="shownComments()"
      [askSeverity]="mode() === 'review'"
      [submitLabel]="mode() === 'review' ? 'Añadir a la revisión' : 'Añadir comentario'"
      [placeholder]="mode() === 'review' ? 'El comentario tal como se publicará en la PR…' : 'Qué tiene que cambiar el agente aquí…'"
      [(ignoreWhitespace)]="ignoreWhitespace"
      (closed)="closed.emit()"
      (comment)="addComment($event)"
      (remove)="removeDraft($event)"
    >
      @if (actionError(); as message) {
        <p class="border-t border-err bg-err-soft px-4 py-2 text-err" role="alert">{{ message }}</p>
      }
      @if (sentNotice(); as message) {
        <p class="border-t border-ok bg-ok-soft px-4 py-2 text-ok" role="status">{{ message }}</p>
      }
      @if (sendLabel() && drafts().length) {
        <footer class="border-t border-border bg-surface px-4 py-2.5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm font-medium">{{ drafts().length }} comentario(s)</span>
            <input
              class="nx-input min-w-60 flex-1"
              aria-label="Indicación general (opcional)"
              placeholder="Indicación general (opcional)"
              [value]="note()"
              (input)="note.set($any($event.target).value)"
            />
            <button type="button" class="nx-btn nx-btn-sm" [disabled]="busy()" (click)="discard()">Descartar</button>
            <button type="button" class="nx-btn nx-btn-primary nx-btn-sm" [disabled]="busy()" (click)="send()">
              {{ busy() ? "Enviando…" : sendLabel() }}
            </button>
          </div>
          <p class="mt-1 text-xs text-muted">
            @switch (mode()) {
              @case ("pause") {
                @if (run().pendingStep?.prDrafts) {
                  No se hace push: el agente corrige con tus comentarios, se repiten QA y revisión, y vuelves a aprobar la PR.
                } @else {
                  El flujo vuelve a implement con tus comentarios y sigue desde ahí.
                }
              }
              @case ("live") {
                Se añaden al turno del paso que está trabajando (solo con Claude), como un mensaje en su chat.
              }
              @case ("pr") {
                El agente los aplica con «Atender comentarios» junto a los hilos abiertos de la PR; antes del push te pide aprobación.
              }
              @default {
                El flujo se relanza desde implement con tus comentarios y repite los pasos siguientes.
              }
            }
          </p>
        </footer>
      }
    </nx-diff-panel>
  `,
  host: { class: "flex min-h-0 flex-col bg-bg" },
})
export class RunChanges {
  private readonly api = inject(Api);

  public readonly run = input.required<Run>();
  public readonly closable = input(true);
  public readonly closed = output<void>();

  private readonly runId = computed(() => this.run().id);
  /** Stable per run: a new function would read the diff again on every run update. */
  protected readonly load = computed<DiffLoader>(() => {
    const id = this.runId();
    return (ignoreWhitespace) => this.api.getRunDiff(id, ignoreWhitespace);
  });
  /** Changes when the run moves on (a step ends, a pause): the diff is read again. */
  protected readonly version = computed(() => {
    const run = this.run();
    return `${run.steps.length}:${run.steps.at(-1)?.status ?? ""}:${run.status}:${run.worktrees.length}`;
  });
  protected readonly ignoreWhitespace = signal(false);

  protected readonly mode = computed<Mode>(() => {
    const run = this.run();
    if (run.request.kind === "prReview") {
      return run.prReview && !run.prReview.published && FINAL.has(run.status) ? "review" : "none";
    }
    if (run.worktrees.length === 0) {
      return "none";
    }
    if (run.status === "paused") {
      return run.pendingStep?.replies ? "none" : "pause";
    }
    if (run.status === "running" && run.steps.at(-1)?.status === "running") {
      return "live";
    }
    if (FINAL.has(run.status)) {
      return run.pullRequests?.length ? "pr" : "restart";
    }
    return "none";
  });
  protected readonly commentable = computed<Commentable>(() => (this.mode() === "review" ? "new" : this.mode() === "none" ? "none" : "any"));
  protected readonly sendLabel = computed(() => SEND_LABELS[this.mode()]);

  protected readonly drafts = linkedSignal<string, DiffComment[]>({
    source: this.runId,
    computation: (id) => readStorage<DiffComment[]>(draftsKey(id), []),
  });
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly sentNotice = signal<string | null>(null);

  protected readonly shownComments = computed<ShownComment[]>(() => {
    if (this.mode() !== "review") {
      return this.drafts().map((comment) => ({ ...comment, removable: true }));
    }
    const review = this.run().prReview;
    const repo = this.run().request.repos[0] ?? "";
    // The reviewer's anchored comments too: the diff shows what each one is about.
    return (review?.comments ?? [])
      .filter((comment) => comment.inline && comment.file && comment.startLine)
      .map((comment) => ({
        repo,
        file: comment.file!,
        side: "new" as const,
        startLine: comment.startLine!,
        endLine: comment.endLine ?? comment.startLine!,
        body: comment.post,
        label: `${comment.own ? "Tu comentario" : "Revisor"} · ${SEVERITY_LABELS[comment.severity] ?? comment.severity}`,
      }));
  });

  public constructor() {
    effect(() => {
      const id = this.runId();
      const drafts = this.drafts();
      if (drafts.length) {
        writeStorage(draftsKey(id), drafts);
      } else {
        removeStorage(draftsKey(id));
      }
    });
  }

  protected async addComment(comment: NewDiffComment): Promise<void> {
    this.actionError.set(null);
    this.sentNotice.set(null);
    if (this.mode() !== "review") {
      const { severity: _severity, ...draft } = comment;
      this.drafts.update((drafts) => [...drafts, draft]);
      return;
    }
    this.busy.set(true);
    try {
      // The run comes back over the WebSocket with the comment in its review.
      await this.api.addReviewComment(this.run().id, {
        file: comment.file,
        startLine: comment.startLine,
        endLine: comment.endLine,
        post: comment.body,
        severity: comment.severity,
      });
      this.sentNotice.set("Comentario añadido a la revisión: elígelo en la lista de comentarios para publicarlo.");
    } catch (error) {
      this.actionError.set(apiError(error, "No se pudo añadir el comentario."));
    } finally {
      this.busy.set(false);
    }
  }

  protected removeDraft(comment: ShownComment): void {
    this.drafts.update((drafts) =>
      drafts.filter(
        (draft) =>
          !(draft.repo === comment.repo && draft.file === comment.file && draft.side === comment.side
            && draft.startLine === comment.startLine && draft.endLine === comment.endLine && draft.body === comment.body),
      ),
    );
  }

  protected discard(): void {
    this.drafts.set([]);
    this.note.set("");
  }

  protected async send(): Promise<void> {
    const mode = this.mode();
    this.busy.set(true);
    this.actionError.set(null);
    this.sentNotice.set(null);
    try {
      await this.api.requestChanges(this.run().id, {
        comments: this.drafts(),
        note: this.note().trim() || undefined,
        ignoreWhitespace: this.ignoreWhitespace() || undefined,
      });
      this.discard();
      this.sentNotice.set(mode === "live" ? "Enviado al paso en curso." : "Enviado: el agente se pone con tus comentarios.");
    } catch (error) {
      this.actionError.set(apiError(error, "No se pudieron mandar los comentarios."));
    } finally {
      this.busy.set(false);
    }
  }
}
