import { afterNextRender, Component, computed, ElementRef, inject, input, output, resource, signal, viewChild } from "@angular/core";
import type { TicketSource, WorkItemScope, WorkItemSummary } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { Icon } from "../../shared/icon";

export const SOURCE_LABELS: Record<TicketSource, string> = { azure: "Azure DevOps", github: "GitHub" };

const SCOPES: Record<TicketSource, { id: WorkItemScope; label: string; help: string }[]> = {
  azure: [
    { id: "mine", label: "Asignados a mí", help: "En cualquier proyecto de la organización" },
    { id: "project", label: "Todo el proyecto", help: "Los abiertos del proyecto del repo" },
  ],
  github: [
    { id: "mine", label: "Asignados a mí", help: "Los issues abiertos del repo asignados a ti" },
    { id: "project", label: "Todo el repo", help: "Todos los issues abiertos del repo" },
  ],
};

/** Open Azure DevOps work items (backlog + in progress) or GitHub issues to start a flow from. Plain REST, no tokens. */
@Component({
  selector: "nx-ticket-picker",
  imports: [Icon],
  template: `
    <div class="flex flex-wrap items-center gap-2 border-b border-border p-3">
      <div class="nx-seg" role="radiogroup" aria-label="Qué tickets">
        @for (option of scopes(); track option.id) {
          <button
            type="button"
            role="radio"
            [class]="scope() === option.id ? 'nx-seg-on' : ''"
            [attr.aria-checked]="scope() === option.id"
            [attr.title]="option.help"
            (click)="scope.set(option.id)"
          >
            {{ option.label }}
          </button>
        }
      </div>
      <input
        #search
        class="nx-input min-w-0 flex-1"
        placeholder="Filtrar por ID, título, tipo, estado…"
        aria-label="Filtrar tickets"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        (keydown.enter)="$event.preventDefault(); pickFirst()"
      />
      <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" title="Recargar" aria-label="Recargar la lista" (click)="tickets.reload()"><nx-icon name="refresh" [size]="15" /></button>
      <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" aria-label="Cerrar" (click)="closed.emit()">×</button>
    </div>

    @if (states().length > 1) {
      <div class="flex flex-wrap gap-1 border-b border-border px-3 py-2" aria-label="Filtrar por estado">
        @for (state of states(); track state.name) {
          <button
            type="button"
            class="rounded-full border px-2 py-0.5 text-xs"
            [class]="hiddenStates().has(state.name) ? 'border-border text-muted line-through' : 'border-accent bg-accent-soft text-fg'"
            [attr.aria-pressed]="!hiddenStates().has(state.name)"
            (click)="toggleState(state.name)"
          >
            {{ state.name }} <span class="text-muted">{{ state.count }}</span>
          </button>
        }
      </div>
    }

    <div class="min-h-0 flex-1 overflow-y-auto">
      @if (tickets.isLoading()) {
        <p class="px-3 py-8 text-center text-muted">Consultando {{ sourceLabel() }}…</p>
      } @else if (tickets.error()) {
        <p class="m-3 rounded-md border border-err/40 bg-err-soft px-3 py-2 text-err" role="alert">{{ errorText() }}</p>
      } @else if (visible().length === 0) {
        <p class="px-3 py-8 text-center text-muted">
          {{ list().length ? "Ningún ticket coincide con el filtro." : "No hay tickets abiertos aquí." }}
        </p>
      } @else {
        <ul class="divide-y divide-border">
          @for (ticket of visible(); track ticket.id) {
            <li>
              <button type="button" class="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-2" (click)="picked.emit(ticket.id)">
                <span class="w-16 shrink-0 font-mono text-sm text-muted">#{{ ticket.id }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{{ ticket.title }}</span>
                  <span class="block truncate text-xs text-muted">
                    {{ ticket.type }} · {{ ticket.project }}{{ ticket.assignedTo ? " · " + ticket.assignedTo : "" }}
                  </span>
                  @if (ticket.labels?.length) {
                    <span class="mt-0.5 flex flex-wrap gap-1">
                      @for (label of ticket.labels; track label) {
                        <span class="rounded-full bg-surface-3 px-1.5 text-2xs text-fg-soft">{{ label }}</span>
                      }
                    </span>
                  }
                </span>
                <span class="shrink-0 rounded px-1.5 py-0.5 text-xs" [class]="stateClass(ticket.state)">{{ ticket.state }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  host: {
    class: "flex min-h-0 flex-col rounded-lg border border-border-strong bg-surface shadow-2xl",
    "(keydown.escape)": "closed.emit()",
  },
})
export class TicketPicker {
  private readonly api = inject(Api);

  public readonly source = input<TicketSource>("azure");
  /** Repo whose origin remote gives the organisation/project or the GitHub repo. */
  public readonly repo = input<string | undefined>();
  public readonly picked = output<number>();
  public readonly closed = output<void>();

  protected readonly scopes = computed(() => SCOPES[this.source()]);
  protected readonly sourceLabel = computed(() => SOURCE_LABELS[this.source()]);
  protected readonly scope = signal<WorkItemScope>("mine");
  protected readonly query = signal("");
  protected readonly hiddenStates = signal<ReadonlySet<string>>(new Set());
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>("search");

  protected readonly tickets = resource({
    params: () => ({ source: this.source(), scope: this.scope(), repo: this.repo() }),
    loader: ({ params }) => this.api.listTickets(params.source, params.scope, params.repo),
  });

  /** `value()` throws while the resource is in error: read the list through this. */
  protected readonly list = computed<WorkItemSummary[]>(() => (this.tickets.hasValue() ? this.tickets.value() : []));

  protected readonly errorText = computed(() => apiError(this.tickets.error(), "No se pudieron cargar los tickets"));

  protected readonly states = computed(() => {
    const counts = new Map<string, number>();
    for (const ticket of this.list()) {
      counts.set(ticket.state, (counts.get(ticket.state) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  });

  protected readonly visible = computed<WorkItemSummary[]>(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const hidden = this.hiddenStates();
    return this.list().filter((ticket) => {
      if (hidden.has(ticket.state)) {
        return false;
      }
      const haystack = `${ticket.id} ${ticket.title} ${ticket.type} ${ticket.state} ${ticket.assignedTo} ${ticket.iteration} ${(ticket.labels ?? []).join(" ")}`.toLowerCase();
      return words.every((word) => haystack.includes(word.replace(/^#/, "")));
    });
  });

  public constructor() {
    afterNextRender(() => this.search().nativeElement.focus());
  }

  protected toggleState(state: string): void {
    this.hiddenStates.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(state)) {
        next.add(state);
      }
      return next;
    });
  }

  protected pickFirst(): void {
    const first = this.visible()[0];
    if (first) {
      this.picked.emit(first.id);
    }
  }

  /** Not started yet (New, To Do, Proposed…) vs. in progress. */
  protected stateClass(state: string): string {
    return /^(new|to do|proposed|approved|nuevo)$/i.test(state) ? "bg-surface-3 text-fg-soft" : "bg-info-soft text-info";
  }
}
