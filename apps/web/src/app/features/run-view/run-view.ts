import { Component, computed, effect, inject, input, linkedSignal, resource, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { PrDraft, ReviewReply, ReviewThread } from "@nexura/shared";
import { ACTIVE_RUN_STATUSES, buildRunAgents, plannedSteps, type AgentEvent, type AgentNode } from "../../core/agents";
import { Api, apiError } from "../../core/api";
import { elapsedMs, formatDuration, formatTokens, RUN_STATUS, stepLabel, timeOfDay } from "../../core/format";
import { NexuraStore, readStorage, writeStorage } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { teamColors } from "../../shared/pixel-office/looks";
import type { OfficeTeam } from "../../shared/pixel-office/office-plan";
import { PixelOffice } from "../../shared/pixel-office/pixel-office";
import { StatusPill } from "../../shared/status-pill";
import { StepInspector } from "./step-inspector";
import { StepPipeline } from "./step-pipeline";
import { PrApproval } from "./pr-approval";
import { ReviewApproval } from "./review-approval";
import { TerminalPanel, type TerminalRequest } from "./terminal-panel";

const PIPELINE_MODE_KEY = "nexura.pipelineMode";
const PIPELINE_WIDTH_KEY = "nexura.pipelineWidth";
const PIPELINE_DEFAULT = 400;
const PIPELINE_MIN = 240;
const PIPELINE_MAX = 900;

const clampWidth = (width: number): number => Math.round(Math.min(PIPELINE_MAX, Math.max(PIPELINE_MIN, Number(width) || PIPELINE_DEFAULT)));

type PipelineMode = "steps" | "office";

@Component({
  selector: "nx-run-view",
  imports: [RouterLink, StatusPill, StepPipeline, StepInspector, TerminalPanel, PrApproval, ReviewApproval, PixelOffice, Icon],
  templateUrl: "./run-view.html",
  host: { class: "flex h-full flex-col" },
})
export class RunView {
  private readonly api = inject(Api);
  protected readonly store = inject(NexuraStore);

  /** Route param `:id`. */
  public readonly id = input.required<string>();

  protected readonly run = computed(() => this.store.runs().find((run) => run.id === this.id()));
  protected readonly status = computed(() => {
    const run = this.run();
    return run ? RUN_STATUS[run.status] : undefined;
  });

  /** null = follow the latest step live. */
  protected readonly pinnedStepId = linkedSignal<string, string | null>({ source: this.id, computation: () => null });
  protected readonly selectedStep = computed(() => {
    const steps = this.run()?.steps ?? [];
    const pinned = this.pinnedStepId();
    return (pinned ? steps.find((step) => step.id === pinned) : undefined) ?? steps.at(-1);
  });

  protected readonly planned = computed(() => {
    const run = this.run();
    return run ? plannedSteps(run, this.store.config()) : [];
  });

  // ---- pipeline as a list of steps or as the pixel-art office
  protected readonly pipelineMode = signal<PipelineMode>(readStorage<PipelineMode>(PIPELINE_MODE_KEY, "steps"));
  /** Width of the steps / office panel, dragged from its right edge. */
  protected readonly pipelineWidth = signal(clampWidth(readStorage<number>(PIPELINE_WIDTH_KEY, PIPELINE_DEFAULT)));
  protected readonly resizing = signal(false);
  protected readonly pipelineMin = PIPELINE_MIN;
  protected readonly pipelineMax = PIPELINE_MAX;
  protected readonly pipelineDefault = PIPELINE_DEFAULT;
  protected readonly officeTeams = computed<OfficeTeam[]>(() => {
    const run = this.run();
    if (!run || this.pipelineMode() !== "office") {
      return [];
    }
    const events: Record<string, AgentEvent[]> = {};
    for (const step of run.steps.filter((candidate) => candidate.status === "running")) {
      events[step.id] = this.store.events(run.id, step.id)();
    }
    return [
      {
        id: run.id,
        title: run.request.ticketText.split("\n")[0] ?? run.id,
        color: teamColors([run.id]).get(run.id)!,
        live: ACTIVE_RUN_STATUSES.includes(run.status),
        agents: buildRunAgents(run, this.planned(), events, this.store.now()),
      },
    ];
  });

  protected readonly summary = computed(() => {
    const run = this.run();
    if (!run) {
      return undefined;
    }
    const tokens = run.steps.reduce(
      (sum, step) => sum + (step.usage ? step.usage.inputTokens + step.usage.outputTokens + step.usage.cacheReadTokens + step.usage.cacheCreationTokens : 0),
      0,
    );
    const lastFinish = run.steps.findLast((step) => step.finishedAt)?.finishedAt;
    const live = RUN_STATUS[run.status].live;
    return {
      title: run.request.ticketText.split("\n")[0] ?? "",
      tokens: formatTokens(tokens),
      turns: run.steps.reduce((sum, step) => sum + step.numTurns, 0),
      duration: formatDuration(elapsedMs(run.createdAt, live ? undefined : (lastFinish ?? run.createdAt), this.store.now())),
      failedStep: run.steps.findLast((step) => step.status === "failed"),
    };
  });

  protected readonly tasks = computed(() => (this.run()?.request.tasks ?? []).filter((task) => task.selected));
  protected readonly isActive = computed(() => ["queued", "running", "paused", "waiting-rate-limit"].includes(this.run()?.status ?? ""));
  protected readonly isFinal = computed(() => ["done", "failed", "cancelled"].includes(this.run()?.status ?? ""));

  protected readonly ledger = resource({
    params: () => {
      const run = this.run();
      return run ? { id: run.id, version: `${run.steps.length}:${run.status}` } : undefined;
    },
    loader: ({ params }) => this.api.getLedger(params.id),
  });

  // ---- breakpoint editing
  protected readonly pendingPrompt = linkedSignal(() => this.run()?.pendingStep?.prompt ?? "");
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly stepLabel = stepLabel;
  protected readonly timeOfDay = timeOfDay;

  // ---- embedded terminal
  protected readonly terminal = linkedSignal<string, TerminalRequest | null>({ source: this.id, computation: () => null });
  protected readonly terminalMaximized = signal(false);
  private terminalKey = 0;

  public constructor() {
    effect(() => this.store.openTab(this.id()));
    effect(() => writeStorage(PIPELINE_MODE_KEY, this.pipelineMode()));
    effect(() => writeStorage(PIPELINE_WIDTH_KEY, this.pipelineWidth()));
  }

  protected setPipelineWidth(width: number): void {
    this.pipelineWidth.set(clampWidth(width));
  }

  protected startResize(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = this.pipelineWidth();
    handle.setPointerCapture(event.pointerId);
    this.resizing.set(true);
    const move = (moveEvent: PointerEvent): void => this.setPipelineWidth(startWidth + moveEvent.clientX - startX);
    const end = (): void => {
      this.resizing.set(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    event.preventDefault();
  }

  protected selectAgent(agent: AgentNode): void {
    if (agent.stepRunId) {
      this.selectStep(agent.stepRunId);
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected openShell(): void {
    this.terminal.set({ key: ++this.terminalKey, runId: this.id(), mode: "shell", title: "Terminal en el worktree" });
  }

  protected openSession(stepRunId: string): void {
    const step = this.run()?.steps.find((candidate) => candidate.id === stepRunId);
    const label = step ? `${stepLabel(step.step)} #${step.attempt}` : "paso";
    this.terminal.set({ key: ++this.terminalKey, runId: this.id(), mode: "resume", stepRunId, title: `claude --resume · ${label}` });
  }

  protected selectStep(id: string): void {
    const last = this.run()?.steps.at(-1)?.id;
    this.pinnedStepId.set(id === last ? null : id);
  }

  protected continueRun(skip = false): Promise<void> {
    const run = this.run()!;
    const edited = this.pendingPrompt();
    const changed = run.pendingStep?.prompt !== undefined && edited !== run.pendingStep.prompt;
    return this.act(() => this.api.continue(run.id, skip ? { skip: true } : changed ? { prompt: edited } : undefined));
  }

  protected approvePrs(prDrafts: PrDraft[]): Promise<void> {
    return this.act(() => this.api.continue(this.id(), { prDrafts }));
  }

  // ---- classify feedback
  protected readonly profileNames = computed(() => (this.store.config()?.profiles ?? []).map((profile) => profile.name));
  protected readonly correcting = signal(false);

  protected rateClassify(correct: boolean, expected?: string): Promise<void> {
    this.correcting.set(false);
    return this.act(() => this.api.rateClassify(this.id(), correct, expected));
  }

  protected readonly qaNotes = computed(() => {
    const step = this.run()?.steps.findLast((candidate) => candidate.step === "qaNotes" && candidate.status === "succeeded");
    return step?.structuredOutput as { summary: string; cases: { title: string; steps: string[]; expected: string }[]; risks: string[] } | undefined;
  });

  protected approveReplies(replies: ReviewReply[]): Promise<void> {
    return this.act(() => this.api.continue(this.id(), { replies }));
  }

  // ---- PR review threads (checking is free; addressing runs Claude)
  protected readonly threads = linkedSignal<string, ReviewThread[] | null>({ source: this.id, computation: () => null });
  protected readonly checkingThreads = signal(false);

  protected async checkThreads(): Promise<void> {
    this.checkingThreads.set(true);
    this.actionError.set(null);
    try {
      this.threads.set(await this.api.reviewThreads(this.id()));
    } catch (error: unknown) {
      this.actionError.set(apiError(error, "No se pudieron leer los comentarios de la PR"));
    } finally {
      this.checkingThreads.set(false);
    }
  }

  protected addressReview(): Promise<void> {
    return this.act(async () => {
      await this.api.addressReview(this.id());
      this.threads.set(null);
    });
  }

  protected keepLocal(): Promise<void> {
    return this.act(() => this.api.continue(this.id(), { skip: true }));
  }

  /** Closes a <details> menu once focus moves outside it (click elsewhere or Tab away). */
  protected closeWhenFocusLeaves(event: FocusEvent, menu: HTMLDetailsElement): void {
    if (!menu.contains(event.relatedTarget as Node | null)) {
      menu.open = false;
    }
  }

  protected cancel(): Promise<void> {
    return this.act(() => this.api.cancel(this.id()));
  }

  protected deleteRun(): Promise<void> {
    if (!confirm("¿Borrar este flujo?\n\nSe borran su historial, sus logs y sus worktrees. Las ramas con commits se conservan; las vacías se borran.")) {
      return Promise.resolve();
    }
    return this.act(() => this.store.deleteRun(this.id()));
  }

  protected cleanup(deleteBranches: boolean): Promise<void> {
    const message = deleteBranches
      ? "¿Borrar los worktrees Y las ramas de este flujo, aunque tengan commits?\n\nLos commits que no estén subidos se pierden. No se puede deshacer."
      : "¿Borrar los worktrees de este flujo? Las ramas con commits se conservan; las vacías se borran.";
    if (!confirm(message)) {
      return Promise.resolve();
    }
    return this.act(() => this.api.cleanup(this.id(), deleteBranches));
  }

  private async act(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await action();
      const run = await this.api.getRun(this.id());
      this.store.upsertRun(run);
    } catch (error: unknown) {
      this.actionError.set(apiError(error, "La acción falló"));
    } finally {
      this.busy.set(false);
    }
  }
}
