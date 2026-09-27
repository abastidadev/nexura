import { Component, computed, inject, signal, type OnInit } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { RUN_STATUS, TONE_CLASSES, type Tone } from "./core/format";
import { NexuraStore, type Toast } from "./core/nexura-store";
import { Notifier } from "./core/notifier";
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
  protected readonly notifier = inject(Notifier);
  protected readonly loadError = signal<string | null>(null);
  protected readonly toastBorder: Record<Tone, string> = {
    ok: "border-ok",
    err: "border-err",
    warn: "border-warn",
    info: "border-info",
    accent: "border-accent",
    muted: "border-border",
  };

  protected readonly tabs = computed(() =>
    this.store
      .openTabs()
      .map((id) => this.store.runs().find((run) => run.id === id))
      .filter((run) => run !== undefined)
      .map((run) => ({
        id: run.id,
        label: run.request.ticketId ? `#${run.request.ticketId}` : run.request.ticketText.split("\n")[0]!.slice(0, 28),
        status: RUN_STATUS[run.status],
        dot: TONE_CLASSES[RUN_STATUS[run.status].tone].dot,
        comments: run.reviewWatch?.prStatus === "active" ? run.reviewWatch.activeThreads : 0,
      })),
  );

  /** Steps running right now in any flow (subagents are counted in the Agentes view). */
  protected readonly workingAgents = computed(() =>
    this.store.runs().reduce((sum, run) => sum + run.steps.filter((step) => step.status === "running").length, 0),
  );

  // ---- reordering the run tabs by drag & drop
  protected readonly dragging = signal<string | null>(null);
  protected readonly dropTarget = signal<{ id: string; side: "before" | "after" } | null>(null);

  protected onDragStart(event: DragEvent, id: string): void {
    this.dragging.set(id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  /** The drop side follows the pointer: left half of a tab = before it, right half = after. */
  protected onDragOver(event: DragEvent, id: string): void {
    const dragging = this.dragging();
    if (!dragging) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (dragging === id) {
      this.dropTarget.set(null);
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const side = event.clientX < box.left + box.width / 2 ? "before" : "after";
    const current = this.dropTarget();
    if (current?.id !== id || current.side !== side) {
      this.dropTarget.set({ id, side });
    }
  }

  protected onDragLeave(id: string): void {
    if (this.dropTarget()?.id === id) {
      this.dropTarget.set(null);
    }
  }

  protected onDrop(event: DragEvent, id: string): void {
    event.preventDefault();
    const dragging = this.dragging();
    const target = this.dropTarget();
    if (dragging && target?.id === id) {
      this.store.moveTab(dragging, id, target.side);
    }
    this.onDragEnd();
  }

  protected onDragEnd(): void {
    this.dragging.set(null);
    this.dropTarget.set(null);
  }

  protected openToast(toast: Toast): void {
    this.store.dismissToast(toast.id);
    this.store.openToast(toast);
  }

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
