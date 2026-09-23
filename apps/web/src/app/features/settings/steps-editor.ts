import { Component, computed, inject, input, linkedSignal, signal } from "@angular/core";
import { Api, apiError, type StepDefinitionView } from "../../core/api";
import { STEP_LABELS } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

const MS_PER_MINUTE = 60_000;

/** Placeholders the orchestrator fills in (see apps/server/src/orchestrator/orchestrator.ts renderPrompt). */
export const TEMPLATE_VARIABLES: { name: string; help: string }[] = [
  { name: "ticket", help: "ID + texto del ticket" },
  { name: "tasks", help: "tareas seleccionadas como checklist" },
  { name: "repos", help: "worktrees, ramas y baseRef" },
  { name: "userPrompt", help: "prompt adicional del flujo" },
  { name: "ledger", help: "libro de tareas hasta ahora" },
  { name: "feedback", help: "correcciones de review/QA en las vueltas" },
  { name: "repoMap", help: "mapa del repo desde git (gratis, cacheado por commit)" },
  { name: "repoNotes", help: "convenciones aprendidas en tickets anteriores" },
  { name: "threads", help: "hilos activos de la PR (solo addressReview)" },
  { name: "output.enrich", help: "salida JSON de enrich" },
  { name: "output.plan", help: "salida JSON de plan" },
];

type Draft = {
  template: string;
  tools: string;
  allowedTools: string;
  disallowedTools: string;
  timeoutMinutes: number;
  useMcp: boolean;
};

function toDraft(step: StepDefinitionView | undefined): Draft {
  return {
    template: step?.promptTemplate ?? "",
    tools: (step?.tools ?? []).join(", "),
    allowedTools: (step?.allowedTools ?? []).join("\n"),
    disallowedTools: (step?.disallowedTools ?? []).join("\n"),
    timeoutMinutes: (step?.timeoutMs ?? 0) / MS_PER_MINUTE,
    useMcp: step?.useMcp ?? false,
  };
}

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

@Component({
  selector: "nx-steps-editor",
  templateUrl: "./steps-editor.html",
  host: { class: "grid min-h-0 grid-cols-[220px_minmax(0,1fr)] gap-6" },
})
export class StepsEditor {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  /** Step to open first (from `?step=`). */
  public readonly initialStep = input<string | undefined>();

  protected readonly variables = TEMPLATE_VARIABLES;
  protected readonly labels = STEP_LABELS;
  protected readonly steps = computed(() => this.store.config()?.steps ?? []);
  protected readonly selected = linkedSignal(() => this.initialStep() ?? this.steps()[0]?.name ?? "");
  protected readonly step = computed(() => this.steps().find((step) => step.name === this.selected()));
  protected readonly draft = linkedSignal<Draft>(() => toDraft(this.step()));
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(toDraft(this.step())));
  protected readonly schema = computed(() => (this.step()?.schema ? JSON.stringify(this.step()!.schema, null, 2) : ""));
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly busy = signal(false);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected select(name: string): void {
    if (this.dirty() && !confirm("Hay cambios sin guardar en este paso. ¿Descartarlos?")) {
      return;
    }
    this.message.set(null);
    this.selected.set(name);
  }

  protected patch(changes: Partial<Draft>): void {
    this.draft.update((draft) => ({ ...draft, ...changes }));
  }

  protected discard(): void {
    this.draft.set(toDraft(this.step()));
    this.message.set(null);
  }

  protected async save(): Promise<void> {
    const step = this.step();
    if (!step) {
      return;
    }
    const draft = this.draft();
    this.busy.set(true);
    this.message.set(null);
    try {
      if (step.kind === "claude") {
        await this.api.saveStepPrompt(step.name, draft.template);
      }
      await this.api.saveStepDefinition(step.name, {
        tools: lines(draft.tools),
        allowedTools: lines(draft.allowedTools),
        disallowedTools: lines(draft.disallowedTools),
        useMcp: draft.useMcp,
        timeoutMs: Math.round(draft.timeoutMinutes * MS_PER_MINUTE),
      });
      await this.store.reloadConfig();
      this.message.set({ ok: true, text: `Guardado en config/steps/${step.name}/. Se aplica a los próximos pasos que se ejecuten.` });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar") });
    } finally {
      this.busy.set(false);
    }
  }
}
