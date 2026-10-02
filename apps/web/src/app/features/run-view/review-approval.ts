import { Component, computed, input, linkedSignal, output } from "@angular/core";
import type { ReviewReply } from "@nexura/shared";

type ReplyRow = ReviewReply & { include: boolean };

const ACTIONS: { value: ReviewReply["action"]; label: string }[] = [
  { value: "fixed", label: "Arreglado (resuelve el hilo)" },
  { value: "answered", label: "Respondido (lo deja abierto)" },
  { value: "wontFix", label: "No se hará (cierra el hilo)" },
];

/** Go-ahead for addressReview: local commits + drafted replies. Nothing leaves the machine before "Aprobar". */
@Component({
  selector: "nx-review-approval",
  template: `
    <section class="border-b border-accent bg-accent-soft px-4 py-3" aria-labelledby="review-title">
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="review-title" class="font-semibold">💬 Aprobar respuestas a la revisión</h2>
        <span class="text-sm text-fg-soft">
          @if (commits().length) {
            Commits locales: <span class="font-mono">{{ commits().join(", ") }}</span>. Al aprobar se hace push y se publican las respuestas marcadas.
          } @else {
            Sin cambios de código. Al aprobar se publican las respuestas marcadas.
          }
        </span>
        <div class="ml-auto flex gap-2">
          <button type="button" class="nx-btn nx-btn-sm" (click)="viewChanges.emit()">Ver cambios</button>
          <button type="button" class="nx-btn nx-btn-sm" [disabled]="busy()" (click)="keepLocal.emit()">
            Descartar (sin push ni respuestas)
          </button>
          <button
            type="button"
            class="nx-btn nx-btn-primary nx-btn-sm"
            [disabled]="busy()"
            (click)="approve.emit(selected())"
          >
            Aprobar ({{ selected().length }})
          </button>
        </div>
      </div>
      @for (row of rows(); track row.repo + row.threadId; let i = $index) {
        <div class="mt-2 grid gap-2 rounded-md border border-border bg-surface p-3 md:grid-cols-[auto_1fr_240px]" [class.opacity-50]="!row.include">
          <input
            type="checkbox"
            class="mt-1 size-4"
            [attr.aria-label]="'Publicar respuesta al hilo ' + row.threadId"
            [checked]="row.include"
            (change)="patch(i, { include: !row.include })"
          />
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{ row.repo }} · hilo {{ row.threadId }}</span>
            <textarea
              rows="2"
              class="nx-input resize-y"
              [value]="row.reply"
              (input)="patch(i, { reply: value($event) })"
            ></textarea>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">Acción</span>
            <select class="nx-input" (change)="patch(i, { action: $any(value($event)) })">
              @for (action of actions; track action.value) {
                <option [value]="action.value" [selected]="action.value === row.action">{{ action.label }}</option>
              }
            </select>
          </label>
        </div>
      }
    </section>
  `,
})
export class ReviewApproval {
  public readonly replies = input.required<ReviewReply[]>();
  public readonly commits = input<string[]>([]);
  public readonly busy = input(false);
  public readonly approve = output<ReviewReply[]>();
  public readonly keepLocal = output<void>();
  /** Open the diff of what is about to be pushed. */
  public readonly viewChanges = output<void>();

  protected readonly actions = ACTIONS;
  protected readonly rows = linkedSignal<ReplyRow[]>(() => this.replies().map((reply) => ({ ...reply, include: true })));
  protected readonly selected = computed(() =>
    this.rows()
      .filter((row) => row.include)
      .map(({ include: _include, ...reply }) => reply),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected patch(index: number, changes: Partial<ReplyRow>): void {
    this.rows.update((rows) => rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }
}
