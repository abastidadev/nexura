import { Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { AGENT_LABELS, type AgentInfo, type Conversation, type ConversationKind, type RepoConfig } from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore, readStorage, writeStorage } from "../../core/nexura-store";
import { AgentControls, modeCommand, type AgentSettings } from "./agent-controls";

const DEFAULTS_KEY = "nexura.terminal.defaults";
const PLACE_KEY = "nexura.terminal.place";

type Place = { repo?: string; cwd?: string };

/** Creates a terminal conversation: project, agent (or a plain shell), model, effort, mode and an optional first message. */
@Component({
  selector: "nx-new-conversation",
  imports: [AgentControls],
  template: `
    <form class="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8" (submit)="$event.preventDefault(); submit()">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Nueva conversación</h1>
        <p class="mt-1 text-muted">
          Abre Claude Code, Codex o Copilot (o PowerShell) en un proyecto, como en tu terminal, sin salir de Nexura. Sigue viva aunque cambies de
          sección o recargues la página.
        </p>
      </div>

      <section class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="w-20 font-medium">Proyecto</span>
          <select
            class="min-w-56 rounded-md border border-border bg-surface-2 px-2 py-1"
            aria-label="Proyecto"
            (change)="chooseRepo($any($event.target).value)"
          >
            @for (repo of repos(); track repo.name) {
              <option [value]="repo.name" [selected]="place().repo === repo.name">{{ repo.name }}</option>
            }
            @if (place().cwd) {
              <option value="" selected>{{ place().cwd }}</option>
            }
          </select>
          <button type="button" class="rounded-md border border-border px-2.5 py-1 hover:bg-surface-3" (click)="pickFolder()">Otra carpeta…</button>
          <span class="min-w-0 truncate font-mono text-[11px] text-muted" [attr.title]="folder()">{{ folder() }}</span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="w-20 font-medium">Tipo</span>
          <div class="flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Tipo de conversación">
            <button
              type="button"
              role="radio"
              class="px-2.5 py-1"
              [class]="kind() === 'agent' ? 'bg-accent-strong text-white' : 'hover:bg-surface-3'"
              [attr.aria-checked]="kind() === 'agent'"
              (click)="kind.set('agent')"
            >
              Agente
            </button>
            <button
              type="button"
              role="radio"
              class="px-2.5 py-1"
              [class]="kind() === 'shell' ? 'bg-accent-strong text-white' : 'hover:bg-surface-3'"
              [attr.aria-checked]="kind() === 'shell'"
              (click)="kind.set('shell')"
            >
              PowerShell
            </button>
          </div>
        </div>

        @if (kind() === "agent") {
          <div class="flex flex-wrap items-start gap-2">
            <span class="w-20 pt-1 font-medium">Agente</span>
            <nx-agent-controls [settings]="settings()" [agents]="agents()" (settingsChange)="settings.set($event)" />
          </div>
          <p class="ml-22 font-mono text-[11px] text-muted">{{ command() }}</p>
          @if (settings().mode === "bypass") {
            <p class="ml-22 rounded-md border border-err bg-err-soft px-3 py-2 text-[12px] text-err">
              Sin permisos: el agente ejecuta cualquier comando y edita cualquier fichero sin preguntarte.
            </p>
          }
        }

        <label class="flex flex-wrap items-center gap-2">
          <span class="w-20 font-medium">Título</span>
          <input
            class="min-w-64 flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1 outline-none focus:border-accent"
            [placeholder]="kind() === 'agent' ? 'Opcional: si no, el que le ponga el agente' : 'Opcional'"
            [value]="title()"
            (input)="title.set($any($event.target).value)"
          />
        </label>

        @if (kind() === "agent") {
          <label class="flex flex-col gap-1.5">
            <span class="font-medium">Primer mensaje <span class="font-normal text-muted">(opcional; también puedes escribir directamente en la terminal)</span></span>
            <textarea
              rows="4"
              class="rounded-md border border-border bg-surface-2 px-2.5 py-2 outline-none focus:border-accent"
              placeholder="Qué quieres que haga…"
              [value]="prompt()"
              (input)="prompt.set($any($event.target).value)"
              (keydown.control.enter)="submit()"
            ></textarea>
          </label>
        }
      </section>

      @if (error(); as message) {
        <p class="rounded-md border border-err bg-err-soft px-3 py-2 text-err" role="alert">{{ message }}</p>
      }
      <div class="flex items-center gap-2">
        <button
          type="submit"
          class="rounded-md bg-accent-strong px-4 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40"
          [disabled]="busy() || !folder()"
        >
          {{ busy() ? "Abriendo…" : kind() === "agent" ? "Abrir " + agentLabels[settings().agent] : "Abrir PowerShell" }}
        </button>
        @if (cancellable()) {
          <button type="button" class="rounded-md border border-border px-3 py-1.5 hover:bg-surface-3" (click)="cancelled.emit()">Cancelar</button>
        }
        @if (!repos().length && !place().cwd) {
          <span class="text-[12px] text-muted">Añade tus repos en Configuración → Repos, o elige una carpeta.</span>
        }
      </div>
    </form>
  `,
})
export class NewConversation {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly agents = input<AgentInfo[] | null>(null);
  public readonly repos = input.required<RepoConfig[]>();
  public readonly cancellable = input(false);
  public readonly created = output<Conversation>();
  public readonly cancelled = output<void>();

