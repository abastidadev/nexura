import { Component, computed, effect, input, linkedSignal, model, output, resource } from "@angular/core";
import type { RunDiff } from "@nexura/shared";
import { apiError } from "../core/api";
import { DiffView, type Commentable, type NewDiffComment, type ShownComment } from "./diff-view";
import { Icon } from "./icon";

/** Reads a diff; `ignoreWhitespace` asks for it without whitespace-only changes. */
export type DiffLoader = (ignoreWhitespace: boolean) => Promise<RunDiff>;

/**
 * A diff with its header (totals, branches, refresh, close), its warnings (errors, files not
 * committed, size limit) and nx-diff-view. It loads the diff itself: again when `version`
 * changes, on "Actualizar", and every `pollMs` while the page is visible. A footer can be projected.
 */
@Component({
  selector: "nx-diff-panel",
  imports: [DiffView, Icon],
  template: `
    <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2">
      <h2 class="font-semibold">{{ heading() }}</h2>
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
            @if (repo.baseRef === "HEAD") {
              {{ repo.branch || repo.repo }} · sin commit
            } @else {
              {{ repo.branch }} ← {{ repo.baseRef }}{{ repo.source === "saved" ? " (copia guardada)" : "" }}
            }
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
        <p class="m-auto max-w-md p-6 text-center text-muted">{{ emptyText() }}</p>
      } @else if (totals().files === 0 && !hasErrors()) {
        <p class="m-auto max-w-md p-6 text-center text-muted">{{ noChangesText() }}</p>
      } @else {
        <nx-diff-view
          class="min-h-0 flex-1"
          [repos]="current.repos"
          [commentable]="commentable()"
          [comments]="comments()"
          [askSeverity]="askSeverity()"
          [submitLabel]="submitLabel()"
          [placeholder]="placeholder()"
          [(ignoreWhitespace)]="ignoreWhitespace"
          (comment)="comment.emit($event)"
          (remove)="remove.emit($event)"
        />
      }
    } @else if (loader.isLoading()) {
      <p class="m-auto p-6 text-muted">Leyendo el diff…</p>
    }
    <ng-content />
  `,
  host: { class: "flex min-h-0 flex-col bg-bg" },
})
export class DiffPanel {
  public readonly load = input.required<DiffLoader>();
  /** Changes when what the diff shows may have changed: it is read again. */
  public readonly version = input("");
  /** Reads it again every so many ms while the page is visible (0 = only on demand). */
  public readonly pollMs = input(0);
  public readonly heading = input("Cambios");
  public readonly closable = input(true);
  public readonly emptyText = input("No hay nada que comparar.");
  public readonly noChangesText = input("Sin cambios.");
  public readonly commentable = input<Commentable>("none");
  public readonly comments = input<ShownComment[]>([]);
  public readonly askSeverity = input(false);
  public readonly submitLabel = input("Añadir comentario");
  public readonly placeholder = input("Qué hay que cambiar aquí…");
  /** Whether the diff leaves whitespace-only changes out (a comment is checked against the same diff). */
  public readonly ignoreWhitespace = model(false);
  public readonly closed = output<void>();
  public readonly comment = output<NewDiffComment>();
  public readonly remove = output<ShownComment>();

  protected readonly loader = resource({
    params: () => ({ load: this.load(), version: this.version(), ignoreWhitespace: this.ignoreWhitespace() }),
    loader: ({ params }) => params.load(params.ignoreWhitespace),
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

  public constructor() {
    effect((onCleanup) => {
      const every = this.pollMs();
      if (every <= 0) {
        return;
      }
      const timer = setInterval(() => {
        if (document.visibilityState === "visible" && !this.loader.isLoading()) {
          this.loader.reload();
        }
      }, every);
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Reads the diff again now. */
  public reload(): void {
    this.loader.reload();
  }

  protected errorText(error: unknown): string {
    return apiError(error, "No se pudo leer el diff.");
  }
}
