import { Component, computed, effect, inject, linkedSignal, output, resource, signal } from "@angular/core";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MODELS,
  DEFAULT_AI_SETUP_AGENT,
  modelsFor,
  type AgentKind,
  type AiSetupAgent,
  type AiSetupMode,
  type AiSetupSession,
} from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { readStorage, writeStorage } from "../../core/storage";
import { NexuraStore } from "../../core/nexura-store";
import { Icon, type IconName } from "../../shared/icon";
import { ModelPicker } from "../../shared/model-picker";
import { EFFORTS } from "../run-view/step-inspector";

const AGENT_KEY = "nexura.aiSetupAgent";
const REPO_KEY = "nexura.aiSetupRepo";

type ModeCard = { mode: AiSetupMode; icon: IconName; title: string; hint: string; label: string; placeholder: string };

const MODES: ModeCard[] = [
  {
    mode: "assess",
    icon: "search",
    title: "Valorar el proyecto",
    hint: "Qué tiene, qué falla y qué plugins, skills, agentes, hooks o MCP merece la pena añadir.",
    label: "¿Algo en concreto? (opcional)",
    placeholder: "Por ejemplo: «sobre todo hooks», «¿qué nos falta para Codex?». Déjalo vacío para una valoración completa.",
  },
  {
    mode: "create",
    icon: "wand",
    title: "Crear algo",
    hint: "Una skill, un agente, un hook, un servidor MCP o las instrucciones del repo, escritos como en el ai-toolkit.",
    label: "¿Qué quieres crear?",
    placeholder: "Qué tiene que hacer, cuándo se usa y qué no debe hacer nunca. El asistente decide si es una skill, un agente o un hook, y te lo dice.",
  },
];

const EXAMPLES = [
  "Una skill que genere un componente nuevo con la estructura del repo",
  "Un agente de solo lectura que revise la accesibilidad de los cambios",
  "Un hook que impida editar el lockfile y los ficheros .env",
  "Completar el CLAUDE.md con los comandos de build y test",
];

/** The first screen of a session: the repo, assess or create, and the person's words. */
@Component({
  selector: "nx-ai-setup-start",
  imports: [Icon, ModelPicker],
  template: `
    <form class="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8" (submit)="$event.preventDefault(); start()">
      <header>
        <h2 class="text-xl font-semibold">Setup IA</h2>
        <p class="mt-1 text-fg-soft">
          Prepara un proyecto para trabajar con agentes, a la manera del ai-toolkit: valora lo que tiene o crea la pieza que necesitas.
          El asistente solo lee el repo; nada se escribe hasta que tú lo confirmes.
        </p>
      </header>

      <div class="flex flex-col gap-1.5">
        <label class="nx-label" for="setup-repo">Proyecto</label>
        <div class="flex items-center gap-2">
          <select id="setup-repo" class="nx-input min-w-0 flex-1" (change)="repo.set($any($event.target).value)">
            @for (option of repos(); track option.name) {
              <option [value]="option.name" [selected]="option.name === repo()">{{ option.name }}{{ option.toolkit ? " · marketplace de plugins" : "" }}</option>
            }
          </select>
        </div>
        @if (!repos().length) {
          <p class="nx-hint">No hay repos. Añádelos en Configuración → Repos.</p>
        } @else if (isToolkit()) {
          <p class="nx-hint">Es un marketplace de plugins como el ai-toolkit: lo que crees irá a un plugin, con su versión, su CHANGELOG y su eval.</p>
        }
      </div>

      <fieldset class="flex flex-col gap-1.5">
        <legend class="nx-label mb-1.5">¿Qué quieres hacer?</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          @for (card of modes; track card.mode) {
            <button
              type="button"
              class="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors"
              [class]="mode() === card.mode ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'"
              [attr.aria-pressed]="mode() === card.mode"
              (click)="mode.set(card.mode)"
            >
              <nx-icon [name]="card.icon" [size]="22" class="mt-0.5 shrink-0 text-accent" />
              <span>
                <span class="block font-semibold">{{ card.title }}</span>
                <span class="block text-sm text-fg-soft">{{ card.hint }}</span>
              </span>
            </button>
          }
        </div>
      </fieldset>

      @if (card(); as current) {
        <div class="flex flex-col gap-1.5">
          <label class="nx-label" for="setup-idea">{{ current.label }}</label>
          <textarea
            id="setup-idea"
            class="nx-input min-h-32"
            rows="5"
            [placeholder]="current.placeholder"
            [value]="idea()"
            (input)="idea.set($any($event.target).value)"
            (keydown.control.enter)="start()"
          ></textarea>
          @if (current.mode === "create" && !idea().trim()) {
            <div class="flex flex-wrap gap-1.5">
              @for (example of examples; track example) {
                <button type="button" class="rounded-full border border-border px-2.5 py-1 text-sm hover:bg-surface-3" (click)="idea.set(example)">{{ example }}</button>
              }
            </div>
          }
        </div>
      }

      <details class="group rounded-md border border-border px-3 py-2">
        <summary class="cursor-pointer text-sm text-fg-soft select-none">Avanzado: qué asistente usar</summary>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <select class="nx-input" aria-label="Agente" (change)="setAgent($any($event.target).value)">
            @for (option of agentKinds; track option) {
              <option [value]="option" [selected]="option === assistant().agent">{{ agentLabels[option] }}</option>
            }
          </select>
          <nx-model-picker [models]="models()" [value]="assistant().model" label="Modelo del asistente" (valueChange)="patch({ model: $event })" />
          <select class="nx-input" aria-label="Esfuerzo" (change)="patch({ effort: $any($event.target).value })">
            @for (option of efforts; track option) {
              <option [value]="option" [selected]="option === assistant().effort">{{ option }}</option>
            }
          </select>
        </div>
      </details>

      @if (error(); as message) {
        <p class="rounded-md border border-err/40 bg-err-soft px-3 py-2 text-err" role="alert">{{ message }}</p>
      }

      <div class="flex items-center justify-end gap-3">
        <span class="nx-hint">Ctrl+Enter</span>
        <button type="submit" class="nx-btn nx-btn-primary nx-btn-lg" [disabled]="!canStart() || starting()">
          {{ starting() ? "Empezando…" : mode() === "assess" ? "Valorar" : "Empezar" }}
        </button>
      </div>
    </form>
  `,
})
export class AiSetupStart {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly started = output<AiSetupSession>();

