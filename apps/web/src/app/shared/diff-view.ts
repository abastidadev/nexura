import { Component, computed, effect, type ElementRef, input, linkedSignal, output, signal, viewChild } from "@angular/core";
import { PR_REVIEW_SEVERITIES, type DiffComment, type DiffLine, type FileDiff, type PrFileStatus, type PrReviewSeverity, type RepoDiff } from "@nexura/shared";
import { Icon } from "./icon";

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

const SEVERITY_LABELS: Record<PrReviewSeverity, string> = { blocker: "Bloqueante", major: "Importante", minor: "Menor", nit: "Detalle" };

/** A comment drawn under its last line. `label` names who wrote it; `removable` shows a remove button. */
export type ShownComment = DiffComment & { label?: string; removable?: boolean };

/** What the comment box sends; `severity` only when the box asks for it (a PR review). */
export type NewDiffComment = DiffComment & { severity?: PrReviewSeverity };

/**
 * Which lines can be commented: none, any (old numbers for removed lines), or only new-side
 * lines within one hunk (what a forge anchors an inline PR comment on).
 */
export type Commentable = "none" | "any" | "new";

type Entry = { key: string; repo: string; file: FileDiff };
type Selection = { key: string; side: DiffComment["side"]; hunk: number; anchor: number; start: number; end: number };

/**
 * The files of a diff on the left and the selected one on the right, unified, with the old
 * and new line numbers. Plain text, no highlighter library (like nx-code-snippet). When
 * `commentable`, a click on a line number (shift+click for a range) opens a comment box.
 */
