import { Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { Run } from "@nexura/shared";
import { elapsedMs, formatCost, formatDuration, RUN_STATUS, stepLabel } from "../../core/format";
import { apiError } from "../../core/api";
import { isPrReview, NexuraStore } from "../../core/nexura-store";
import { StatusPill } from "../../shared/status-pill";

type RunRow = {
  id: string;
  title: string;
  ticketId?: string;
  repos: string;
  profile: string;
  step: string;
  cost: string;
  duration: string;
  created: string;
  status: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
  error?: string;
  active: boolean;
};

const ACTIVE = new Set(["queued", "running", "paused", "waiting-rate-limit"]);

@Component({
  selector: "nx-runs-home",
  imports: [RouterLink, StatusPill],
  templateUrl: "./runs-home.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class RunsHome {
  private readonly store = inject(NexuraStore);
  private readonly router = inject(Router);

  protected readonly totalCost = computed(() => formatCost(this.store.runs().reduce((sum, run) => sum + run.totalCostUsd, 0)));
  protected readonly rows = computed<RunRow[]>(() => {
    const now = this.store.now();
    // PR reviews live in Revisiones.
    return this.store
      .runs()
      .filter((run) => !isPrReview(run))
      .map((run) => this.toRow(run, now));
  });

  protected readonly deleting = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async remove(event: Event, row: RunRow): Promise<void> {
    event.stopPropagation();
    const name = row.ticketId ? `#${row.ticketId} ${row.title}` : row.title;
    if (!confirm(`¿Borrar el flujo "${name}"?\n\nSe borran su historial, sus logs y sus worktrees. Las ramas con commits se conservan; las vacías se borran.`)) {
      return;
    }
    this.deleting.set(row.id);
    this.error.set(null);
    try {
      await this.store.deleteRun(row.id);
    } catch (error: unknown) {
      this.error.set(apiError(error, "No se pudo borrar el flujo"));
    } finally {
      this.deleting.set(null);
    }
  }

  protected open(id: string): void {
    this.store.openTab(id);
    void this.router.navigate(["/runs", id]);
  }

  private toRow(run: Run, now: number): RunRow {
    const current = run.steps.at(-1);
    const last = run.steps.findLast((step) => step.finishedAt)?.finishedAt;
    const live = RUN_STATUS[run.status].live;
    return {
      id: run.id,
      title: run.request.ticketText.split("\n")[0] ?? "",
      ticketId: run.request.ticketId,
      repos: run.request.repos.join(", "),
      profile: run.resolvedProfile ?? (run.request.profile === "auto" ? "auto…" : run.request.profile),
      step: current ? `${stepLabel(current.step)}${current.attempt > 1 ? ` #${current.attempt}` : ""}` : "—",
      cost: formatCost(run.totalCostUsd),
      duration: formatDuration(elapsedMs(run.createdAt, live ? undefined : (last ?? run.createdAt), now)),
      created: new Date(run.createdAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }),
      status: RUN_STATUS[run.status],
      error: run.error,
      active: ACTIVE.has(run.status),
    };
  }
}
