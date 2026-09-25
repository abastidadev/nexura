import { Component, computed, effect, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { Run } from "@nexura/shared";
import { ACTIVE_RUN_STATUSES, buildRunAgents, countWorking, plannedSteps, type AgentEvent, type AgentNode } from "../../core/agents";
import { formatCost, RUN_STATUS } from "../../core/format";
import { NexuraStore, readStorage, writeStorage } from "../../core/nexura-store";
import { teamColors } from "../../shared/pixel-office/looks";
import type { OfficeTeam } from "../../shared/pixel-office/office-plan";
import { PixelOffice } from "../../shared/pixel-office/pixel-office";
import { StatusPill } from "../../shared/status-pill";

const FILTER_KEY = "nexura.agentsFilter";
const RECENT_MS = 24 * 60 * 60 * 1000;
/** Finished flows whose agents still hang around the office. */
const RECENT_MAX = 4;

type Filter = "active" | "all";

type Room = {
  run: Run;
  live: boolean;
  title: string;
  color: string;
  status: (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
  cost: string;
  agents: AgentNode[];
  working: number;
  waiting: number;
};

/** Every agent of every flow in a single pixel-art office. */
@Component({
  selector: "nx-agents",
  imports: [RouterLink, PixelOffice, StatusPill],
  templateUrl: "./agents.html",
  host: { class: "block h-full" },
})
export class AgentsPage {
  protected readonly store = inject(NexuraStore);
  protected readonly filter = signal<Filter>(readStorage<Filter>(FILTER_KEY, "all"));
  /** Flow highlighted from the legend. */
  protected readonly focus = signal<string | null>(null);

  private readonly activeRuns = computed(() => this.store.runs().filter((run) => ACTIVE_RUN_STATUSES.includes(run.status)));

  private readonly recentRuns = computed(() => {
    if (this.filter() !== "all") {
      return [];
    }
    const since = this.store.now() - RECENT_MS;
    return this.store
      .runs()
      .filter((run) => !ACTIVE_RUN_STATUSES.includes(run.status))
      .map((run) => ({ run, at: Date.parse(run.steps.findLast((step) => step.finishedAt)?.finishedAt ?? run.createdAt) }))
      .filter(({ at }) => at >= since)
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_MAX)
      .map(({ run }) => run);
  });

  private readonly colors = computed(() =>
    teamColors(
      [...this.activeRuns(), ...this.recentRuns()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((run) => run.id),
    ),
  );

  protected readonly rooms = computed(() => [...this.activeRuns().map((run) => this.room(run, true)), ...this.recentRuns().map((run) => this.room(run, false))]);

  protected readonly teams = computed<OfficeTeam[]>(() =>
    this.rooms().map((room) => ({ id: room.run.id, title: room.title, color: room.color, live: room.live, agents: room.agents })),
  );

  protected readonly totals = computed(() => {
    const rooms = this.rooms().filter((room) => room.live);
    return {
      flows: rooms.length,
      working: rooms.reduce((sum, room) => sum + room.working, 0),
      waiting: rooms.reduce((sum, room) => sum + room.waiting, 0),
    };
  });

  public constructor() {
    effect(() => writeStorage(FILTER_KEY, this.filter()));
  }

  protected open(agent: AgentNode): void {
    this.store.openRun(agent.runId);
  }

  protected openTeam(runId: string): void {
    this.store.openRun(runId);
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
    const title = run.request.ticketText.split("\n")[0] ?? run.id;
    return {
      run,
      live,
      title: run.request.ticketId ? `#${run.request.ticketId} · ${title}` : title,
      color: this.colors().get(run.id) ?? "#888888",
      status: RUN_STATUS[run.status],
      cost: formatCost(run.totalCostUsd),
      agents,
      working: countWorking(agents),
      waiting: agents.filter((agent) => agent.activity === "waiting").length,
    };
  }
}
