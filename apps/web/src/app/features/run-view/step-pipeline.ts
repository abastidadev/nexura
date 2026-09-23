import { Component, computed, input, output } from "@angular/core";
import type { StepName, StepRun } from "@nexura/shared";
import { elapsedMs, formatCost, formatDuration, STEP_LABELS, stepDisplayStatus, TONE_CLASSES } from "../../core/format";

type PipelineItem =
  | {
      type: "run";
      id: string;
      label: string;
      attempt: number;
      loop: boolean;
      status: ReturnType<typeof stepDisplayStatus>;
      tone: (typeof TONE_CLASSES)[keyof typeof TONE_CLASSES];
      detail: string;
      cost: string;
      duration: string;
      turns: number;
      error?: string;
    }
  | { type: "planned"; id: string; label: string; detail: string };

/** Vertical list of executed steps (with loops/retries) followed by the planned ones. */
@Component({
  selector: "nx-step-pipeline",
  template: `
    <ol class="flex flex-col" aria-label="Pasos del flujo">
      @for (item of items(); track item.id; let last = $last) {
        <li class="relative pl-7">
          @if (!last) {
            <span class="absolute top-6 bottom-0 left-[13px] w-px bg-border" aria-hidden="true"></span>
          }
          @if (item.type === "run") {
            <span
              class="absolute top-2 left-1.5 grid size-4 place-items-center rounded-full text-[10px] font-bold"
              [class]="item.tone.bg + ' ' + item.tone.text"
              [class.nx-pulse]="item.status.label === 'Ejecutando'"
              aria-hidden="true"
              >{{ item.status.icon }}</span
            >
            <button
              type="button"
              class="mb-1 w-full rounded-md px-2 py-1.5 text-left"
              [class]="selectedId() === item.id ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface-2'"
              [attr.aria-current]="selectedId() === item.id ? 'step' : null"
              (click)="select.emit(item.id)"
            >
              <span class="flex items-center gap-1.5">
                <span class="font-medium">{{ item.label }}</span>
                @if (item.attempt > 1) {
                  <span class="rounded bg-surface-3 px-1 text-[10px] text-muted" [attr.title]="item.loop ? 'Vuelta de review/QA' : 'Reintento'">
                    #{{ item.attempt }}{{ item.loop ? " ↺" : "" }}
                  </span>
                }
                <span class="ml-auto font-mono text-[11px]" [class]="item.tone.text">{{ item.status.label }}</span>
              </span>
              <span class="mt-0.5 flex gap-2 text-[11px] text-muted">
                <span>{{ item.detail }}</span>
                <span class="ml-auto font-mono">{{ item.cost }}</span>
                <span class="font-mono">{{ item.duration }}</span>
              </span>
              @if (item.error) {
                <span class="mt-1 line-clamp-2 block text-[11px] text-err">{{ item.error }}</span>
              }
            </button>
          } @else {
            <span class="absolute top-2 left-1.5 size-4 rounded-full border border-dashed border-border-strong" aria-hidden="true"></span>
            <div class="mb-1 px-2 py-1.5 text-muted">
              <span class="block">{{ item.label }}</span>
              <span class="text-[11px]">{{ item.detail }} · pendiente</span>
            </div>
          }
        </li>
      }
    </ol>
  `,
})
export class StepPipeline {
  public readonly steps = input.required<StepRun[]>();
  /** Steps of the resolved profile, in order (to show the ones not run yet). */
  public readonly planned = input<{ name: StepName; detail: string }[]>([]);
  public readonly selectedId = input<string | undefined>();
  public readonly now = input.required<number>();
  public readonly select = output<string>();

  protected readonly items = computed<PipelineItem[]>(() => {
    const steps = this.steps();
    const seen = new Set<string>();
    const executed: PipelineItem[] = steps.map((step) => {
      const loop = step.step === "implement" || step.step === "codeReview" || step.step === "qaCode";
      const priorSucceeded = seen.has(step.step);
      seen.add(step.step);
      const status = stepDisplayStatus(step);
      return {
        type: "run",
        id: step.id,
        label: STEP_LABELS[step.step] ?? step.step,
        attempt: step.attempt,
        loop: loop && priorSucceeded && steps.some((s) => s.step === step.step && s.status === "succeeded" && s.seq < step.seq),
        status,
        tone: TONE_CLASSES[status.tone],
        detail: step.kind === "builtin" ? "sin LLM" : `${step.model}/${step.effort}`,
        cost: step.kind === "builtin" ? "" : formatCost(step.costUsd),
        duration: step.startedAt ? formatDuration(elapsedMs(step.startedAt, step.finishedAt, this.now())) : "",
        turns: step.numTurns,
        error: step.status === "failed" ? step.error : undefined,
      };
    });
    const pending: PipelineItem[] = this.planned()
      .filter((plan) => !seen.has(plan.name))
      .map((plan) => ({ type: "planned", id: `planned-${plan.name}`, label: STEP_LABELS[plan.name] ?? plan.name, detail: plan.detail }));
    return [...executed, ...pending];
  });
}