@Component({
  selector: "nx-diff-view",
  imports: [Icon],
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
              @if (commentCounts().get(key); as count) {
                <span class="shrink-0 rounded-full bg-accent-soft px-1.5 text-2xs text-accent" [attr.aria-label]="count + ' comentario(s)'">{{ count }}</span>
              }
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
            @if (commentable() !== "none") {
              <p class="border-b border-border px-3 py-1 text-xs text-muted">
                Pulsa el número de una línea para comentarla; con Mayús, un rango.{{ commentable() === "new" ? " Solo líneas de la versión nueva." : "" }}
              </p>
            }
            <table class="w-full border-collapse font-mono text-xs leading-5">
              @for (hunk of file.hunks; track $index; let hunkIndex = $index) {
                <tbody>
                  <tr class="bg-info-soft">
                    <td colspan="4" class="px-3 py-0.5 whitespace-pre text-muted">{{ hunk.header }}</td>
                  </tr>
                  @for (line of hunk.lines; track $index) {
                    <tr [class]="isSelected(entry, line) ? 'bg-accent-soft' : row[line.kind].classes">
                      <td class="w-12 border-r border-border px-2 text-right align-top text-muted select-none">
                        @if (line.old !== undefined && commentable() === "any") {
                          <button
                            type="button"
                            class="w-full text-right hover:text-accent"
                            [attr.aria-label]="'Comentar la línea ' + line.old + ' de la base'"
                            (click)="pick(entry, hunkIndex, 'old', line.old, $event)"
                          >{{ line.old }}</button>
                        } @else {
                          {{ line.old ?? "" }}
                        }
                      </td>
                      <td class="w-12 border-r border-border px-2 text-right align-top text-muted select-none">
                        @if (line.new !== undefined && commentable() !== "none") {
                          <button
                            type="button"
                            class="w-full text-right hover:text-accent"
                            [attr.aria-label]="'Comentar la línea ' + line.new"
                            (click)="pick(entry, hunkIndex, 'new', line.new, $event)"
                          >{{ line.new }}</button>
                        } @else {
                          {{ line.new ?? "" }}
                        }
                      </td>
                      <td
                        class="w-5 pl-1 align-top select-none"
                        [class.text-ok]="line.kind === 'add'"
                        [class.text-err]="line.kind === 'del'"
                        aria-hidden="true"
                      >{{ row[line.kind].sign }}</td>
                      <td class="pr-3 whitespace-pre">{{ line.text || " " }}</td>
                    </tr>
                    @for (comment of commentsAfter(line); track $index) {
                      <tr>
                        <td colspan="4" class="border-y border-border bg-surface px-3 py-2 font-sans text-sm">
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <p class="text-xs text-muted">{{ comment.label ?? "Tu comentario" }} · {{ place(comment) }}</p>
                              <p class="whitespace-pre-wrap">{{ comment.body }}</p>
                            </div>
                            @if (comment.removable) {
                              <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" aria-label="Quitar el comentario" (click)="remove.emit(comment)">
                                <nx-icon name="x" [size]="14" />
                              </button>
                            }
                          </div>
                        </td>
                      </tr>
                    }
                    @if (boxAfter(entry, line); as current) {
                      <tr>
                        <td colspan="4" class="border-y border-accent bg-surface p-2 font-sans">
                          <label class="mb-1 block text-xs text-muted" for="nx-diff-comment">Comentario en {{ place({ file: file.path, side: current.side, startLine: current.start, endLine: current.end }) }}</label>
                          <textarea
                            #box
                            id="nx-diff-comment"
                            rows="3"
                            class="nx-input w-full resize-y text-sm"
                            [placeholder]="placeholder()"
                            [value]="draft()"
                            (input)="draft.set($any($event.target).value)"
                            (keydown.control.enter)="submit(entry)"
                            (keydown.meta.enter)="submit(entry)"
                            (keydown.escape)="selection.set(undefined)"
                          ></textarea>
                          <div class="mt-1.5 flex flex-wrap items-center gap-2">
                            @if (askSeverity()) {
                              <select class="nx-input" aria-label="Gravedad" (change)="severity.set($any($event.target).value)">
                                @for (option of severities; track option) {
                                  <option [value]="option" [selected]="severity() === option">{{ severityLabels[option] }}</option>
                                }
                              </select>
                            }
                            <span class="text-xs text-muted">Ctrl+Enter para añadirlo</span>
                            <button type="button" class="nx-btn nx-btn-sm ml-auto" (click)="selection.set(undefined)">Cancelar</button>
                            <button type="button" class="nx-btn nx-btn-primary nx-btn-sm" [disabled]="!draft().trim()" (click)="submit(entry)">
                              {{ submitLabel() }}
                            </button>
                          </div>
                        </td>
                      </tr>
                    }
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
  public readonly commentable = input<Commentable>("none");
  public readonly comments = input<ShownComment[]>([]);
  /** The comment box asks for a severity (comments of a PR review). */
  public readonly askSeverity = input(false);
  public readonly submitLabel = input("Añadir comentario");
  public readonly placeholder = input("Qué hay que cambiar aquí…");
  public readonly comment = output<NewDiffComment>();
  public readonly remove = output<ShownComment>();

  protected readonly status = FILE_STATUS;
  protected readonly row = ROW;
  protected readonly severities = PR_REVIEW_SEVERITIES;
  protected readonly severityLabels = SEVERITY_LABELS;

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

  protected readonly selection = signal<Selection | undefined>(undefined);
  protected readonly draft = signal("");
  protected readonly severity = signal<PrReviewSeverity>("minor");
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>("box");

  protected readonly commentCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const comment of this.comments()) {
      const key = this.keyOf(comment.repo, comment.file);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  /** Comments of the open file by the line they end on (`side:line`). */
  private readonly fileComments = computed(() => {
    const entry = this.selected();
    const byLine = new Map<string, ShownComment[]>();
    for (const comment of this.comments()) {
      if (entry && comment.repo === entry.repo && comment.file === entry.file.path) {
        const key = `${comment.side}:${comment.endLine}`;
        byLine.set(key, [...(byLine.get(key) ?? []), comment]);
      }
    }
    return byLine;
  });

  public constructor() {
    // The box appears with the selection: focus it to type right away.
    effect(() => this.box()?.nativeElement.focus());
  }

  protected pick(entry: Entry, hunk: number, side: DiffComment["side"], line: number, event: MouseEvent): void {
    const current = this.selection();
    // A PR comment is anchored inside one hunk: a range across hunks starts over.
    const extend = event.shiftKey && current?.key === entry.key && current.side === side && (this.commentable() !== "new" || current.hunk === hunk);
    if (extend) {
      this.selection.set({ ...current, start: Math.min(current.anchor, line), end: Math.max(current.anchor, line) });
    } else {
      this.selection.set({ key: entry.key, side, hunk, anchor: line, start: line, end: line });
    }
  }

  private numberOn(line: DiffLine, side: DiffComment["side"]): number | undefined {
    return side === "new" ? line.new : line.old;
  }

  protected isSelected(entry: Entry, line: DiffLine): boolean {
    const current = this.selection();
    const number = current && current.key === entry.key ? this.numberOn(line, current.side) : undefined;
    return number !== undefined && number >= current!.start && number <= current!.end;
  }

  protected boxAfter(entry: Entry, line: DiffLine): Selection | undefined {
    const current = this.selection();
    return current && current.key === entry.key && this.numberOn(line, current.side) === current.end ? current : undefined;
  }

  protected commentsAfter(line: DiffLine): ShownComment[] {
    const comments = this.fileComments();
    // A context line carries both numbers: comments of either side may end on it.
    return [
      ...(line.new !== undefined ? (comments.get(`new:${line.new}`) ?? []) : []),
      ...(line.old !== undefined ? (comments.get(`old:${line.old}`) ?? []) : []),
    ];
  }

  protected submit(entry: Entry): void {
    const current = this.selection();
    const body = this.draft().trim();
    if (!current || current.key !== entry.key || !body) {
      return;
    }
    this.comment.emit({
      repo: entry.repo,
      file: entry.file.path,
      side: current.side,
      startLine: current.start,
      endLine: current.end,
      body,
      ...(this.askSeverity() ? { severity: this.severity() } : {}),
    });
    this.selection.set(undefined);
    this.draft.set("");
  }

  protected place(comment: Pick<DiffComment, "file" | "side" | "startLine" | "endLine">): string {
    const range = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
    return `${comment.side === "old" ? "base " : ""}${comment.file}:${range}`;
  }

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
