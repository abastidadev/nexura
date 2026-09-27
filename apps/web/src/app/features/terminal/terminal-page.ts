import { Component, computed, effect, inject, linkedSignal, signal } from "@angular/core";
import {
  AGENT_LABELS,
  CONVERSATION_MODE_LABELS,
  type AgentInfo,
  type Conversation,
  type ConversationSegment,
} from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore, readStorage, writeStorage } from "../../core/nexura-store";
import { AgentControls, type AgentSettings } from "./agent-controls";
import { ConversationHistory } from "./conversation-history";
import { ConversationTerminal } from "./conversation-terminal";
import { NewConversation } from "./new-conversation";
import { TerminalSessions } from "./terminal-sessions";
import { Icon } from "../../shared/icon";

const SELECTED_KEY = "nexura.terminal.selected";
const HISTORY_KEY = "nexura.terminal.history";

type Settings = AgentSettings & { id: string };

const sameSettings = (a: Settings, b: Settings): boolean =>
  a.id === b.id && a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.mode === b.mode;

/** Project a conversation belongs to: its repo, or the folder name. */
function projectOf(conversation: Conversation): string {
  return conversation.repo ?? conversation.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? conversation.cwd;
}

/**
 * Terminal: interactive conversations with Claude Code, Codex or Copilot (or PowerShell) on
 * a project. The list groups them by project; the toolbar changes agent, model, effort and
 * mode (restarting the CLI on the same session, or handing the history to another agent).
 */
@Component({
  selector: "nx-terminal-page",
  imports: [AgentControls, ConversationHistory, ConversationTerminal, NewConversation, Icon],
  templateUrl: "./terminal-page.html",
  host: { class: "flex h-full min-h-0 flex-col lg:flex-row" },
})
export class TerminalPage {
  private readonly api = inject(Api);
  protected readonly store = inject(NexuraStore);
  private readonly sessions = inject(TerminalSessions);

  protected readonly agentLabels = AGENT_LABELS;
  protected readonly modeLabels = CONVERSATION_MODE_LABELS;
  protected readonly projectOf = projectOf;

  protected readonly selectedId = signal<string | null>(readStorage<string | null>(SELECTED_KEY, null));
  protected readonly creating = signal(false);
  protected readonly showHistory = signal<boolean>(readStorage<boolean>(HISTORY_KEY, false));
  protected readonly query = signal("");
  protected readonly projectFilter = signal("");
  protected readonly renaming = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly agents = signal<AgentInfo[] | null>(null);

  protected readonly repos = computed(() => this.store.config()?.repos ?? []);
  protected readonly selected = computed(() => this.store.conversations().find((conversation) => conversation.id === this.selectedId()) ?? null);
  protected readonly current = computed(() => this.selected()?.segments.at(-1));

  /** What the selected conversation runs now; the draft below follows it until the user edits it. */
  private readonly running = computed<Settings>(
    () => {
      const segment = this.current();
      return {
        id: this.selectedId() ?? "",
        agent: segment?.agent ?? "claude",
        model: segment?.model ?? "",
        effort: segment?.effort ?? "",
        mode: segment?.mode ?? "default",
      };
    },
    { equal: sameSettings },
  );
  protected readonly draft = linkedSignal<AgentSettings>(() => {
    const { id: _id, ...settings } = this.running();
    return settings;
  });
  protected readonly dirty = computed(() => !sameSettings({ ...this.draft(), id: "" }, { ...this.running(), id: "" }));
  protected readonly agentChanged = computed(() => Boolean(this.current()) && this.draft().agent !== this.current()!.agent);
  /** Handoff options, reset per conversation. */
  protected readonly message = linkedSignal({ source: this.selectedId, computation: () => "" });
  protected readonly fresh = linkedSignal({ source: this.selectedId, computation: () => false });

  protected readonly projects = computed(() => [...new Set(this.store.conversations().map(projectOf))].sort((a, b) => a.localeCompare(b)));
  protected readonly groups = computed(() => {
    const query = this.query().trim().toLowerCase();
    const project = this.projectFilter();
    const groups = new Map<string, Conversation[]>();
    for (const conversation of this.store.conversations()) {
      const name = projectOf(conversation);
      if ((project && name !== project) || (query && !`${conversation.title} ${name}`.toLowerCase().includes(query))) {
        continue;
      }
      groups.set(name, [...(groups.get(name) ?? []), conversation]);
    }
    return [...groups].map(([name, items]) => ({ name, items }));
  });

  public constructor() {
    this.api
      .getAgents()
      .then((agents) => this.agents.set(agents))
      .catch(() => this.agents.set(null));
    effect(() => writeStorage(SELECTED_KEY, this.selectedId()));
    effect(() => writeStorage(HISTORY_KEY, this.showHistory()));
    // Once the list is loaded: a selection that no longer exists moves to the newest one, and
    // terminals of conversations deleted elsewhere are freed.
    effect(() => {
      if (!this.store.config()) {
        return;
      }
      const conversations = this.store.conversations();
      this.sessions.prune(new Set(conversations.map((conversation) => conversation.id)));
      if (this.selectedId() && !conversations.some((conversation) => conversation.id === this.selectedId())) {
        this.selectedId.set(conversations[0]?.id ?? null);
      }
    });
  }

