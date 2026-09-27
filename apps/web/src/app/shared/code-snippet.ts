import { Component, computed, input } from "@angular/core";

export type Snippet = { startLine: number; lines: string[]; added: number[] };

/**
 * A few lines of a file with their numbers: the lines the PR adds or changes are marked `+`
 * and the ones a comment points at are highlighted. Plain text, no highlighter library.
 */
@Component({
  selector: "nx-code-snippet",
  template: `
    <div class="overflow-x-auto rounded-md border border-border bg-surface-2 font-mono text-[12px] leading-5">
      @if (file()) {
        <div class="border-b border-border px-3 py-1 text-[11px] text-muted">{{ file() }}</div>
      }
      <table class="w-full border-collapse">
        <tbody>
          @for (row of rows(); track row.number) {
            <tr [class]="row.marked ? 'bg-accent-soft' : row.added ? 'bg-ok-soft' : ''">
              <td class="w-10 border-r border-border px-2 text-right text-muted select-none" [class.!text-accent]="row.marked">{{ row.number }}</td>
              <td class="w-4 pl-1 text-ok select-none" aria-hidden="true">{{ row.added ? "+" : "" }}</td>
              <td class="pr-3 whitespace-pre">{{ row.text || " " }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class CodeSnippet {
  public readonly snippet = input.required<Snippet>();
  public readonly file = input<string>();
  /** Lines the comment is about (inclusive). */
  public readonly from = input<number>();
  public readonly to = input<number>();

  protected readonly rows = computed(() => {
    const { startLine, lines, added } = this.snippet();
    const addedSet = new Set(added);
    const from = this.from() ?? 0;
    const to = this.to() ?? from;
    return lines.map((text, index) => {
      const number = startLine + index;
      return { number, text: text.replace(/\t/g, "  "), added: addedSet.has(number), marked: number >= from && number <= to };
    });
  });
}
