import { Component, computed, input, linkedSignal, output } from "@angular/core";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  CONVERSATION_EFFORTS,
  CONVERSATION_MODE_FLAGS,
  CONVERSATION_MODE_LABELS,
  CONVERSATION_MODES,
  modelsFor,
  type AgentInfo,
  type AgentKind,
  type ConversationMode,
} from "@nexura/shared";

export type AgentSettings = { agent: AgentKind; model: string; effort: string; mode: ConversationMode };

const OTHER = "__other__";

/** The command a mode launches for an agent, e.g. "claude --permission-mode plan". */
export function modeCommand(agent: AgentKind, mode: ConversationMode): string {
  const flags = CONVERSATION_MODE_FLAGS[agent][mode];
  return flags.length ? `${agent} ${flags.join(" ")}` : `${agent} (sin flags: tu configuración)`;
}

/** Agent, model, effort and mode of a terminal conversation ("" model/effort = the CLI's default). */
@Component({
  selector: "nx-agent-controls",
  template: `
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Agente">
        @for (agent of agentKinds; track agent) {
          <button
            type="button"
            role="radio"
            class="px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40"
            [class]="settings().agent === agent ? 'bg-accent-strong text-white' : 'hover:bg-surface-3'"
            [attr.aria-checked]="settings().agent === agent"
            [disabled]="!available(agent)"
            [attr.title]="unavailable(agent)"
            (click)="setAgent(agent)"
          >
            {{ agentLabels[agent] }}
          </button>
        }
      </div>

      <label class="flex items-center gap-1.5 text-muted">
        Modelo
        @if (typingModel()) {
          <input
            class="w-40 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-fg outline-none focus:border-accent"
            spellcheck="false"
            placeholder="id del modelo"
            [value]="settings().model"
            (change)="setModel($any($event.target).value.trim())"
            (keydown.escape)="typingModel.set(false)"
          />
          <button type="button" class="text-[11px] hover:text-fg" title="Elegir de la lista" (click)="typingModel.set(false)">lista</button>
        } @else {
          <select
            class="max-w-48 rounded-md border border-border bg-surface-2 px-1.5 py-1 font-mono text-fg"
            (change)="chooseModel($any($event.target).value)"
          >
            <option value="" [selected]="!settings().model">por defecto</option>
            @for (model of models(); track model) {
              <option [value]="model" [selected]="model === settings().model">{{ model }}</option>
            }
            <option [value]="other">Otro…</option>
          </select>
        }
      </label>

      <label class="flex items-center gap-1.5 text-muted">
        Esfuerzo
        <select class="rounded-md border border-border bg-surface-2 px-1.5 py-1 text-fg" (change)="emit({ effort: $any($event.target).value })">
          <option value="" [selected]="!settings().effort">por defecto</option>
          @for (effort of efforts(); track effort) {
            <option [value]="effort" [selected]="effort === settings().effort">{{ effort }}</option>
          }
        </select>
      </label>

      <label class="flex items-center gap-1.5 text-muted" [attr.title]="modeCommand(settings().agent, settings().mode)">
        Modo
        <select
          class="rounded-md border px-1.5 py-1 text-fg"
          [class]="settings().mode === 'bypass' ? 'border-err bg-err-soft' : 'border-border bg-surface-2'"
          (change)="emit({ mode: $any($event.target).value })"
        >
          @for (mode of modes; track mode) {
            <option [value]="mode" [selected]="mode === settings().mode" [attr.title]="modeCommand(settings().agent, mode)">{{ modeLabels[mode] }}</option>
          }
        </select>
      </label>
    </div>
  `,
})
export class AgentControls {
  public readonly settings = input.required<AgentSettings>();
  /** Installed CLIs (null while loading: everything enabled). */
  public readonly agents = input<AgentInfo[] | null>(null);
  public readonly settingsChange = output<AgentSettings>();

  protected readonly agentKinds = AGENT_KINDS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly modes = CONVERSATION_MODES;
  protected readonly modeLabels = CONVERSATION_MODE_LABELS;
  protected readonly modeCommand = modeCommand;
  protected readonly other = OTHER;

  protected readonly models = computed(() => {
    const suggested = modelsFor(this.settings().agent, this.agents() ?? undefined);
    const current = this.settings().model;
    return current && !suggested.includes(current) ? [current, ...suggested] : suggested;
  });
  protected readonly efforts = computed(() => CONVERSATION_EFFORTS[this.settings().agent]);
  protected readonly typingModel = linkedSignal({ source: () => this.settings().agent, computation: () => false });

  protected available(agent: AgentKind): boolean {
    return this.agents()?.find((info) => info.agent === agent)?.available ?? true;
  }

  protected unavailable(agent: AgentKind): string | null {
    const info = this.agents()?.find((candidate) => candidate.agent === agent);
    return info && !info.available ? `${AGENT_LABELS[agent]} no está instalado: ${info.error ?? ""}` : null;
  }

  /** Models and effort levels are per CLI: a new agent starts on its defaults (the mode carries over). */
  protected setAgent(agent: AgentKind): void {
    if (agent !== this.settings().agent) {
      const effort = CONVERSATION_EFFORTS[agent].includes(this.settings().effort) ? this.settings().effort : "";
      this.settingsChange.emit({ ...this.settings(), agent, model: "", effort });
    }
  }

  protected chooseModel(value: string): void {
    if (value === OTHER) {
      this.typingModel.set(true);
    } else {
      this.setModel(value);
    }
  }

  protected setModel(model: string): void {
    if (model !== this.settings().model) {
      this.emit({ model });
    }
  }

  protected emit(change: Partial<AgentSettings>): void {
    this.settingsChange.emit({ ...this.settings(), ...change });
  }
}
