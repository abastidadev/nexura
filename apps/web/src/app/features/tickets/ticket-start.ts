import { Component, computed, effect, inject, linkedSignal, output, resource, signal } from "@angular/core";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AGENT_MODELS,
  DEFAULT_TICKET_ASSISTANT,
  modelsFor,
  type AgentKind,
  type TicketAssistantAgent,
  type TicketDraft,
  type TicketKind,
} from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";
import { readStorage, writeStorage } from "../../core/storage";
import { Icon, type IconName } from "../../shared/icon";
import { ModelPicker } from "../../shared/model-picker";
import { SOURCE_LABELS } from "../new-run/ticket-picker";
import { EFFORTS } from "../run-view/step-inspector";

const ASSISTANT_KEY = "nexura.ticketAssistant";
const REPO_KEY = "nexura.ticketRepo";

type KindCard = { kind: TicketKind; icon: IconName; title: string; hint: string; placeholder: string };

const KINDS: KindCard[] = [
  {
    kind: "bug",
    icon: "alert",
    title: "Algo no funciona",
    hint: "Un error: algo falla o no hace lo que debería.",
    placeholder: "Qué estabas haciendo, qué ha pasado y qué esperabas que pasara. Si lo sabes: con qué usuario y en qué pantalla.",
  },
  {
    kind: "story",
    icon: "spark",
    title: "Algo nuevo o un cambio",
    hint: "Una funcionalidad nueva o cambiar cómo funciona algo.",
    placeholder: "Qué necesitas, para quién y para qué. Cuéntalo como se lo contarías a un compañero.",
  },
];

/** The first screen of a ticket: where it goes, what kind it is and the person's own words. */
@Component({
  selector: "nx-ticket-start",
  imports: [Icon, ModelPicker],
  template: `
    <form class="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8" (submit)="$event.preventDefault(); start()">
      <header>
        <h2 class="text-xl font-semibold">Nuevo ticket</h2>
        <p class="mt-1 text-fg-soft">
          Cuéntalo con tus palabras. El asistente mira la aplicación, te hace unas preguntas y escribe el ticket con el formato del equipo.
          Nada se crea hasta que tú lo confirmes.
        </p>
      </header>

      <div class="flex flex-col gap-1.5">
        <label class="nx-label" for="ticket-repo">Proyecto</label>
        <div class="flex items-center gap-2">
          <select id="ticket-repo" class="nx-input min-w-0 flex-1" (change)="repo.set($any($event.target).value)">
            @for (option of repos(); track option.name) {
              <option [value]="option.name" [selected]="option.name === repo()">{{ option.name }}</option>
            }
          </select>
          @if (provider.hasValue()) {
            @let source = provider.value();
            <span class="shrink-0 rounded-full bg-surface-3 px-2.5 py-1 text-xs text-fg-soft">
              {{ source ? "Se creará en " + sourceLabels[source] : "Este repo no está en GitHub ni en Azure DevOps" }}
            </span>
          }
        </div>
        @if (!repos().length) {
          <p class="nx-hint">No hay repos. Añádelos en Configuración → Repos.</p>
        }
      </div>

      <fieldset class="flex flex-col gap-1.5">
        <legend class="nx-label mb-1.5">¿Qué quieres contar?</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          @for (card of kinds; track card.kind) {
            <button
              type="button"
              class="flex items-start gap-3 rounded-lg border p-4 text-left transition-colors"
              [class]="kind() === card.kind ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'"
              [attr.aria-pressed]="kind() === card.kind"
              (click)="kind.set(card.kind)"
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

      <div class="flex flex-col gap-1.5">
        <label class="nx-label" for="ticket-idea">Cuéntalo con tus palabras</label>
        <textarea
          id="ticket-idea"
          class="nx-input min-h-40"
          rows="7"
          [placeholder]="card()?.placeholder ?? 'Elige primero qué quieres contar.'"
          [value]="idea()"
          (input)="idea.set($any($event.target).value)"
          (keydown.control.enter)="start()"
        ></textarea>
      </div>

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
          {{ starting() ? "Empezando…" : "Empezar" }}
        </button>
      </div>
    </form>
  `,
})
export class TicketStart {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly started = output<TicketDraft>();

  protected readonly kinds = KINDS;
  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly efforts = EFFORTS;
  protected readonly sourceLabels = SOURCE_LABELS;

  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  /** The last repo used, while it still exists; else the first one. */
  protected readonly repo = linkedSignal(() => {
    const names = this.repos().map((repo) => repo.name);
    const last = readStorage<string>(REPO_KEY, "");
    return names.includes(last) ? last : (names[0] ?? "");
  });
  protected readonly provider = resource({
    params: () => this.repo() || undefined,
    loader: ({ params }) => this.api.repoProvider(params),
  });

  protected readonly kind = signal<TicketKind | null>(null);
  protected readonly card = computed(() => KINDS.find((card) => card.kind === this.kind()));
  protected readonly idea = signal("");

  protected readonly assistant = signal<TicketAssistantAgent>(readStorage<TicketAssistantAgent>(ASSISTANT_KEY, DEFAULT_TICKET_ASSISTANT));
  private readonly agentInfo = resource({ loader: () => this.api.getAgents() });
  protected readonly models = computed(() => modelsFor(this.assistant().agent, this.agentInfo.hasValue() ? this.agentInfo.value() : undefined));

  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canStart = computed(
    () => Boolean(this.repo() && this.kind() && this.idea().trim()) && !(this.provider.hasValue() && this.provider.value() === null),
  );

  public constructor() {
    effect(() => writeStorage(ASSISTANT_KEY, this.assistant()));
  }

  protected setAgent(agent: AgentKind): void {
    this.assistant.update((current) => ({ ...current, agent, model: AGENT_MODELS[agent][0]! }));
  }

  protected patch(change: Partial<TicketAssistantAgent>): void {
    this.assistant.update((current) => ({ ...current, ...change }));
  }

  protected async start(): Promise<void> {
    const kind = this.kind();
    if (!this.canStart() || !kind || this.starting()) {
      return;
    }
    this.starting.set(true);
    this.error.set(null);
    try {
      const draft = await this.api.startTicketDraft({ repo: this.repo(), kind, idea: this.idea().trim(), agent: this.assistant() });
      writeStorage(REPO_KEY, this.repo());
      this.store.upsertTicketDraft(draft);
      this.idea.set("");
      this.kind.set(null);
      this.started.emit(draft);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo empezar el ticket"));
    } finally {
      this.starting.set(false);
    }
  }
}
