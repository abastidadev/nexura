import { Component, computed, input, linkedSignal } from "@angular/core";
import type { DiffLine, FileDiff, PrFileStatus, RepoDiff } from "@nexura/shared";

export const FILE_STATUS: Record<PrFileStatus, { letter: string; label: string; classes: string }> = {
  added: { letter: "A", label: "Añadido", classes: "bg-ok-soft text-ok" },
  modified: { letter: "M", label: "Modificado", classes: "bg-info-soft text-info" },
  deleted: { letter: "D", label: "Borrado", classes: "bg-err-soft text-err" },
  renamed: { letter: "R", label: "Renombrado", classes: "bg-warn-soft text-warn" },
};

const ROW: Record<DiffLine["kind"], { sign: string; classes: string }> = {
  context: { sign: "", classes: "" },
  add: { sign: "+", classes: "bg-ok-soft" },
  del: { sign: "-", classes: "bg-err-soft" },
};

type Entry = { key: string; repo: string; file: FileDiff };

/**
 * The files of a diff on the left and the selected one on the right, unified, with the old
 * and new line numbers. Plain text, no highlighter library (like nx-code-snippet).
 */
@Component({
  selector: "nx-diff-view",
  template: `
    <div class="flex h-full min-h-0">
      <nav class="w-48 shrink-0 overflow-y-auto @3xl:w-72 border-r border-border bg-surface p-2" aria-label="Ficheros cambiados">
        @for (repo of repos(); track repo.repo) {
          @if (repos().length > 1) {
            <h3 class="px-2 pt-2 pb-1 text-xs font-semibold text-muted">{{ repo.repo }}</h3>
          }
          @for (file of repo.files; track file.path) {
            @let key = keyOf(repo.repo, file.path);
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-2"
              [class.bg-accent-soft]="key === selected()?.key"
              [attr.aria-current]="key === selected()?.key ? 'true' : null"
              [attr.title]="file.oldPath ? file.oldPath + ' → ' + file.path : file.path"
              (click)="selectedKey.set(key)"
            >
              <span
                class="grid size-5 shrink-0 place-items-center rounded text-2xs font-semibold"
                [class]="status[file.status].classes"
                [attr.aria-label]="status[file.status].label"
                >{{ status[file.status].letter }}</span
              >
              <span class="min-w-0 flex-1 truncate">
                <span class="font-mono text-xs">{{ baseName(file.path) }}</span>
                <span class="ml-1 text-2xs text-muted">{{ dirName(file.path) }}</span>
              </span>
              <span class="shrink-0 font-mono text-2xs">
                @if (file.binary) {
                  <span class="text-muted">bin</span>
                } @else {
                  <span class="text-ok">+{{ file.additions }}</span> <span class="text-err">−{{ file.deletions }}</span>
                }
              </span>
            </button>
          }
        }
      </nav>

      <section class="min-w-0 flex-1 overflow-auto bg-bg" aria-label="Diff del fichero">
        @if (selected(); as entry) {
          @let file = entry.file;
          <header class="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
            <span class="min-w-0 font-mono text-sm break-all">
              @if (file.oldPath) {
                <span class="text-muted">{{ file.oldPath }} → </span>
              }
              {{ file.path }}
            </span>
            <span class="text-xs text-muted">{{ status[file.status].label }}</span>
            @if (!file.binary) {
              <span class="ml-auto font-mono text-xs"><span class="text-ok">+{{ file.additions }}</span> <span class="text-err">−{{ file.deletions }}</span></span>
            }
          </header>
          @if (file.binary) {
            <p class="p-4 text-muted">Fichero binario: no se muestra su contenido.</p>
          } @else if (file.hunks.length === 0) {
            <p class="p-4 text-muted">
              {{ file.status === "renamed" ? "Renombrado sin cambios de contenido." : "Sin cambios de texto (permisos o fichero vacío)." }}
            </p>
          } @else {
            <table class="w-full border-collapse font-mono text-xs leading-5">
              @for (hunk of file.hunks; track $index) {
                <tbody>
                  <tr class="bg-info-soft">
                    <td colspan="4" class="px-3 py-0.5 whitespace-pre text-muted">{{ hunk.header }}</td>
                  </tr>
                  @for (line of hunk.lines; track $index) {
                    <tr [class]="row[line.kind].classes">
                      <td class="w-12 border-r border-border px-2 text-right align-top text-muted select-none">{{ line.old ?? "" }}</td>
                      <td class="w-12 border-r border-border px-2 text-right align-top text-muted select-none">{{ line.new ?? "" }}</td>
                      <td
                        class="w-5 pl-1 align-top select-none"
                        [class.text-ok]="line.kind === 'add'"
                        [class.text-err]="line.kind === 'del'"
                        aria-hidden="true"
                      >{{ row[line.kind].sign }}</td>
                      <td class="pr-3 whitespace-pre">{{ line.text || " " }}</td>
                    </tr>
                  }
                </tbody>
              }
            </table>
            @if (file.truncated) {
              <p class="border-t border-border px-3 py-2 text-sm text-warn">Diff demasiado largo: solo se muestra el principio. Ábrelo en el terminal para verlo entero.</p>
            }
          }
        } @else {
          <p class="p-6 text-center text-muted">Sin ficheros cambiados.</p>
        }
      </section>
    </div>
  `,
  host: { class: "@container block min-h-0" },
})
export class DiffView {
  public readonly repos = input.required<RepoDiff[]>();

  protected readonly status = FILE_STATUS;
  protected readonly row = ROW;

  private readonly entries = computed<Entry[]>(() =>
    this.repos().flatMap((repo) => repo.files.map((file) => ({ key: this.keyOf(repo.repo, file.path), repo: repo.repo, file }))),
  );

  /** Keeps the open file across reloads while it is still in the diff. */
  protected readonly selectedKey = linkedSignal<Entry[], string | undefined>({
    source: this.entries,
    computation: (entries, previous) =>
      previous && entries.some((entry) => entry.key === previous.value) ? previous.value : entries[0]?.key,
  });
  protected readonly selected = computed(() => this.entries().find((entry) => entry.key === this.selectedKey()));

  protected keyOf(repo: string, path: string): string {
    return `${repo}\u0000${path}`;
  }

  protected baseName(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  protected dirName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : "";
  }
}
