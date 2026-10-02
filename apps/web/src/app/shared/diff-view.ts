import { NgTemplateOutlet } from "@angular/common";
import { Component, computed, effect, type ElementRef, input, linkedSignal, model, output, signal, viewChild } from "@angular/core";
import { PR_REVIEW_SEVERITIES, type DiffComment, type DiffLine, type FileDiff, type PrFileStatus, type PrReviewSeverity, type RepoDiff } from "@nexura/shared";
import { readStorage, writeStorage } from "../core/storage";
import { Icon } from "./icon";
import { escapeHtml, highlightLine, languageOf, syntaxHighlighter } from "./syntax";

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

const LAYOUT_KEY = "nexura.diff.layout";
/** Lines rendered at first per file; more on demand (a long diff would block the page). */
const FIRST_LINES = 600;
const MORE_LINES = 2000;

/** A comment drawn under its last line. `label` names who wrote it; `removable` shows a remove button. */
export type ShownComment = DiffComment & { label?: string; removable?: boolean };

/** What the comment box sends; `severity` only when the box asks for it (a PR review). */
export type NewDiffComment = DiffComment & { severity?: PrReviewSeverity };

/**
 * Which lines can be commented: none, any (old numbers for removed lines), or only new-side
 * lines within one hunk (what a forge anchors an inline PR comment on).
 */
export type Commentable = "none" | "any" | "new";

type Layout = "unified" | "split";
type Side = DiffComment["side"];
type Entry = { key: string; repo: string; file: FileDiff };
type Selection = { key: string; side: Side; hunk: number; anchor: number; start: number; end: number };
/** A table row: a hunk header, or a line (unified) / the two sides of a line (split; a context line is on both). */
type Row = { hunk: number; header?: string; left?: DiffLine; right?: DiffLine };

/**
 * The files of a diff on the left and the selected one on the right, unified or side by side,
 * with the old and new line numbers and the syntax colored. When `commentable`, a click on a
 * line number (shift+click for a range) opens a comment box.
 */
