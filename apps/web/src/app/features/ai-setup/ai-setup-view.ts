import { Component, computed, inject, input, linkedSignal, output, resource, signal, viewChild, type OnDestroy } from "@angular/core";
import {
  AGENT_LABELS,
  AI_SETUP_KIND_LABELS,
  AI_SETUP_MODE_LABELS,
  AI_SETUP_SCOPE_LABELS,
  type AiSetupFile,
  type AiSetupRecommendation,
  type AiSetupSession,
} from "@nexura/shared";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";
import { Icon } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";
import { TicketChat } from "../tickets/ticket-chat";
import { PRIORITY_CLASSES, PRIORITY_LABELS, setupStatus, setupTitle } from "./ai-setup-format";

const SAVE_DELAY_MS = 700;
/** Files whose content the agents run: hooks, settings (hooks, permissions) and MCP servers. */
const RUNS_COMMANDS = /(^|\/)(hooks\/|settings(\.local)?\.json$|\.mcp\.json$|hooks\.json$|config\.toml$)/;

/** What a proposed file still lacks by the toolkit's rules, checked here without asking the assistant. */
export function fileGaps(file: AiSetupFile): string[] {
  const gaps: string[] = [];
  if (/(^|\/)SKILL\.md$/.test(file.path)) {
    const description = /^description:\s*(.+)$/m.exec(file.content)?.[1] ?? "";
    if (!/^---\r?\n[\s\S]*?^name:\s*\S/m.test(file.content)) {
      gaps.push(`${file.path}: falta el name en el frontmatter`);
    }
    if (!/use (it )?when|usar? cuando/i.test(description)) {
      gaps.push(`${file.path}: la description no dice cuándo usarla`);
    }
    if (!/tambi[eé]n en espa[nñ]ol/i.test(description)) {
      gaps.push(`${file.path}: faltan las frases en español de la description`);
    }
    if (!/^## Limits/m.test(file.content)) {
      gaps.push(`${file.path}: falta la sección ## Limits`);
    }
    if (file.content.split("\n").length > 200) {
      gaps.push(`${file.path}: pasa de 200 líneas`);
    }
  }
  if (/(^|\/)agents\/[^/]+\.md$/.test(file.path)) {
    const tools = /^tools:\s*(.+)$/m.exec(file.content)?.[1];
    if (!tools) {
      gaps.push(`${file.path}: el agente no restringe sus tools`);
    } else if (/-reviewer\.md$/.test(file.path) && /\b(Edit|Write)\b/.test(tools)) {
      gaps.push(`${file.path}: un revisor no puede tener Edit ni Write`);
    }
  }
  if (file.path.endsWith(".json")) {
    try {
      JSON.parse(file.content);
    } catch {
      gaps.push(`${file.path}: no es JSON válido`);
    }
  }
  return gaps;
}

/**
 * A Setup IA session: the conversation on one side; the assessment or the proposed files on
 * the other. File edits are saved as the person types (and travel with any action); writing
 * into the repo asks for confirmation and never commits.
 */
@Component({
  selector: "nx-ai-setup-view",
  imports: [Icon, StatusPill, TicketChat],
  templateUrl: "./ai-setup-view.html",
  host: { class: "flex min-h-0 flex-col" },
})
export class AiSetupView implements OnDestroy {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  public readonly session = input.required<AiSetupSession>();
  public readonly deleted = output<void>();
  /** Another session started from this one (a recommendation, or the same request in the toolkit). */
  public readonly opened = output<string>();
  private readonly chat = viewChild(TicketChat);

  protected readonly modeLabels = AI_SETUP_MODE_LABELS;
  protected readonly kindLabels = AI_SETUP_KIND_LABELS;
  protected readonly scopeLabels = AI_SETUP_SCOPE_LABELS;
  protected readonly agentLabels = AGENT_LABELS;
  protected readonly priorityLabels = PRIORITY_LABELS;
  protected readonly priorityClasses = PRIORITY_CLASSES;
  protected readonly status = computed(() => setupStatus(this.session()));
  protected readonly title = computed(() => setupTitle(this.session()));

  private readonly repoKinds = resource({ loader: () => this.api.aiSetupRepos() });
  /** A configured plugin marketplace other than this repo, where a toolkit piece belongs. */
  protected readonly toolkitRepo = computed(() => {
    const repos = this.repoKinds.hasValue() ? this.repoKinds.value() : [];
    const current = repos.find((repo) => repo.name === this.session().repo);
    return current?.toolkit ? undefined : repos.find((repo) => repo.toolkit)?.name;
  });

