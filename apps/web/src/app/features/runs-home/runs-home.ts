import { Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { Run } from "@nexura/shared";
import { elapsedMs, formatCost, formatDuration, RUN_STATUS, stepLabel, TONE_CLASSES, type Tone } from "../../core/format";
import { apiError } from "../../core/api";
import { isPrReview, NexuraStore } from "../../core/nexura-store";
import { Icon, type IconName } from "../../shared/icon";
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
  statusKey: Run["status"];
};

const ACTIVE = new Set(["queued", "running", "paused", "waiting-rate-limit"]);
/** Runs that wait for the user: a breakpoint or approval, a failure, or the plan quota. */
const NEEDS_USER = new Set(["paused", "failed", "waiting-rate-limit"]);

type Filter = "all" | "active" | "done" | "failed";

@Component({
  selector: "nx-runs-home",
  imports: [RouterLink, StatusPill, Icon],
  templateUrl: "./runs-home.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class RunsHome {
  protected readonly store = inject(NexuraStore);
  protected readonly toneDot = Object.fromEntries(Object.entries(TONE_CLASSES).map(([tone, classes]) => [tone, classes.dot])) as Record<Tone, string>;

  protected readonly totalCost = computed(() => formatCost(this.store.runs().reduce((sum, run) => sum + run.totalCostUsd, 0)));
  protected readonly rows = computed<RunRow[]>(() => {
    const now = this.store.now();
    // PR reviews live in Revisiones.
    return this.store
      .runs()
      .filter((run) => !isPrReview(run))
      .map((run) => this.toRow(run, now));
  });
  protected readonly query = signal("");
  protected readonly filter = signal<Filter>("all");
  protected readonly filteredRows = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.rows().filter((row) => {
      const matchesFilter =
        this.filter() === "all" ||
        (this.filter() === "active" && row.active) ||
        (this.filter() === "done" && row.statusKey === "done") ||
        (this.filter() === "failed" && row.statusKey === "failed");
      return matchesFilter && (!query || [row.title, row.ticketId, row.repos, row.profile].some((value) => value?.toLocaleLowerCase().includes(query)));
    });
  });
  protected readonly activeCount = computed(() => this.rows().filter((row) => row.active).length);
  protected readonly doneCount = computed(() => this.rows().filter((row) => row.statusKey === "done").length);
  protected readonly failedCount = computed(() => this.rows().filter((row) => row.statusKey === "failed").length);
  /** The newest runs waiting for the user; the full list stays below. */
  protected readonly attention = computed(() => this.rows().filter((row) => NEEDS_USER.has(row.statusKey)).slice(0, 6));

  protected readonly filters = computed<{ id: Filter; label: string; count: number }[]>(() => [
    { id: "all", label: "Todos", count: this.rows().length },
    { id: "active", label: "En curso", count: this.activeCount() },
    { id: "done", label: "Terminados", count: this.doneCount() },
    { id: "failed", label: "Con fallos", count: this.failedCount() },
  ]);

  protected readonly stats = computed<{ label: string; value: string | number; icon: IconName; tone: string }[]>(() => [
    { label: "Flujos", value: this.rows().length, icon: "flows", tone: "bg-surface-3 text-fg-soft" },
    { label: "En curso", value: this.activeCount(), icon: "activity", tone: "bg-info-soft text-info" },
    { label: "Terminados", value: this.doneCount(), icon: "done", tone: "bg-ok-soft text-ok" },
    { label: "Coste acumulado", value: this.totalCost(), icon: "coins", tone: "bg-accent-soft text-accent" },
  ]);

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
      statusKey: run.status,
    };
  }
}
