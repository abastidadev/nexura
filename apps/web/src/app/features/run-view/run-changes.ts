import { Component, computed, effect, inject, input, linkedSignal, output, resource, signal } from "@angular/core";
import type { DiffComment, Run, RunDiff } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { readStorage, removeStorage, writeStorage } from "../../core/storage";
import { DiffView, type Commentable, type NewDiffComment, type ShownComment } from "../../shared/diff-view";
import { Icon } from "../../shared/icon";

const FINAL = new Set(["done", "failed", "cancelled"]);
const COMMENTABLE: Record<"flow" | "review" | "none", Commentable> = { flow: "any", review: "new", none: "none" };
const SEVERITY_LABELS: Record<string, string> = { blocker: "bloqueante", major: "importante", minor: "menor", nit: "detalle" };

/** Comments not sent yet, per run: they survive closing the panel or reloading the page. */
const draftsKey = (runId: string): string => `nexura.diffComments.${runId}`;

/**
 * What a run changed in its repos (`git diff <base>...HEAD` of each worktree). On a flow that
 * can still be corrected, the user comments lines and sends them back to implement; on a
 * finished PR review, they add their own comments to the review.
 */
@Component({
  selector: "nx-run-changes",
  imports: [DiffView, Icon],
  template: `
    <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2">
      <h2 class="font-semibold">Cambios</h2>
      @if (diff(); as current) {
        <span class="text-sm text-muted">
          {{ totals().files }} fichero(s) ·
          <span class="font-mono text-ok">+{{ totals().additions }}</span>
          <span class="font-mono text-err">−{{ totals().deletions }}</span>
        </span>
        @for (repo of current.repos; track repo.repo) {
          <span class="font-mono text-xs text-muted">
            @if (current.repos.length > 1) {
              {{ repo.repo }}:
            }
            {{ repo.branch }} ← {{ repo.baseRef }}{{ repo.source === "saved" ? " (copia guardada)" : "" }}
          </span>
        }
      }
      <div class="ml-auto flex gap-2">
        <button type="button" class="nx-btn nx-btn-sm" [disabled]="loader.isLoading()" (click)="loader.reload()">
          <nx-icon name="refresh" [size]="14" />{{ loader.isLoading() ? "Leyendo…" : "Actualizar" }}
        </button>
        @if (closable()) {
          <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" aria-label="Cerrar los cambios" (click)="closed.emit()">
            <nx-icon name="x" [size]="15" />
          </button>
        }
      </div>
    </header>

    @if (loader.error(); as error) {
      <p class="border-b border-err bg-err-soft px-4 py-2 text-err" role="alert">{{ errorText(error) }}</p>
    }
    @if (diff(); as current) {
      @for (repo of current.repos; track repo.repo) {
        @if (repo.error) {
          <p class="border-b border-err bg-err-soft px-4 py-2 text-err" role="alert">{{ repo.repo }}: {{ repo.error }}</p>
        }
        @if (repo.uncommitted.length) {
          <details class="border-b border-warn bg-warn-soft px-4 py-2 text-sm text-warn">
            <summary class="cursor-pointer">
              {{ repo.uncommitted.length }} fichero(s) sin commit en {{ repo.repo }}: no salen en el diff hasta que se hagan commit.
            </summary>
            <ul class="mt-1 font-mono text-xs">
              @for (path of repo.uncommitted; track path) {
                <li>{{ path }}</li>
              }
            </ul>
          </details>
        }
        @if (repo.truncated) {
          <p class="border-b border-warn bg-warn-soft px-4 py-2 text-sm text-warn">
            {{ repo.repo }}: el diff es muy grande; algunos ficheros se muestran sin sus líneas.
          </p>
        }
      }
      @if (current.repos.length === 0) {
        <p class="m-auto max-w-md p-6 text-center text-muted">
          No queda worktree ni copia guardada: los cambios no se pueden leer desde aquí. Si no borraste la rama, sigue en el repo.
        </p>
      } @else if (totals().files === 0 && !hasErrors()) {
        <p class="m-auto p-6 text-center text-muted">La rama aún no tiene commits con cambios respecto a su base.</p>
      } @else {
        <nx-diff-view
          class="min-h-0 flex-1"
          [repos]="current.repos"
          [commentable]="commentable()"
          [comments]="shownComments()"
          [askSeverity]="mode() === 'review'"
          [submitLabel]="mode() === 'review' ? 'Añadir a la revisión' : 'Añadir comentario'"
          [placeholder]="mode() === 'review' ? 'El comentario tal como se publicará en la PR…' : 'Qué tiene que cambiar el agente aquí…'"
          (comment)="addComment($event)"
          (remove)="removeDraft($event)"
        />
      }
    } @else if (loader.isLoading()) {
      <p class="m-auto p-6 text-muted">Leyendo el diff…</p>
    }

    @if (actionError(); as message) {
      <p class="border-t border-err bg-err-soft px-4 py-2 text-err" role="alert">{{ message }}</p>
    }
    @if (sentNotice(); as message) {
      <p class="border-t border-ok bg-ok-soft px-4 py-2 text-ok" role="status">{{ message }}</p>
    }
    @if (mode() === "flow" && drafts().length) {
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
            {{ busy() ? "Enviando…" : run().status === "paused" ? "Devolver a implement" : "Relanzar desde implement" }}
          </button>
        </div>
        <p class="mt-1 text-xs text-muted">
          @if (run().pendingStep?.prDrafts) {
            No se hace push: el agente corrige con tus comentarios, se repiten QA y revisión, y vuelves a aprobar la PR.
          } @else if (run().status === "paused") {
            El flujo vuelve a implement con tus comentarios y sigue desde ahí.
          } @else {
            El flujo se relanza desde implement con tus comentarios y repite los pasos siguientes.
          }
        </p>
      </footer>
    }
  `,
  host: { class: "flex min-h-0 flex-col bg-bg" },
})
export class RunChanges {
  private readonly api = inject(Api);

