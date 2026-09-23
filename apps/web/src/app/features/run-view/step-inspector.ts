import { Component, computed, inject, input, linkedSignal, output, resource, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { Effort, ModelAlias, Run, StepRun } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import {
  elapsedMs,
  formatCost,
  formatDuration,
  formatTokens,

  STEP_LABELS,
  stepDisplayStatus,
  TONE_CLASSES,
} from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";
import { EventTimeline } from "./event-timeline";

type Tab = "events" | "prompt" | "output" | "raw" | "command";
type DebugMode = "retry" | "resume" | "skip";

export const MODELS: ModelAlias[] = ["haiku", "sonnet", "opus"];
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];

@Component({
  selector: "nx-step-inspector",
  imports: [EventTimeline, RouterLink],
  templateUrl: "./step-inspector.html",
  host: { class: "flex min-h-0 flex-col" },
})
export class StepInspector {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly run = input.required<Run>();
  public readonly step = input.required<StepRun>();
  /** Whether the run still has a worktree to open a terminal in. */
  public readonly hasWorktree = input(false);
  public readonly openSession = output<void>();

  protected readonly tabs: { id: Tab; label: string }[] = [
    { id: "events", label: "Eventos" },
    { id: "prompt", label: "Prompt" },
    { id: "output", label: "Salida JSON" },
    { id: "raw", label: "Log crudo" },
    { id: "command", label: "Comando" },
  ];
  protected readonly debugModes: { id: DebugMode; label: string }[] = [
    { id: "retry", label: "Reintentar" },
    { id: "resume", label: "Continuar sesión" },
    { id: "skip", label: "Saltar" },
  ];
  protected readonly models = MODELS;
  protected readonly efforts = EFFORTS;
  protected readonly tab = signal<Tab>("events");
  protected readonly copied = signal(false);

  protected readonly events = computed(() => this.store.events(this.run().id, this.step().id)());
  protected readonly status = computed(() => stepDisplayStatus(this.step()));
  protected readonly tone = computed(() => TONE_CLASSES[this.status().tone]);
  protected readonly label = computed(() => STEP_LABELS[this.step().step] ?? this.step().step);
  protected readonly metrics = computed(() => {
    const step = this.step();
    const usage = step.usage;
    return {
      cost: formatCost(step.costUsd),
      duration: step.startedAt ? formatDuration(elapsedMs(step.startedAt, step.finishedAt, this.store.now())) : "—",
      tokens: usage
        ? `in ${formatTokens(usage.inputTokens)} · out ${formatTokens(usage.outputTokens)} · cache ${formatTokens(usage.cacheReadTokens + usage.cacheCreationTokens)}`
        : "—",
    };
  });
  protected readonly output = computed(() => {
    const value = this.step().structuredOutput;
    return value === undefined ? "" : JSON.stringify(value, null, 2);
  });
  protected readonly command = computed(() => {
    const args = this.step().args;
    return args ? `claude ${args.map((arg) => (/[\s"{}]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}` : "";
  });

  protected readonly raw = resource({
    params: () => (this.tab() === "raw" ? { runId: this.run().id, stepId: this.step().id, status: this.step().status } : undefined),
    loader: ({ params }) => this.api.getRaw(params.runId, params.stepId),
  });

  // ---- debugging a failed step
  /** Only the last step of a failed/cancelled run can be retried from here. */
  protected readonly canDebug = computed(() => {
    const run = this.run();
    return (run.status === "failed" || run.status === "cancelled") && run.steps.at(-1)?.id === this.step().id;
  });
  protected readonly mode = signal<DebugMode>("retry");
  protected readonly editedPrompt = linkedSignal(() => this.step().prompt ?? "");
  protected readonly model = linkedSignal<ModelAlias>(() => this.step().model);
  protected readonly effort = linkedSignal<Effort>(() => this.step().effort);
  protected readonly instruction = signal("");
  protected readonly busy = signal(false);
  protected readonly debugError = signal<string | null>(null);
  protected readonly isClaude = computed(() => this.step().kind === "claude");

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected async copySession(): Promise<void> {
    const id = this.step().sessionId;
    if (!id) {
      return;
    }
    await navigator.clipboard.writeText(`claude --resume ${id}`);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected async launchDebug(): Promise<void> {
    this.busy.set(true);
    this.debugError.set(null);
    const mode = this.mode();
    const prompt = this.editedPrompt();
    try {
      await this.api.retry(this.run().id, {
        skip: mode === "skip" || undefined,
        resumeSession: mode === "resume" || undefined,
        instruction: mode === "resume" ? this.instruction().trim() || undefined : undefined,
        prompt: mode === "retry" && this.isClaude() && prompt !== this.step().prompt ? prompt : undefined,
        model: mode === "skip" ? undefined : this.model(),
        effort: mode === "skip" ? undefined : this.effort(),
      });
      this.instruction.set("");
    } catch (error: unknown) {
      this.debugError.set(apiError(error, "No se pudo relanzar el paso"));
    } finally {
      this.busy.set(false);
    }
  }
}
