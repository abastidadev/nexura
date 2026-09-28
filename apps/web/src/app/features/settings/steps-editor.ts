import { Component, computed, inject, input, linkedSignal, resource, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { AUTO_MCP_SERVERS, orderSteps, type MemoryMode } from "@nexura/shared";
import { Api, apiError, type StepDefinitionView } from "../../core/api";
import { sourceLabel, stepLabel } from "../../core/format";
import { NexuraStore } from "../../core/nexura-store";

const MS_PER_MINUTE = 60_000;

/** Placeholders the orchestrator fills in (see apps/server/src/orchestrator/orchestrator.ts renderPrompt). */
export const TEMPLATE_VARIABLES: { name: string; help: string }[] = [
  { name: "ticket", help: "ID + texto del ticket" },
  { name: "tasks", help: "tareas seleccionadas como checklist" },
  { name: "repos", help: "worktrees, ramas y baseRef" },
  { name: "userPrompt", help: "prompt adicional del flujo" },
  { name: "profiles", help: "perfiles guardados con su descripción (lo usa classify)" },
  { name: "ledger", help: "libro de tareas hasta ahora" },
  { name: "feedback", help: "correcciones de review/QA en las vueltas" },
  { name: "repoMap", help: "mapa del repo desde git (gratis, cacheado por commit)" },
  { name: "repoNotes", help: "convenciones aprendidas en tickets anteriores" },
  { name: "memory", help: "memoria compartida del ticket y del repo; vacía si el paso no tiene memoria" },
  { name: "threads", help: "hilos activos de la PR (solo addressReview y prReview)" },
  { name: "pr", help: "la PR revisada: número, autor, ramas y commit (solo prReview)" },
  { name: "changedFiles", help: "ficheros que cambia la PR, con git diff --name-status (solo prReview)" },
  { name: "baseRef", help: "rama destino de la PR, para git diff <baseRef>...HEAD (solo prReview)" },
  { name: "output.enrich", help: "salida JSON de enrich" },
  { name: "output.plan", help: "salida JSON de plan" },
];

type Draft = {
  template: string;
  tools: string;
  allowedTools: string;
  disallowedTools: string;
  timeoutMinutes: number;
  mcpServers: string;
  memory: MemoryMode;
  /** Custom steps only. */
  label: string;
  description: string;
  after: string;
};

function toDraft(step: StepDefinitionView | undefined): Draft {
  return {
    template: step?.promptTemplate ?? "",
    tools: (step?.tools ?? []).join(", "),
    allowedTools: (step?.allowedTools ?? []).join("\n"),
    disallowedTools: (step?.disallowedTools ?? []).join("\n"),
    timeoutMinutes: (step?.timeoutMs ?? 0) / MS_PER_MINUTE,
    mcpServers: (step?.mcpServers ?? []).join(", "),
    memory: step?.memory ?? "off",
    label: step?.label ?? "",
    description: step?.description ?? "",
    after: step?.after ?? "",
  };
}

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Edit screen of one step (`?tab=steps&step=<name>`). */
@Component({
  selector: "nx-steps-editor",
  imports: [RouterLink],
  templateUrl: "./steps-editor.html",
  host: { class: "flex flex-col gap-4" },
})
export class StepsEditor {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);
  private readonly router = inject(Router);

  /** Step being edited (from `?step=`). */
  public readonly name = input.required<string>();

  protected readonly variables = TEMPLATE_VARIABLES;
  protected readonly memoryModes: { value: MemoryMode; label: string }[] = [
    { value: "off", label: "Sin memoria" },
    { value: "read", label: "Leer (recibe {{memory}} y puede buscar)" },
    { value: "readwrite", label: "Leer y guardar (mem_save)" },
  ];
  protected readonly stepLabel = stepLabel;
  protected readonly autoServers = AUTO_MCP_SERVERS.join(", ");
  protected readonly steps = computed(() => this.store.config()?.steps ?? []);
  protected readonly step = computed(() => this.steps().find((step) => step.name === this.name()));
  protected readonly notFound = computed(() => this.store.config() !== null && !this.step());
  /** Where a custom step can go: any pipeline step except itself. */
  protected readonly anchors = computed(() =>
    orderSteps(this.steps())
      .filter((step) => step.name !== this.name() && !["classify", "addressReview", "prReview"].includes(step.name))
      .map((step) => ({ name: step.name, label: stepLabel(step.name) })),
  );
  protected readonly draft = linkedSignal<Draft>(() => toDraft(this.step()));
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(toDraft(this.step())));
  protected readonly schema = computed(() => (this.step()?.schema ? JSON.stringify(this.step()!.schema, null, 2) : ""));
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly busy = signal(false);

  /** Claude tools that open the repo's own skills and subagents to the step. */
  protected readonly claudeExtras = [
    { tool: "Skill", label: "Skills del repo" },
    { tool: "Agent", label: "Subagentes" },
  ];
  /** MCP servers found in the Claude config of the configured repos (a step's names are resolved per run, against its repo). */
  private readonly inventories = resource({
    params: () => (this.store.config()?.repos ?? []).map((repo) => repo.name),
    loader: ({ params }) => Promise.all(params.map((repo) => this.api.claudeConfig(repo).then((inventory) => ({ repo, inventory })).catch(() => undefined))),
  });
  protected readonly knownMcp = computed(() => {
    const servers = new Map<string, { name: string; where: string[] }>();
    for (const entry of this.inventories.hasValue() ? this.inventories.value() : []) {
      for (const server of entry?.inventory.mcpServers ?? []) {
        const known = servers.get(server.name) ?? { name: server.name, where: [] };
        known.where.push(`${entry!.repo} (${sourceLabel(server.source)}${server.enabled ? "" : ", sin aprobar"})`);
        servers.set(server.name, known);
      }
    }
    return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
  /** Repo servers `@auto` never loads and the step does not name either: they stay off unless added by name. */
  protected readonly skippedByAuto = computed(() => {
    const names = lines(this.draft().mcpServers);
    if (!names.includes("@auto")) {
      return [];
    }
    return this.knownMcp()
      .map((server) => server.name)
      .filter((name) => !AUTO_MCP_SERVERS.includes(name) && !names.includes(name));
  });

  protected hasTool(tool: string): boolean {
    return lines(this.draft().tools).includes(tool);
  }

  protected toggleTool(tool: string): void {
    const tools = lines(this.draft().tools);
    this.patch({ tools: (tools.includes(tool) ? tools.filter((name) => name !== tool) : [...tools, tool]).join(", ") });
  }

  protected hasMcp(name: string): boolean {
    return lines(this.draft().mcpServers).includes(name);
  }

  protected toggleMcp(name: string): void {
    const servers = lines(this.draft().mcpServers);
    this.patch({ mcpServers: (servers.includes(name) ? servers.filter((server) => server !== name) : [...servers, name]).join(", ") });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
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
        mcpServers: lines(draft.mcpServers),
        ...(step.kind === "claude" ? { memory: draft.memory } : {}),
        timeoutMs: Math.round(draft.timeoutMinutes * MS_PER_MINUTE),
        ...(step.custom ? { label: draft.label, description: draft.description, after: draft.after } : {}),
      });
      await this.store.reloadConfig();
      this.message.set({ ok: true, text: `Guardado en config/steps/${step.name}/. Se aplica a los próximos pasos que se ejecuten.` });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo guardar") });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const step = this.step();
    if (!step?.custom || !confirm(`¿Borrar el paso ${step.label ?? step.name}? También se quita de los perfiles que lo usan.`)) {
      return;
    }
    this.busy.set(true);
    try {
      await this.api.deleteStep(step.name);
      await this.store.reloadConfig();
      await this.router.navigate(["/config"], { queryParams: { tab: "steps" } });
    } catch (error: unknown) {
      this.message.set({ ok: false, text: apiError(error, "No se pudo borrar el paso") });
    } finally {
      this.busy.set(false);
    }
  }
}