  protected select(id: string): void {
    this.selectedId.set(id);
    this.creating.set(false);
    this.error.set(null);
  }

  protected onCreated(conversation: Conversation): void {
    this.select(conversation.id);
  }

  /** "Claude Code → Codex", or "PowerShell". */
  protected chain(conversation: Conversation): string {
    if (conversation.kind === "shell") {
      return "PowerShell";
    }
    const agents = conversation.segments.map((segment) => AGENT_LABELS[segment.agent]).filter((agent, index, all) => agent !== all[index - 1]);
    return agents.join(" → ") || "—";
  }

  protected segmentTitle(segment: ConversationSegment): string {
    const parts = [`Sesión ${segment.sessionId ?? "(el agente aún no la ha guardado)"}`];
    if (segment.handoff) {
      parts.push(`empezó con ${segment.handoff.messages} mensajes de ${segment.handoff.from.map((agent) => AGENT_LABELS[agent]).join(" y ")}`);
    }
    return parts.join(" · ");
  }

  protected ago(iso: string): string {
    const seconds = Math.max(0, (this.store.now() - Date.parse(iso)) / 1000);
    if (seconds < 60) {
      return "ahora";
    }
    if (seconds < 3600) {
      return `hace ${Math.floor(seconds / 60)} min`;
    }
    if (seconds < 86_400) {
      return `hace ${Math.floor(seconds / 3600)} h`;
    }
    return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  }

  // ---- actions on the selected conversation

  /** Restarts with the draft: same agent = same session with the new flags; another agent = handoff (or fresh). */
  protected apply(): Promise<void> {
    const id = this.selectedId()!;
    const change = { ...this.draft(), fresh: this.fresh() || undefined, prompt: this.message().trim() || undefined };
    return this.run(id, () => this.api.startConversation(id, change)).then(() => {
      this.message.set("");
      this.fresh.set(false);
    });
  }

  /** Picking an agent this conversation already used brings back the model and effort it had there. */
  protected setDraft(settings: AgentSettings): void {
    if (settings.agent !== this.draft().agent) {
      const previous = this.selected()?.segments.findLast((segment) => segment.agent === settings.agent);
      if (previous) {
        settings = { ...settings, model: previous.model, effort: previous.effort };
      }
    }
    this.draft.set(settings);
  }

  protected discard(): void {
    const { id: _id, ...settings } = this.running();
    this.draft.set(settings);
  }

  protected resume(fresh = false): Promise<void> {
    const id = this.selectedId()!;
    return this.run(id, () => this.api.startConversation(id, fresh ? { fresh: true } : {}));
  }

  protected stop(): Promise<void> {
    const id = this.selectedId()!;
    return this.run(id, () => this.api.stopConversation(id));
  }

  /** A new conversation that starts from this one's history (with the agent chosen in the toolbar). */
  protected fork(): Promise<void> {
    const id = this.selectedId()!;
    return this.run(id, () => this.api.createConversation({ kind: "agent", forkOf: id, ...this.draft() }));
  }

  /** PowerShell in the same project. */
  protected openShell(conversation: Conversation): Promise<void> {
    const place = conversation.repo ? { repo: conversation.repo } : { cwd: conversation.cwd };
    return this.run(conversation.id, () => this.api.createConversation({ kind: "shell", ...place }));
  }

  protected async remove(conversation: Conversation): Promise<void> {
    const running = conversation.status === "running" ? "\n\nSu proceso está en marcha y se cerrará." : "";
    if (!confirm(`¿Borrar la conversación «${conversation.title}»?${running}\n\nLas sesiones del agente siguen en su historial (claude --resume, codex resume…).`)) {
      return;
    }
    try {
      await this.api.deleteConversation(conversation.id);
      this.store.forgetConversation(conversation.id);
      this.sessions.dispose(conversation.id);
      if (this.selectedId() === conversation.id) {
        this.selectedId.set(this.store.conversations()[0]?.id ?? null);
      }
    } catch (error) {
      this.error.set(apiError(error, "No se pudo borrar la conversación."));
    }
  }

  protected togglePin(conversation: Conversation): Promise<void> {
    return this.run(null, () => this.api.updateConversation(conversation.id, { pinned: !conversation.pinned }));
  }

  protected rename(conversation: Conversation, title: string): Promise<void> {
    this.renaming.set(null);
    if (!title.trim() || title.trim() === conversation.title) {
      return Promise.resolve();
    }
    return this.run(null, () => this.api.updateConversation(conversation.id, { title }));
  }

  /** Runs a call that returns a conversation: shows it (and opens it when it is a new one). */
  private async run(from: string | null, call: () => Promise<Conversation>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const conversation = await call();
      this.store.upsertConversation(conversation);
      if (from && conversation.id !== from) {
        this.select(conversation.id);
      }
      this.sessions.focus(conversation.id);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo completar la acción."));
    } finally {
      this.busy.set(false);
    }
  }
}
