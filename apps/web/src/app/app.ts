import { Component, computed, inject, signal, type OnInit } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { formatCost, RUN_STATUS, TONE_CLASSES } from "./core/format";
import { NexuraStore } from "./core/nexura-store";
import { QuotaMeter } from "./shared/quota-meter";

@Component({
  selector: "nx-root",
  imports: [RouterOutlet, RouterLink, RouterLinkActive, QuotaMeter],
  templateUrl: "./app.html",
  host: { class: "flex h-full flex-col" },
})
export class App implements OnInit {
  private readonly router = inject(Router);
  protected readonly store = inject(NexuraStore);
  protected readonly loadError = signal<string | null>(null);
  protected readonly formatCost = formatCost;

  protected readonly tabs = computed(() =>
    this.store
      .openTabs()
      .map((id) => this.store.runs().find((run) => run.id === id))
      .filter((run) => run !== undefined)
      .map((run) => ({
        id: run.id,
        label: run.request.ticketId ? `#${run.request.ticketId}` : run.request.ticketText.split("\n")[0]!.slice(0, 28),
        cost: run.totalCostUsd,
        status: RUN_STATUS[run.status],
        dot: TONE_CLASSES[RUN_STATUS[run.status].tone].dot,
      })),
  );

  public ngOnInit(): void {
    this.store.init().catch(() => this.loadError.set("No se puede conectar con el servidor de Nexura (npm run serve)."));
  }

  protected closeTab(event: Event, id: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.closeTab(id);
    if (this.router.url.startsWith(`/runs/${id}`)) {
      const remaining = this.store.openTabs();
      void this.router.navigate(remaining.length ? ["/runs", remaining.at(-1)] : ["/"]);
    }
  }
}