  public readonly run = input.required<Run>();
  public readonly closable = input(true);
  public readonly closed = output<void>();

  /** Changes when the run moves on (a step ends, a pause): the diff is read again. */
  private readonly version = computed(() => {
    const run = this.run();
    return `${run.id}:${run.steps.length}:${run.steps.at(-1)?.status ?? ""}:${run.status}`;
  });

  protected readonly loader = resource({
    params: () => ({ id: this.run().id, version: this.version() }),
    loader: ({ params }) => this.api.getRunDiff(params.id),
  });

  /** The last diff read, kept on screen while the next one loads. */
  protected readonly diff = linkedSignal<RunDiff | undefined, RunDiff | undefined>({
    source: () => (this.loader.hasValue() ? this.loader.value() : undefined),
    computation: (next, previous) => next ?? previous?.value,
  });

  protected readonly totals = computed(() => {
    const files = (this.diff()?.repos ?? []).flatMap((repo) => repo.files);
    return {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
  protected readonly hasErrors = computed(() => (this.diff()?.repos ?? []).some((repo) => repo.error));

  /**
   * flow: comments go back to implement (at a pause, or a stopped flow without a PR: the server
   * has the same rules). review: own comments join an unpublished PR review.
   */
  protected readonly mode = computed<"flow" | "review" | "none">(() => {
    const run = this.run();
    if (run.request.kind === "prReview") {
      return run.prReview && !run.prReview.published && FINAL.has(run.status) ? "review" : "none";
    }
    if (run.worktrees.length === 0) {
      return "none";
    }
    if (run.status === "paused") {
      return run.pendingStep?.replies ? "none" : "flow";
    }
    return FINAL.has(run.status) && !run.pullRequests?.length ? "flow" : "none";
  });
  protected readonly commentable = computed<Commentable>(() => COMMENTABLE[this.mode()]);

  protected readonly drafts = linkedSignal<string, DiffComment[]>({
    source: () => this.run().id,
    computation: (id) => readStorage<DiffComment[]>(draftsKey(id), []),
  });
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly sentNotice = signal<string | null>(null);

  protected readonly shownComments = computed<ShownComment[]>(() => {
    if (this.mode() === "flow") {
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
      const id = this.run().id;
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
    if (this.mode() === "flow") {
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
      drafts.filter((draft) => !(draft.repo === comment.repo && draft.file === comment.file && draft.side === comment.side
        && draft.startLine === comment.startLine && draft.endLine === comment.endLine && draft.body === comment.body)),
    );
  }

  protected discard(): void {
    this.drafts.set([]);
    this.note.set("");
  }

  protected async send(): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    this.sentNotice.set(null);
    try {
      await this.api.requestChanges(this.run().id, { comments: this.drafts(), note: this.note().trim() || undefined });
      this.discard();
      this.sentNotice.set("Enviado: el agente vuelve a implement con tus comentarios.");
    } catch (error) {
      this.actionError.set(apiError(error, "No se pudieron mandar los comentarios."));
    } finally {
      this.busy.set(false);
    }
  }

  protected errorText(error: unknown): string {
    return apiError(error, "No se pudo leer el diff.");
  }
}
