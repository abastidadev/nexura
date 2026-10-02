import { NgTemplateOutlet } from "@angular/common";
import { afterRenderEffect, Component, computed, DestroyRef, effect, inject, type ElementRef, input, linkedSignal, model, output, signal, viewChild } from "@angular/core";
import { commentedLines, PR_REVIEW_SEVERITIES, selectedText, type DiffComment, type DiffLine, type FileDiff, type PrFileStatus, type PrReviewSeverity, type RepoDiff } from "@nexura/shared";
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

/**
 * A comment drawn under its last line. `label` names who wrote it; `removable` shows a remove
 * button; `quote` is the text it selected (else it is cut from the diff by its columns).
 */
export type ShownComment = DiffComment & { label?: string; removable?: boolean; quote?: string };

/** What the comment box sends: `quote` = the text selected, if any; `severity` only when the box asks for it (a PR review). */
export type NewDiffComment = DiffComment & { quote?: string; severity?: PrReviewSeverity };

/** A comment kept until it is sent (in the browser): the box's comment without the severity. */
export type DraftComment = Omit<NewDiffComment, "severity">;

/**
 * Which lines can be commented: none, any (old numbers for removed lines), or only new-side
 * lines within one hunk (what a forge anchors an inline PR comment on).
 */
export type Commentable = "none" | "any" | "new";

type Layout = "unified" | "split";
type Side = DiffComment["side"];
type Entry = { key: string; repo: string; file: FileDiff };
/** Lines (and, from a text selection, the exact columns) the comment box is open on. */
type Selection = { key: string; side: Side; hunk: number; anchor: number; start: number; end: number; startOffset?: number; endOffset?: number };
/** A text selection waiting for its comment icon to be clicked, and where to draw the icon. */
type Bubble = Selection & { x: number; y: number };
/** A table row: a hunk header, or a line (unified) / the two sides of a line (split; a context line is on both). */
type Row = { hunk: number; header?: string; left?: DiffLine; right?: DiffLine };

