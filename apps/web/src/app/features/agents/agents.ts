import { Component, computed, effect, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { Run } from "@nexura/shared";
import { ACTIVE_RUN_STATUSES, buildRunAgents, countWorking, plannedSteps, type AgentEvent, type AgentNode } from "../../core/agents";
import { formatCost, RUN_STATUS } from "../../core/format";
import { NexuraStore, readStorage, writeStorage } from "../../core/nexura-store";
import { PixelOffice } from "../../shared/pixel-office/pixel-office";
import { StatusPill } from "../../shared/status-pill";

const FILTER_KEY = "nexura.agentsFilter";
const RECENT_MS = 24 * 60 * 60 * 1000;

type Filter = "active" | "all";

type Room = {
  run: Run;
  title: string;
  status: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
  cost: string;
  agents: AgentNode[];
  working: number;
  waiting: number;
};

/** Every agent of every flow as a pixel-art office: one room per flow. */
@Component({
  selector: "nx-agents",
  imports: [RouterLink, PixelOffice, StatusPill],
  templateUrl: "./agents.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class AgentsPage {
  protected readonly store = inject(NexuraStore);
  protected readonly filter = signal<Filter>(readStorage<Filter>(FILTER_KEY, "all"));
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  private readonly activeRuns = computed(() => this.store.runs().filter((run) => ACTIVE_RUN_STATUSES.includes(run.status)));

  private readonly recentRuns = computed(() => {
    const since = this.store.now() - RECENT_MS;
    return this.store
      .runs()
      .filter((run) => !ACTIVE_RUN_STATUSES.includes(run.status))
      .filter((run) => Date.parse(run.steps.findLast((step) => step.finishedAt)?.finishedAt ?? run.createdAt) >= since);
  });

  protected readonly activeRooms = computed(() => this.activeRuns().map((run) => this.room(run, true)));
  protected readonly recentRooms = computed(() => this.recentRuns().map((run) => this.room(run, false)));

  protected readonly totals = computed(() => {
    const rooms = this.activeRooms();
    return {
      working: rooms.reduce((sum, room) => sum + room.working, 0),
      waiting: rooms.reduce((sum, room) => sum + room.waiting, 0),
    };
  });

  public constructor() {
    effect(() => writeStorage(FILTER_KEY, this.filter()));
  }

  protected toggle(runId: string): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) {
        next.add(runId);
      }
      return next;
    });
  }

  protected open(agent: AgentNode): void {
    this.store.openRun(agent.runId);
  }

  private room(run: Run, live: boolean): Room {
    // Only the running steps need their events (subagents and the current tool).
    const events: Record<string, AgentEvent[]> = {};
    if (live) {
      for (const step of run.steps.filter((candidate) => candidate.status === "running")) {
        events[step.id] = this.store.events(run.id, step.id)();
      }
    }
    const agents = buildRunAgents(run, plannedSteps(run, this.store.config()), events, this.store.now());
    return {
      run,
      title: run.request.ticketText.split("\n")[0] ?? run.id,
      status: RUN_STATUS[run.status],
      cost: formatCost(run.totalCostUsd),
      agents,
      working: countWorking(agents),
      waiting: agents.filter((agent) => agent.activity === "waiting").length,
    };
  }
}
