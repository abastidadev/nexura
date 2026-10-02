import { Component, computed, input, output, signal } from "@angular/core";
import type { PrReviewComment, PrReviewSeverity } from "@nexura/shared";
import { TONE_CLASSES, type Tone } from "../../core/format";
import { CodeSnippet } from "../../shared/code-snippet";

export const SEVERITY: Record<PrReviewSeverity, { label: string; tone: Tone }> = {
  blocker: { label: "Blocker", tone: "err" },
  major: { label: "Major", tone: "warn" },
  minor: { label: "Minor", tone: "info" },
  nit: { label: "Nit", tone: "muted" },
};

/** One proposed comment: where, the code, why it matters, the fix, and the text that would be posted (editable). */
@Component({
  selector: "nx-pr-review-comment",
  imports: [CodeSnippet],
  template: `
    <article class="rounded-lg border bg-surface p-3" [class]="selected() && !readonly() ? 'border-accent' : 'border-border'">
      <header class="flex flex-wrap items-start gap-2">
        @if (!readonly()) {
          <input
            type="checkbox"
            class="mt-0.5 size-4"
            [checked]="selected()"
            [attr.aria-label]="'Publicar el comentario ' + comment().id"
            (change)="selectedChange.emit($any($event.target).checked)"
          />
        } @else if (published()) {
          <span class="text-ok" title="Publicado en la PR" aria-label="Publicado">✔</span>
        }
        <span class="rounded px-1.5 py-0.5 text-xs font-semibold" [class]="tone().bg + ' ' + tone().text">{{ severity().label }}</span>
        @if (comment().own) {
          <span class="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent" title="Lo escribiste tú en el diff">Tuyo</span>
        }
        <h3 class="min-w-0 flex-1 font-medium">{{ comment().title }}</h3>
        <span class="text-xs text-muted" [attr.title]="comment().inline ? 'Se ancla en esas líneas de la PR' : 'Va como comentario general de la PR, citando el sitio'">
          {{ comment().inline ? "en línea" : "general" }}
        </span>
      </header>

      @if (place()) {
        <p class="mt-1 font-mono text-sm text-fg-soft">{{ place() }}</p>
      }

      @if (comment().snippet; as snippet) {
        <nx-code-snippet class="mt-2 block" [snippet]="snippet" [from]="comment().startLine" [to]="comment().endLine" />
      }

      @if (comment().why) {
        <div class="mt-2">
          <h4 class="text-xs font-semibold text-muted">Por qué</h4>
          <p class="mt-0.5 whitespace-pre-wrap text-fg-soft">{{ comment().why }}</p>
        </div>
      }

      @if (comment().suggestion) {
        <div class="mt-2">
          <h4 class="text-xs font-semibold text-muted">Sugerencia</h4>
          <pre class="mt-0.5 overflow-x-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm leading-5">{{ comment().suggestion }}</pre>
        </div>
      }

      <div class="mt-2">
        <div class="flex items-center justify-between gap-2">
          <label class="text-xs font-semibold text-muted" [attr.for]="'post-' + comment().id">Comentario para la PR</label>
          <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" (click)="copy()">
            {{ copied() ? "Copiado ✔" : "Copiar" }}
          </button>
        </div>
        <textarea
          class="nx-input mt-1 w-full resize-y disabled:opacity-70"
          rows="2"
          spellcheck="true"
          lang="en"
          [id]="'post-' + comment().id"
          [value]="post()"
          [disabled]="readonly()"
          (input)="postChange.emit($any($event.target).value)"
        ></textarea>
      </div>
    </article>
  `,
})
export class PrReviewCommentCard {
  public readonly comment = input.required<PrReviewComment>();
  public readonly post = input.required<string>();
  public readonly selected = input(false);
  /** Already published (or not publishable): no checkbox, no editing. */
  public readonly readonly = input(false);
  public readonly published = input(false);
  public readonly selectedChange = output<boolean>();
  public readonly postChange = output<string>();

  protected readonly copied = signal(false);
  protected readonly severity = computed(() => SEVERITY[this.comment().severity]);
  protected readonly tone = computed(() => TONE_CLASSES[this.severity().tone]);
  protected readonly place = computed(() => {
    const { file, startLine, endLine } = this.comment();
    if (!file) {
      return "";
    }
    if (!startLine) {
      return file;
    }
    return `${file}:${startLine}${endLine && endLine > startLine ? `-${endLine}` : ""}`;
  });

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.post());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard blocked: the text is selectable anyway.
    }
  }
}