  // ---- local edits: kept over the server's echo until they are saved
  private editSeq = 0;
  private savedSeq = 0;
  private editedSession = "";
  private saveTimer?: ReturnType<typeof setTimeout>;
  private dirty(id: string): boolean {
    return this.editedSession === id && this.editSeq !== this.savedSeq;
  }
  protected readonly files = linkedSignal<AiSetupSession, AiSetupFile[]>({
    source: this.session,
    computation: (session, previous) => (previous && previous.source.id === session.id && this.dirty(session.id) ? previous.value : session.files),
  });
  protected readonly tab = linkedSignal<number, number>({ source: () => this.files().length, computation: (length, previous) => Math.max(0, Math.min(previous?.value ?? 0, length - 1)) });

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);
  protected readonly editable = computed(() => ["idle", "error"].includes(this.session().status) && !this.busy());
  protected readonly applied = computed(() => this.session().status === "applied");

  protected readonly gaps = computed(() => [...this.session().missing, ...this.files().filter((file) => !file.written).flatMap(fileGaps)]);
  protected readonly ready = computed(() => this.session().ready && this.gaps().length === 0);

  public ngOnDestroy(): void {
    void this.save();
  }

  protected edit(index: number, change: Partial<Pick<AiSetupFile, "path" | "content">>): void {
    this.files.update((files) => files.map((file, position) => (position === index ? { ...file, ...change } : file)));
    this.touched();
  }

  private touched(): void {
    this.editSeq++;
    this.editedSession = this.session().id;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    const id = this.editedSession;
    if (!id || !this.dirty(id) || this.session().id !== id || !this.editable()) {
      return;
    }
    const seq = this.editSeq;
    try {
      this.store.upsertAiSetup(await this.api.updateAiSetup(id, this.files()));
      this.savedSeq = Math.max(this.savedSeq, seq);
    } catch (error) {
      this.error.set(apiError(error, "No se pudieron guardar los cambios"));
    }
  }

  /** Runs an action that carries the files on screen; on failure they stay unsaved (and are kept). */
  private async act(call: (files: AiSetupFile[]) => Promise<AiSetupSession>, fallback: string): Promise<boolean> {
    clearTimeout(this.saveTimer);
    const sentSeq = this.editSeq;
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await call(this.files());
      this.savedSeq = Math.max(this.savedSeq, sentSeq);
      this.store.upsertAiSetup(session);
      return true;
    } catch (error) {
      this.error.set(apiError(error, fallback));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected async reply(text: string): Promise<void> {
    if (await this.act((files) => this.api.replyAiSetup(this.session().id, text, files), "No se pudo enviar el mensaje")) {
      this.chat()?.clear();
    }
  }

  protected async stop(): Promise<void> {
    try {
      this.store.upsertAiSetup(await this.api.cancelAiSetup(this.session().id));
    } catch (error) {
      this.error.set(apiError(error, "No se pudo parar"));
    }
  }

  protected async removeFile(file: AiSetupFile): Promise<void> {
    if (!confirm(`¿Quitar ${file.path} de la propuesta?`)) {
      return;
    }
    await this.save();
    await this.act(() => this.api.removeAiSetupFile(this.session().id, file.key), "No se pudo quitar el fichero");
  }

  protected async write(): Promise<void> {
    const pending = this.files().filter((file) => !file.written);
    const list = pending.map((file) => `• ${file.path}${file.baseHash ? " (se sobrescribe)" : " (nuevo)"}`).join("\n");
    const warning = this.gaps().length ? `\n\nOjo, aún falta:\n${this.gaps().map((gap) => `- ${gap}`).join("\n")}` : "";
    const runs = pending.some((file) => RUNS_COMMANDS.test(file.path))
      ? "\n\nIncluye hooks, settings o servidores MCP: ejecutan comandos en tu máquina. Léelos antes de escribirlos."
      : "";
    if (!confirm(`Se escribirá en ${this.session().repo} (sin commit):\n\n${list}${warning}${runs}\n\n¿Escribir ahora?`)) {
      return;
    }
    await this.act((files) => this.api.applyAiSetup(this.session().id, files), "No se pudo escribir en el repo");
  }

  /** Starts a create session from a recommendation (or the same request in the toolkit repo). */
  protected async startCreate(idea: string, repo = this.session().repo): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await this.api.startAiSetup({ repo, mode: "create", idea, agent: this.session().agent });
      this.store.upsertAiSetup(session);
      this.opened.emit(session.id);
    } catch (error) {
      this.error.set(apiError(error, "No se pudo empezar"));
    } finally {
      this.busy.set(false);
    }
  }

  protected createFrom(recommendation: AiSetupRecommendation, repo?: string): Promise<void> {
    return this.startCreate(`${recommendation.createPrompt}\n\n(${recommendation.title}: ${recommendation.why})`, repo);
  }

  protected async copy(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copied.set(command);
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      this.error.set("No se pudo copiar");
    }
  }

  protected async remove(): Promise<void> {
    const question = this.applied() ? "¿Quitar esta sesión de la lista? Los ficheros escritos se quedan en el repo." : "¿Borrar esta sesión? Se pierde la conversación.";
    if (!confirm(question)) {
      return;
    }
    try {
      await this.api.deleteAiSetup(this.session().id);
      this.store.forgetAiSetup(this.session().id);
      this.deleted.emit();
    } catch (error) {
      this.error.set(apiError(error, "No se pudo borrar"));
    }
  }
}