  protected readonly agentLabels = AGENT_LABELS;
  protected readonly kind = signal<ConversationKind>("agent");
  protected readonly settings = signal<AgentSettings>(readStorage<AgentSettings>(DEFAULTS_KEY, { agent: "claude", model: "", effort: "", mode: "default" }));
  protected readonly place = signal<Place>(readStorage<Place>(PLACE_KEY, {}));
  protected readonly title = signal("");
  protected readonly prompt = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly folder = computed(() => {
    const place = this.place();
    return place.cwd ?? this.repos().find((repo) => repo.name === place.repo)?.path ?? "";
  });
  protected readonly command = computed(() => {
    const { agent, model, effort, mode } = this.settings();
    const parts = [modeCommand(agent, mode).replace(/ \(sin flags.*\)$/, "")];
    if (model) {
      parts.push(`--model ${model}`);
    }
    if (effort) {
      parts.push(`esfuerzo ${effort}`);
    }
    return parts.join(" ");
  });

  public constructor() {
    // A remembered repo that is no longer configured falls back to the first one.
    effect(() => {
      const repos = this.repos();
      const place = this.place();
      if (!place.cwd && !repos.some((repo) => repo.name === place.repo) && repos.length) {
        this.place.set({ repo: repos[0]!.name });
      }
    });
  }

  protected chooseRepo(name: string): void {
    if (name) {
      this.place.set({ repo: name });
    }
  }

  protected async pickFolder(): Promise<void> {
    try {
      const path = await this.api.pickFolder(this.folder());
      if (path) {
        this.place.set({ cwd: path });
      }
    } catch (error) {
      this.error.set(apiError(error, "No se pudo abrir el selector de carpetas."));
    }
  }

  protected async submit(): Promise<void> {
    if (this.busy() || !this.folder()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const agent = this.kind() === "agent" ? this.settings() : {};
      const conversation = await this.api.createConversation({
        kind: this.kind(),
        ...this.place(),
        title: this.title().trim() || undefined,
        ...agent,
        prompt: this.kind() === "agent" ? this.prompt().trim() || undefined : undefined,
      });
      writeStorage(DEFAULTS_KEY, this.settings());
      writeStorage(PLACE_KEY, this.place());
      this.store.upsertConversation(conversation);
      this.title.set("");
      this.prompt.set("");
      this.created.emit(conversation);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo abrir la conversación."));
    } finally {
      this.busy.set(false);
    }
  }
}
