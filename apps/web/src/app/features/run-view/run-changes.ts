import { Component, computed, inject, input, linkedSignal, output, resource } from "@angular/core";
import type { RunDiff } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { DiffView } from "../../shared/diff-view";
import { Icon } from "../../shared/icon";

/** What a run changed in its repos (`git diff <base>...HEAD` of each worktree), read-only. */
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
        <nx-diff-view class="min-h-0 flex-1" [repos]="current.repos" />
      }
    } @else if (loader.isLoading()) {
      <p class="m-auto p-6 text-muted">Leyendo el diff…</p>
    }
  `,
  host: { class: "flex min-h-0 flex-col bg-bg" },
})
export class RunChanges {
  private readonly api = inject(Api);

  public readonly runId = input.required<string>();
  /** Changes when the run moves on (a step ends, a pause): the diff is read again. */
  public readonly version = input("");
  public readonly closable = input(true);
  public readonly closed = output<void>();

  protected readonly loader = resource({
    params: () => ({ id: this.runId(), version: this.version() }),
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

  protected errorText(error: unknown): string {
    return apiError(error, "No se pudo leer el diff.");
  }
}
