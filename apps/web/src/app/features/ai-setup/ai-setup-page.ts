import { Component, computed, effect, inject, input } from "@angular/core";
import { Router } from "@angular/router";
import { AI_SETUP_MODE_LABELS } from "@nexura/shared";
import { NexuraStore } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";
import { setupStatus, setupTitle } from "./ai-setup-format";
import { AiSetupStart } from "./ai-setup-start";
import { AiSetupView } from "./ai-setup-view";

/**
 * Setup IA: assess how a project is set up for coding agents, or write the skill, agent, hook,
 * MCP server or instructions it needs, following the ai-toolkit's way of writing them.
 */
@Component({
  selector: "nx-ai-setup-page",
  imports: [Icon, StatusPill, AiSetupStart, AiSetupView],
  host: { class: "flex h-full min-h-0 flex-col lg:flex-row" },
  template: `
    <h1 class="sr-only">Setup IA</h1>
    <aside class="flex h-40 w-full shrink-0 flex-col border-b border-border bg-surface lg:h-auto lg:w-72 lg:border-r lg:border-b-0" aria-label="Sesiones">
      <div class="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 class="flex-1 text-md font-semibold">Setup IA</h2>
        <button type="button" class="nx-btn nx-btn-primary nx-btn-sm" (click)="open(null)"><nx-icon name="plus" [size]="15" />Nuevo</button>
      </div>
      <nav class="min-h-0 flex-1 overflow-y-auto py-1">
        @for (group of groups(); track group.label) {
          @if (group.sessions.length) {
            <h3 class="px-4 pt-3 pb-1 text-xs font-semibold text-muted">{{ group.label }}</h3>
            @for (item of group.sessions; track item.id) {
              @let state = status(item);
              <button
                type="button"
                class="mx-1 flex w-[calc(100%-0.5rem)] flex-col gap-1 rounded-md px-3 py-2 text-left"
                [class]="item.id === session() ? 'bg-surface-3' : 'hover:bg-surface-2'"
                [attr.aria-current]="item.id === session() ? 'page' : null"
                (click)="open(item.id)"
              >
                <span class="line-clamp-2 font-medium">{{ title(item) }}</span>
                <span class="flex items-center gap-1.5 text-xs text-muted">
                  <nx-status-pill [tone]="state.tone" [label]="state.label" [live]="state.live" />
                  <span class="truncate">{{ modeLabels[item.mode] }} · {{ item.repo }}</span>
                </span>
              </button>
            }
          }
        }
        @if (!store.aiSetupSessions().length) {
          <p class="px-4 py-6 text-center text-sm text-muted">Aún no hay sesiones. Pulsa «Nuevo» para empezar.</p>
        }
      </nav>
    </aside>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Sesión">
      @if (selected(); as current) {
        <nx-ai-setup-view class="min-h-0 flex-1" [session]="current" (deleted)="open(null)" (opened)="open($event)" />
      } @else if (session()) {
        <p class="m-auto px-6 text-center text-muted">Esa sesión ya no existe.</p>
      } @else {
        <nx-ai-setup-start class="min-h-0 flex-1 overflow-y-auto" (started)="open($event.id)" />
      }
    </section>
  `,
})
export class AiSetupPage {
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);

  /** Query param (withComponentInputBinding): the open session. */
  public readonly session = input<string>();

  protected readonly modeLabels = AI_SETUP_MODE_LABELS;
  protected readonly status = setupStatus;
  protected readonly title = setupTitle;

  protected readonly selected = computed(() => {
    const id = this.session();
    return id ? this.store.aiSetupSessions().find((session) => session.id === id) : undefined;
  });
  protected readonly groups = computed(() => {
    const sessions = this.store.aiSetupSessions();
    return [
      { label: "Valoraciones", sessions: sessions.filter((session) => session.mode === "assess") },
      { label: "En curso", sessions: sessions.filter((session) => session.mode === "create" && session.status !== "applied") },
      { label: "Escritos", sessions: sessions.filter((session) => session.mode === "create" && session.status === "applied") },
    ];
  });

  public constructor() {
    // An open session gets its header tab, like flows, reviews, tickets and terminals.
    effect(() => {
      const session = this.selected();
      if (session) {
        this.store.openTab(session.id);
      }
    });
  }

  protected open(id: string | null): void {
    void this.router.navigate([], { queryParams: { session: id } });
  }
}