@Component({
  selector: "nx-diff-view",
  imports: [Icon, NgTemplateOutlet],
  template: `
    <div class="flex h-full min-h-0">
      <nav class="w-48 shrink-0 overflow-y-auto border-r border-border bg-surface p-2 @3xl:w-72" aria-label="Ficheros cambiados">
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
        <div class="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
          @if (selected(); as entry) {
            <span class="min-w-0 font-mono text-sm break-all">
              @if (entry.file.oldPath) {
                <span class="text-muted">{{ entry.file.oldPath }} → </span>
              }
              {{ entry.file.path }}
            </span>
            <span class="text-xs text-muted">{{ status[entry.file.status].label }}</span>
          }
          <span class="ml-auto flex items-center gap-3 text-xs">
            <label class="flex items-center gap-1.5 text-muted" title="Oculta los cambios que solo tocan espacios en blanco (git diff -w)">
              <input type="checkbox" [checked]="ignoreWhitespace()" (change)="ignoreWhitespace.set($any($event.target).checked)" />
              Ignorar espacios
            </label>
            <span class="flex rounded border border-border p-px" role="group" aria-label="Vista del diff">
              @for (option of layouts; track option.value) {
                <button
                  type="button"
                  class="rounded-sm px-1.5"
                  [class]="layout() === option.value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'"
                  [attr.aria-pressed]="layout() === option.value"
                  (click)="setLayout(option.value)"
                >
                  {{ option.label }}
                </button>
              }
            </span>
          </span>
        </div>

        @if (selected(); as entry) {
          @let file = entry.file;
          @if (file.binary) {
            <p class="p-4 text-muted">Fichero binario (o enlace): no se muestra su contenido.</p>
          } @else if (file.hunks.length === 0) {
            <p class="p-4 text-muted">
              {{ file.status === "renamed" ? "Renombrado sin cambios de contenido." : "Sin cambios de texto (permisos, fichero vacío o solo espacios)." }}
            </p>
          } @else {
            @if (commentable() !== "none") {
              <p class="border-b border-border px-3 py-1 text-xs text-muted">
                Pulsa el número de una línea para comentarla; con Mayús, un rango.{{ commentable() === "new" ? " Solo líneas de la versión nueva." : "" }}
              </p>
            }
            <table class="w-full table-fixed border-collapse font-mono text-xs leading-5">
              <colgroup>
                @if (layout() === "split") {
                  <col class="w-12" /><col /><col class="w-12" /><col />
                } @else {
                  <col class="w-12" /><col class="w-12" /><col class="w-5" /><col />
                }
              </colgroup>
              <tbody>
                @for (row of rows(); track $index) {
                  @if (row.header !== undefined) {
                    <tr class="bg-info-soft">
                      <td colspan="4" class="truncate px-3 py-0.5 whitespace-pre text-muted">{{ row.header }}</td>
                    </tr>
                  } @else if (layout() === "split") {
                    <tr>
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none" [class]="cellClass(entry, row.left, 'old')">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'old', line: row.left }" />
                      </td>
                      <td class="nx-code overflow-hidden border-r border-border px-2 align-top whitespace-pre" [class]="cellClass(entry, row.left, 'old')">
                        @if (row.left) {
                          <span [innerHTML]="code(row.left)"></span>
                        }
                      </td>
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none" [class]="cellClass(entry, row.right, 'new')">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'new', line: row.right }" />
                      </td>
                      <td class="nx-code overflow-hidden px-2 align-top whitespace-pre" [class]="cellClass(entry, row.right, 'new')">
                        @if (row.right) {
                          <span [innerHTML]="code(row.right)"></span>
                        }
                      </td>
                    </tr>
                  } @else {
                    @let line = row.left!;
                    <tr [class]="isSelected(entry, line) ? 'bg-accent-soft' : rowStyle[line.kind].classes">
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'old', line }" />
                      </td>
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'new', line }" />
                      </td>
                      <td class="pl-1 align-top select-none" [class.text-ok]="line.kind === 'add'" [class.text-err]="line.kind === 'del'" aria-hidden="true">
                        {{ rowStyle[line.kind].sign }}
                      </td>
                      <td class="nx-code overflow-hidden pr-3 whitespace-pre" [innerHTML]="code(line)"></td>
                    </tr>
                  }
                  @if (row.header === undefined) {
                    @for (comment of commentsAfter(row); track $index) {
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
                    @if (boxAfter(entry, row); as current) {
                      <tr>
                        <td colspan="4" class="border-y border-accent bg-surface p-2 font-sans">
                          <label class="mb-1 block text-xs text-muted" for="nx-diff-comment">
                            Comentario en {{ place({ file: file.path, side: current.side, startLine: current.start, endLine: current.end }) }}
                          </label>
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
                }
              </tbody>
            </table>
            @if (hiddenLines() > 0) {
              <div class="flex items-center gap-3 border-t border-border px-3 py-2 text-sm">
                <span class="text-muted">Faltan {{ hiddenLines() }} línea(s) por mostrar.</span>
                <button type="button" class="nx-btn nx-btn-sm" (click)="limit.set(limit() + moreLines)">Mostrar {{ moreLines }} más</button>
                <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" (click)="limit.set(totalLines())">Mostrar todo</button>
              </div>
            }
            @if (file.truncated) {
              <p class="border-t border-border px-3 py-2 text-sm text-warn">Diff demasiado largo: solo se muestra el principio. Ábrelo en el terminal para verlo entero.</p>
            }
          }
        } @else {
          <p class="p-6 text-center text-muted">Sin ficheros cambiados.</p>
        }
      </section>
    </div>

    <ng-template #number let-entry="entry" let-hunk="hunk" let-side="side" let-line="line">
      @let value = line ? (side === "new" ? line.new : line.old) : undefined;
      @if (value !== undefined && (side === "new" ? commentable() !== "none" : commentable() === "any")) {
        <button
          type="button"
          class="w-full text-right hover:text-accent"
          [attr.aria-label]="'Comentar la línea ' + value + (side === 'old' ? ' de la base' : '')"
          (click)="pick(entry, hunk, side, value, $event)"
        >{{ value }}</button>
      } @else {
        {{ value ?? "" }}
      }
    </ng-template>
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
  /** Asks for the diff without whitespace changes: whoever loads the diff reads it again. */
  public readonly ignoreWhitespace = model(false);
  public readonly comment = output<NewDiffComment>();
  public readonly remove = output<ShownComment>();

  protected readonly status = FILE_STATUS;
  protected readonly rowStyle = ROW;
  protected readonly severities = PR_REVIEW_SEVERITIES;
  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly moreLines = MORE_LINES;
  protected readonly layouts: { value: Layout; label: string }[] = [
    { value: "unified", label: "Unificado" },
    { value: "split", label: "Dividido" },
  ];
  protected readonly layout = signal<Layout>(readStorage<Layout>(LAYOUT_KEY, "unified"));

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

  protected readonly limit = linkedSignal<string | undefined, number>({ source: this.selectedKey, computation: () => FIRST_LINES });
  protected readonly totalLines = computed(() => (this.selected()?.file.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0));
  protected readonly hiddenLines = computed(() => Math.max(0, this.totalLines() - this.limit()));

  /** The rows of the open file, up to the limit: a context line is on both sides; removed and added runs pair up side by side. */
  protected readonly rows = computed<Row[]>(() => {
    const file = this.selected()?.file;
    const split = this.layout() === "split";
    const rows: Row[] = [];
    let budget = this.limit();
    for (const [hunk, { header, lines }] of (file?.hunks ?? []).entries()) {
      if (budget <= 0) {
        break;
      }
      rows.push({ hunk, header });
      const shown = lines.slice(0, budget);
      budget -= shown.length;
      if (!split) {
        rows.push(...shown.map((line) => ({ hunk, left: line })));
        continue;
      }
      for (let index = 0; index < shown.length; ) {
        const line = shown[index]!;
        if (line.kind === "context") {
          rows.push({ hunk, left: line, right: line });
          index++;
          continue;
        }
        const removed: DiffLine[] = [];
        const added: DiffLine[] = [];
        while (shown[index]?.kind === "del") {
          removed.push(shown[index++]!);
        }
        while (shown[index]?.kind === "add") {
          added.push(shown[index++]!);
        }
        for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
          rows.push({ hunk, left: removed[pair], right: added[pair] });
        }
      }
    }
    return rows;
  });

  private readonly hljs = syntaxHighlighter();
  private readonly language = computed(() => {
    const hljs = this.hljs();
    const file = this.selected()?.file;
    return hljs && file ? languageOf(hljs, file.path) : undefined;
  });
  /** Highlighted HTML per line, for the open file's language. */
  private highlighted = new WeakMap<DiffLine, string>();
  private highlightedFor?: string;

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

  protected setLayout(layout: Layout): void {
    this.layout.set(layout);
    writeStorage(LAYOUT_KEY, layout);
  }

  /** A line's code as HTML: highlighted when the language is known (highlight.js escapes it), else escaped text. */
  protected code(line: DiffLine): string {
    const language = this.language();
    if (this.highlightedFor !== language) {
      this.highlighted = new WeakMap();
      this.highlightedFor = language;
    }
    let html = this.highlighted.get(line);
    if (html === undefined) {
      const hljs = this.hljs();
      html = hljs && language ? highlightLine(hljs, language, line.text) : escapeHtml(line.text);
      this.highlighted.set(line, html || " ");
    }
    return html || " ";
  }

  protected pick(entry: Entry, hunk: number, side: Side, line: number, event: MouseEvent): void {
    const current = this.selection();
    // A PR comment is anchored inside one hunk: a range across hunks starts over.
    const extend = event.shiftKey && current?.key === entry.key && current.side === side && (this.commentable() !== "new" || current.hunk === hunk);
    if (extend) {
      this.selection.set({ ...current, start: Math.min(current.anchor, line), end: Math.max(current.anchor, line) });
    } else {
      this.selection.set({ key: entry.key, side, hunk, anchor: line, start: line, end: line });
    }
  }

  private numberOn(line: DiffLine | undefined, side: Side): number | undefined {
    return side === "new" ? line?.new : line?.old;
  }

  private inSelection(entry: Entry, line: DiffLine | undefined, side: Side): boolean {
    const current = this.selection();
    const number = current && current.key === entry.key && current.side === side ? this.numberOn(line, side) : undefined;
    return number !== undefined && number >= current!.start && number <= current!.end;
  }

  protected isSelected(entry: Entry, line: DiffLine): boolean {
    const side = this.selection()?.side;
    return side !== undefined && this.inSelection(entry, line, side);
  }

  /** Split view: one side of a row, colored by what it is there. */
  protected cellClass(entry: Entry, line: DiffLine | undefined, side: Side): string {
    if (this.inSelection(entry, line, side)) {
      return "bg-accent-soft";
    }
    return !line ? "bg-surface-2" : line.kind === "context" ? "" : ROW[line.kind].classes;
  }

  protected boxAfter(entry: Entry, row: Row): Selection | undefined {
    const current = this.selection();
    if (!current || current.key !== entry.key) {
      return undefined;
    }
    const line = this.layout() === "split" ? (current.side === "new" ? row.right : row.left) : row.left;
    return this.numberOn(line, current.side) === current.end ? current : undefined;
  }

  protected commentsAfter(row: Row): ShownComment[] {
    const comments = this.fileComments();
    const newLine = this.layout() === "split" ? row.right?.new : row.left?.new;
    const oldLine = row.left?.old;
    // A context line carries both numbers: comments of either side may end on it.
    return [
      ...(newLine !== undefined ? (comments.get(`new:${newLine}`) ?? []) : []),
      ...(oldLine !== undefined ? (comments.get(`old:${oldLine}`) ?? []) : []),
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