/**
 * The files of a diff on the left and the selected one on the right, unified or side by side,
 * with the old and new line numbers and the syntax colored. When `commentable`, comments are
 * written as in Azure DevOps: select some code and click the comment icon that appears at the
 * end of the selection (the comment is anchored on that exact text), or hover a line and click
 * its icon; a click on a line number (shift+click for a range) works too.
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

      <section #scroller class="relative min-w-0 flex-1 overflow-auto bg-bg" aria-label="Diff del fichero">
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
                Selecciona código y pulsa el icono de comentario que aparece, o el de una línea al pasar el ratón por ella.{{
                  commentable() === "new" ? " Solo la versión nueva, dentro de un mismo bloque." : ""
                }}
              </p>
            }
            <table
              class="w-full table-fixed border-collapse font-mono text-xs leading-5"
              (mousedown)="bubble.set(undefined)"
              (mouseup)="onMouseUp(entry)"
            >
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
                      <td
                        class="nx-code overflow-hidden border-r border-border px-2 align-top whitespace-pre"
                        [class]="cellClass(entry, row.left, 'old')"
                        [attr.data-hunk]="row.hunk"
                        [attr.data-old]="row.left?.old ?? null"
                      >
                        @if (row.left) {
                          <span [innerHTML]="code(row.left)"></span>
                        }
                      </td>
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none" [class]="cellClass(entry, row.right, 'new')">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'new', line: row.right }" />
                      </td>
                      <td
                        class="nx-code overflow-hidden px-2 align-top whitespace-pre"
                        [class]="cellClass(entry, row.right, 'new')"
                        [attr.data-hunk]="row.hunk"
                        [attr.data-new]="row.right?.new ?? null"
                      >
                        @if (row.right) {
                          <span [innerHTML]="code(row.right)"></span>
                        }
                      </td>
                    </tr>
                  } @else {
                    @let line = row.left!;
                    @let lineSide = sideOf(line);
                    <tr class="group" [class]="isSelected(entry, line) ? 'bg-accent-soft' : rowStyle[line.kind].classes">
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'old', line }" />
                      </td>
                      <td class="border-r border-border px-2 text-right align-top text-muted select-none">
                        <ng-container *ngTemplateOutlet="number; context: { entry, hunk: row.hunk, side: 'new', line }" />
                      </td>
                      <td class="relative pl-1 align-top select-none" [class.text-ok]="line.kind === 'add'" [class.text-err]="line.kind === 'del'">
                        <span aria-hidden="true">{{ rowStyle[line.kind].sign }}</span>
                        @if (lineSide) {
                          <!-- As in Azure DevOps: hovering a line shows the icon to comment on it. -->
                          <button
                            type="button"
                            class="absolute inset-y-0 left-0 hidden w-5 place-items-center rounded-sm bg-accent text-on-accent group-hover:grid focus-visible:grid"
                            title="Comentar esta línea"
                            [attr.aria-label]="'Comentar esta línea (' + (lineSide === 'new' ? line.new : line.old) + ')'"
                            (click)="pick(entry, row.hunk, lineSide, lineSide === 'new' ? line.new! : line.old!, $event)"
                          >
                            <nx-icon name="comment" [size]="13" />
                          </button>
                        }
                      </td>
                      <td
                        class="nx-code overflow-hidden pr-3 whitespace-pre"
                        [attr.data-hunk]="row.hunk"
                        [attr.data-old]="line.old ?? null"
                        [attr.data-new]="line.new ?? null"
                        [innerHTML]="code(line)"
                      ></td>
                    </tr>
                  }
                  @if (row.header === undefined) {
                    @for (comment of commentsAfter(row); track $index) {
                      <tr>
                        <td colspan="4" class="border-y border-border bg-surface px-3 py-2 font-sans text-sm">
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <p class="text-xs text-muted">{{ comment.label ?? "Tu comentario" }} · {{ place(comment) }}</p>
                              @if (quoteOf(entry, comment); as quote) {
                                <pre class="my-1 max-h-24 overflow-auto rounded border-l-2 border-accent bg-accent-soft px-2 py-0.5 font-mono text-xs whitespace-pre-wrap">{{ quote }}</pre>
                              }
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
                          @if (selectionQuote(entry, current); as quote) {
                            <pre class="mb-1.5 max-h-24 overflow-auto rounded border-l-2 border-accent bg-accent-soft px-2 py-0.5 font-mono text-xs whitespace-pre-wrap">{{ quote }}</pre>
                          }
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
            @if (bubble(); as pending) {
              @if (pending.key === entry.key) {
                <!-- As in Azure DevOps: the icon at the end of a selection opens its comment. -->
                <button
                  type="button"
                  class="absolute z-30 grid size-7 place-items-center rounded-md bg-accent text-on-accent shadow-lg hover:bg-accent-strong"
                  title="Comentar la selección"
                  aria-label="Comentar la selección"
                  [style.left.px]="pending.x"
                  [style.top.px]="pending.y"
                  (mousedown)="$event.preventDefault()"
                  (click)="openBubble()"
                >
                  <nx-icon name="comment" [size]="15" />
                </button>
              }
            }
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
  host: { class: "@container block min-h-0", "(keydown.escape)": "bubble.set(undefined)" },
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
  /** A text selection with its comment icon showing, not opened yet. */
  protected readonly bubble = signal<Bubble | undefined>(undefined);
  protected readonly draft = signal("");
  protected readonly severity = signal<PrReviewSeverity>("minor");
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>("box");
  private readonly scroller = viewChild<ElementRef<HTMLElement>>("scroller");

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
    // As Azure DevOps does, the text a comment selected stays marked in the code. A CSS custom
    // highlight marks text ranges without touching the colored HTML of the lines.
    afterRenderEffect(() => {
      const entry = this.selected();
      const scroller = this.scroller()?.nativeElement;
      const open = this.selection();
      const marked: Pick<DiffComment, "side" | "startLine" | "endLine" | "startOffset" | "endOffset">[] = this.comments().filter(
        (comment) => entry && comment.repo === entry.repo && comment.file === entry.file.path,
      );
      if (open && entry && open.key === entry.key) {
        marked.push({ side: open.side, startLine: open.start, endLine: open.end, startOffset: open.startOffset, endOffset: open.endOffset });
      }
      // Again whenever the lines are drawn anew: highlight.js arriving replaces their HTML, and the old ranges go empty.
      this.rows();
      this.layout();
      this.language();
      markSelections(scroller, marked);
    });
    inject(DestroyRef).onDestroy(() => markSelections(undefined, []));
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

  /** Which side a line is commented on: its new number when it has one, else its old one (removed lines). */
  protected sideOf(line: DiffLine): Side | undefined {
    if (line.new !== undefined && this.commentable() !== "none") {
      return "new";
    }
    return line.old !== undefined && this.commentable() === "any" ? "old" : undefined;
  }

  /**
   * After a mouse selection inside the code: where it starts and ends (line, side and column)
   * and the comment icon next to its end, as Azure DevOps does. Nothing for a selection that
   * mixes sides (a removed and an added line), leaves the code or, for a PR, spans two hunks.
   */
  protected onMouseUp(entry: Entry): void {
    const selection = document.getSelection();
    const scroller = this.scroller()?.nativeElement;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !scroller || this.commentable() === "none") {
      this.bubble.set(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    const first = codeCell(range.startContainer, scroller);
    const last = codeCell(range.endContainer, scroller);
    const sides: Side[] = this.commentable() === "new" ? ["new"] : ["new", "old"];
    const side = first && last ? sides.find((candidate) => first.dataset[candidate] !== undefined && last.dataset[candidate] !== undefined) : undefined;
    if (!first || !last || !side || (this.commentable() === "new" && first.dataset["hunk"] !== last.dataset["hunk"])) {
      this.bubble.set(undefined);
      return;
    }
    const start = Number(first.dataset[side]);
    let end = Number(last.dataset[side]);
    const startOffset = columnOf(first, range.startContainer, range.startOffset);
    let endOffset = columnOf(last, range.endContainer, range.endOffset);
    // A selection ending at the very start of a line (a triple click) ends with the line before.
    const previous = endOffset === 1 && end > start ? lineOn(entry.file, side, end - 1) : undefined;
    if (previous) {
      end -= 1;
      endOffset = previous.text.length + 1;
    }
    if (start === end && endOffset <= startOffset) {
      this.bubble.set(undefined);
      return;
    }
    const rects = range.getClientRects();
    const corner = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    this.bubble.set({
      key: entry.key,
      side,
      hunk: Number(first.dataset["hunk"]),
      anchor: start,
      start,
      end,
      startOffset,
      endOffset,
      x: Math.min(corner.right - box.left + scroller.scrollLeft + 6, scroller.scrollWidth - 34),
      y: Math.max(0, corner.top - box.top + scroller.scrollTop - 4),
    });
  }

  /** The comment icon of a selection was clicked: the box opens on that exact text. */
  protected openBubble(): void {
    const pending = this.bubble();
    if (!pending) {
      return;
    }
    const { x: _x, y: _y, ...selection } = pending;
    this.selection.set(selection);
    this.bubble.set(undefined);
    document.getSelection()?.removeAllRanges();
  }

  /** The text a comment is about: what it says it quoted, else what its columns select. */
  protected quoteOf(entry: Entry, comment: ShownComment): string | undefined {
    return comment.quote ?? selectedText(entry.file, comment);
  }

  protected selectionQuote(entry: Entry, current: Selection): string | undefined {
    return selectedText(entry.file, { side: current.side, startLine: current.start, endLine: current.end, startOffset: current.startOffset, endOffset: current.endOffset });
  }

  protected pick(entry: Entry, hunk: number, side: Side, line: number, event: MouseEvent): void {
    this.bubble.set(undefined);
    const current = this.selection();
    // A PR comment is anchored inside one hunk: a range across hunks starts over.
    const extend = event.shiftKey && current?.key === entry.key && current.side === side && (this.commentable() !== "new" || current.hunk === hunk);
    if (extend) {
      this.selection.set({ ...current, start: Math.min(current.anchor, line), end: Math.max(current.anchor, line), startOffset: undefined, endOffset: undefined });
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
    const quote = this.selectionQuote(entry, current);
    this.comment.emit({
      repo: entry.repo,
      file: entry.file.path,
      side: current.side,
      startLine: current.start,
      endLine: current.end,
      ...(quote ? { startOffset: current.startOffset, endOffset: current.endOffset, quote } : {}),
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

/** The code cell (with its line numbers in data-*) a node of a selection sits in, inside this diff. */
function codeCell(node: Node, scroller: HTMLElement): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const cell = element?.closest<HTMLElement>("td[data-hunk]");
  return cell && scroller.contains(cell) ? cell : undefined;
}

/** 1-based column of a point of a selection inside a code cell (its text is the line's). */
function columnOf(cell: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(node, offset);
  return before.toString().length + 1;
}

function lineOn(file: FileDiff, side: Side, number: number): DiffLine | undefined {
  return commentedLines(file, { side, startLine: number, endLine: number })[0];
}

const HIGHLIGHT = "nx-diff-comment";

/** The text node and offset at a 0-based character position of a code cell. */
function pointIn(cell: HTMLElement, position: number): [Node, number] | undefined {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (seen + length >= position) {
      return [node, position - seen];
    }
    seen += length;
  }
  return undefined;
}

/** Marks the selected text of each comment in the code cells shown (browsers without the Highlight API just skip it). */
function markSelections(scroller: HTMLElement | undefined, comments: Pick<DiffComment, "side" | "startLine" | "endLine" | "startOffset" | "endOffset">[]): void {
  const registry = typeof CSS === "undefined" ? undefined : (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight) {
    return;
  }
  const ranges: Range[] = [];
  for (const comment of scroller && comments.length ? comments : []) {
    if (!comment.startOffset || !comment.endOffset) {
      continue;
    }
    // One range per line: a range across rows would also mark the numbers and the other side between them.
    for (let line = comment.startLine; line <= comment.endLine; line++) {
      const cell = scroller!.querySelector<HTMLElement>(`td[data-${comment.side}="${line}"]`);
      const length = cell?.textContent?.length ?? 0;
      const start = cell && pointIn(cell, line === comment.startLine ? comment.startOffset - 1 : 0);
      const end = cell && pointIn(cell, line === comment.endLine ? comment.endOffset - 1 : length);
      if (start && end) {
        const range = document.createRange();
        range.setStart(...start);
        range.setEnd(...end);
        ranges.push(range);
      }
    }
  }
  if (ranges.length) {
    registry.set(HIGHLIGHT, new Highlight(...ranges));
  } else {
    registry.delete(HIGHLIGHT);
  }
}