  protected readonly modes = MODES;
  protected readonly examples = EXAMPLES;
  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly efforts = EFFORTS;

  private readonly repoKinds = resource({
    params: () => (this.store.config()?.repos ?? []).map((repo) => repo.name).join("\n"),
    loader: () => this.api.aiSetupRepos(),
  });
  protected readonly repos = computed(() =>
    this.repoKinds.hasValue() ? this.repoKinds.value() : (this.store.config()?.repos ?? []).map((repo) => ({ name: repo.name, toolkit: false })),
  );
  /** The last repo used, while it still exists; else the first one. */
  protected readonly repo = linkedSignal(() => {
    const names = this.repos().map((repo) => repo.name);
    const last = readStorage<string>(REPO_KEY, "");
    return names.includes(last) ? last : (names[0] ?? "");
  });
  protected readonly isToolkit = computed(() => this.repos().find((repo) => repo.name === this.repo())?.toolkit ?? false);

  protected readonly mode = signal<AiSetupMode | null>(null);
  protected readonly card = computed(() => MODES.find((card) => card.mode === this.mode()));
  protected readonly idea = signal("");

  protected readonly assistant = signal<AiSetupAgent>(readStorage<AiSetupAgent>(AGENT_KEY, DEFAULT_AI_SETUP_AGENT));
  private readonly agentInfo = resource({ loader: () => this.api.getAgents() });
  protected readonly models = computed(() => modelsFor(this.assistant().agent, this.agentInfo.hasValue() ? this.agentInfo.value() : undefined));

  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canStart = computed(() => Boolean(this.repo() && this.mode() && (this.mode() === "assess" || this.idea().trim())));

  public constructor() {
    effect(() => writeStorage(AGENT_KEY, this.assistant()));
  }

  protected setAgent(agent: AgentKind): void {
    this.assistant.update((current) => ({ ...current, agent, model: AGENT_MODELS[agent][0]! }));
  }

  protected patch(change: Partial<AiSetupAgent>): void {
    this.assistant.update((current) => ({ ...current, ...change }));
  }

  protected async start(): Promise<void> {
    const mode = this.mode();
    if (!this.canStart() || !mode || this.starting()) {
      return;
    }
    this.starting.set(true);
    this.error.set(null);
    try {
      const session = await this.api.startAiSetup({ repo: this.repo(), mode, idea: this.idea().trim(), agent: this.assistant() });
      writeStorage(REPO_KEY, this.repo());
      this.store.upsertAiSetup(session);
      this.idea.set("");
      this.mode.set(null);
      this.started.emit(session);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo empezar"));
    } finally {
      this.starting.set(false);
    }
  }
}
