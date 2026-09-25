import { Component, computed, input, linkedSignal, output } from "@angular/core";
import type { PrDraft } from "@nexura/shared";
import { SOURCE_LABELS } from "../new-run/ticket-picker";

/**
 * The go-ahead for release: shows each PR draft (editable title, description, target and
 * draft flag). Nothing is pushed until "Aprobar"; "Dejar en local" finishes without a PR.
 */
@Component({
  selector: "nx-pr-approval",
  template: `
    <section class="border-b border-accent bg-accent-soft px-4 py-3" aria-labelledby="pr-title">
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="pr-title" class="font-semibold">⇪ Aprobar la PR en {{ providers() }}</h2>
        <span class="text-[12px] text-fg-soft">Al aprobar se hace <code class="font-mono">git push</code> de la rama y se abre la PR con el ticket enlazado.</span>
        <div class="ml-auto flex gap-2">
          <button type="button" class="rounded-md border border-border bg-surface px-3 py-1 hover:bg-surface-3 disabled:opacity-40" [disabled]="busy()" (click)="keepLocal.emit()">
            Dejar en local
          </button>
          <button
            type="button"
            class="rounded-md bg-accent-strong px-3 py-1 font-medium text-white hover:opacity-90 disabled:opacity-40"
            [disabled]="busy()"
            (click)="approve.emit(edited())"
          >
            Aprobar: push + crear PR
          </button>
        </div>
      </div>
      @for (draft of edited(); track draft.repo; let i = $index) {
        <div class="mt-3 grid gap-2 rounded-md border border-border bg-surface p-3 md:grid-cols-[1fr_180px]">
          <div class="text-[12px] text-muted md:col-span-2">
            <span class="font-medium text-fg">{{ draft.repo }}</span> · <span class="font-mono">{{ draft.branch }}</span> →
            <span class="font-mono">{{ draft.target }}</span> en {{ labels[draft.provider] }}
            @if (!draft.workItemId) {
              · sin ticket enlazado (el flujo no tiene ID de ticket de {{ labels[draft.provider] }})
            } @else if (draft.provider === "github") {
              · añade <span class="font-mono">Closes {{ draft.workItemProject ?? "" }}#{{ draft.workItemId }}</span> (el issue se cierra al hacer merge)
            } @else {
              · enlaza el work item <span class="font-mono">#{{ draft.workItemId }}</span>
            }
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted uppercase">Título</span>
            <input class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 outline-none focus:border-accent" [value]="draft.title" (input)="patch(i, { title: value($event) })" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-medium text-muted uppercase">Rama destino</span>
            <input class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono outline-none focus:border-accent" [value]="draft.target" (input)="patch(i, { target: value($event) })" />
          </label>
          <label class="flex flex-col gap-1 md:col-span-2">
            <span class="text-[11px] font-medium text-muted uppercase">Descripción</span>
            <textarea
              rows="6"
              class="resize-y rounded-md border border-border bg-surface-2 px-2.5 py-2 outline-none focus:border-accent"
              [value]="draft.description"
              (input)="patch(i, { description: value($event) })"
            ></textarea>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-[12px]">
            <input type="checkbox" class="size-4 accent-(--nx-accent)" [checked]="draft.isDraft" (change)="patch(i, { isDraft: !draft.isDraft })" />
            Crear como borrador (draft)
          </label>
        </div>
      }
    </section>
  `,
})
export class PrApproval {
  public readonly drafts = input.required<PrDraft[]>();
  public readonly busy = input(false);
  public readonly approve = output<PrDraft[]>();
  public readonly keepLocal = output<void>();

  /** Drafts saved before GitHub support have no provider: they were Azure DevOps. */
  protected readonly edited = linkedSignal(() =>
    structuredClone(this.drafts()).map((draft) => ({ ...draft, provider: draft.provider ?? "azure" })),
  );
  protected readonly labels = SOURCE_LABELS;
  protected readonly providers = computed(() => [...new Set(this.edited().map((draft) => SOURCE_LABELS[draft.provider]))].join(" y "));

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected patch(index: number, changes: Partial<PrDraft>): void {
    this.edited.update((drafts) => drafts.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));
  }
}
