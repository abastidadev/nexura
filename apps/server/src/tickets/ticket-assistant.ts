import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  DEFAULT_TICKET_ASSISTANT,
  TICKET_KINDS,
  TICKET_KIND_LABELS,
  TICKET_SIDES,
  TICKET_SIDE_LABELS,
  type AgentKind,
  type NewTicketDraft,
  type NexuraEvent,
  type NexuraSettings,
  type RepoConfig,
  type ServerMessage,
  type TicketAssistantAgent,
  type TicketDraft,
  type TicketDraftUpdate,
  type TicketItem,
  type TicketKind,
  type TicketOptions,
  type TicketQuestion,
  type TicketSample,
  type TicketSide,
  type TicketSource,
  type Worktree,
} from "@nexura/shared";
import { EFFORTS, isValidModel, loadConfig } from "../config/config-loader.ts";
import { CONFIG_DIR } from "../config/paths.ts";
import { PROVIDER_LABEL, repoRemoteOf } from "../forge/remote.ts";
import { createTickets, similarTickets, ticketOptions, ticketTarget, type TicketTarget } from "../forge/tickets.ts";
import { memoryRunOptions, memoryStore, readMemory } from "../memory/memory.ts";
import { projectOf } from "../memory/memory-store.ts";
import { renderTemplate } from "../prompt/render.ts";
import { AgentProcess, type AgentOutcome } from "../runner/agent-process.ts";
import { readRepoNotes, repoMap } from "../workspace/repo-context.ts";
import type { TicketDraftStore } from "./ticket-draft-store.ts";

const STEP = "ticketDraft";
/** Read-only: the assistant looks at the code, never changes it. No Bash, no MCP (a forge MCP could create items). */
const TOOLS = ["Read", "Glob", "Grep"];
const TURN_TIMEOUT_MS = 5 * 60_000;
const ACTIVITY_MS = 800;
const MAX_ITEMS = 2;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 4;
const MAX_IDEA = 20_000;
const SPLIT_REQUEST = "Divide el ticket en frontend y backend.";
const SPLIT_INSTRUCTION =
  "La persona ha pulsado **«Dividir en frontend y backend»**: devuelve dos items enlazados, primero el del lado actual y después el del otro lado. Cada uno lleva solo su parte y excluye expresamente la del otro en lo que NO incluye; los dos con el mismo tipo (historia o bug) salvo que no tenga sentido.";
const REPLY_INSTRUCTION = "Sigue con lo que te responde la persona.";
/** Turns running at once across all drafts (each one is an agent process spending quota). */
const MAX_RUNNING_TURNS = 3;
/** A draft this long should be created or started again; it also bounds what a lost session re-sends. */
const MAX_MESSAGES = 60;
/**
 * Files the assistant must not read (Claude honours these; the others rely on their sandbox):
 * the drafts end up on a board, and the board's own tickets are untrusted input in the prompt.
 */
const SECRET_READS = ["Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*.pfx)", "Read(**/secrets*)", "Read(**/.npmrc)"];
/** Things that look like credentials: a ticket carrying one is not created without being edited. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "una clave privada"],
  [/\bAKIA[0-9A-Z]{16}\b/, "una clave de AWS"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/, "un token de GitHub"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "un token de Slack"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "un JWT"],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|client[_-]?secret|connectionstring)\s*[:=]\s*\S{6,}/i, "una contraseña o clave"],
];

/** The first thing in the items that looks like a credential, if any. */
export function secretIn(items: TicketItem[]): string | undefined {
  const text = items.flatMap((item) => [item.title, item.description, item.acceptanceCriteria, item.reproSteps]).join("\n");
  return SECRET_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A request the draft cannot take right now; `status` is the HTTP status the API answers with. */
export class TicketDraftError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The assistant's structured answer (config/ticket-assistant/schema.json). */
type AssistantOutput = {
  message: string;
  questions: TicketQuestion[];
  items: Pick<TicketItem, "side" | "kind" | "title" | "description" | "acceptanceCriteria" | "reproSteps" | "tags">[];
  board: { areaPath: string; sprint: "current" | "backlog" };
  suggestSplit: boolean;
  missing: string[];
  ready: boolean;
};

type Turn = { kind: "first" } | { kind: "reply"; text: string } | { kind: "split" };

/** Where tickets go and how they are created; the tests replace it. */
export type TicketForge = {
  sourceOf(repo: RepoConfig): Promise<TicketSource>;
  target(source: TicketSource, repo: string): Promise<TicketTarget>;
  options(target: TicketTarget, team?: string): Promise<TicketOptions>;
  similar(target: TicketTarget, kind: TicketKind, types: TicketOptions["types"]): Promise<TicketSample[]>;
  create(items: TicketItem[], targetOf: (item: TicketItem) => Promise<TicketTarget>, saved: (items: TicketItem[]) => void): Promise<TicketItem[]>;
};

export type TicketAssistantOptions = {
  repos?: () => RepoConfig[];
  settings?: () => Pick<NexuraSettings, "memoryEnabled">;
  /** Epoch seconds until which the agent's quota is paused (Configuración > General), if it is. */
  quotaUntil?: (agent: AgentKind) => Promise<number | undefined>;
  forge?: TicketForge;
  configDir?: string;
  timeoutMs?: number;
};

const now = (): string => new Date().toISOString();

/** The provider of the repo's origin, else the one NEXURA_AZURE_ORG / NEXURA_GITHUB_REPO point at. */
async function sourceOf(repo: RepoConfig): Promise<TicketSource> {
  const provider = (await repoRemoteOf(repo.path))?.provider;
  if (provider) {
    return provider;
  }
  if (process.env.NEXURA_AZURE_ORG) {
    return "azure";
  }
  if (process.env.NEXURA_GITHUB_REPO) {
    return "github";
  }
  throw new TicketDraftError(400, `El repo ${repo.name} no tiene un remote origin de Azure DevOps ni de GitHub (o define NEXURA_AZURE_ORG / NEXURA_GITHUB_REPO)`);
}

export const DEFAULT_TICKET_FORGE: TicketForge = {
  sourceOf,
  target: (source, repo) => ticketTarget(source, loadConfig().repos, repo),
  options: ticketOptions,
  similar: similarTickets,
  create: createTickets,
};

function emptyItem(kind: TicketKind, repo: string, side: TicketSide = "frontend"): TicketItem {
  return { key: randomUUID(), side, kind, title: "", description: "", acceptanceCriteria: "", reproSteps: "", tags: [], repo, iteration: "", assignee: "", areaPath: "" };
}

const text = (value: unknown, max = 50_000): string => (typeof value === "string" ? value.slice(0, max) : "");
const texts = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? value.map((entry) => text(entry, 500).trim()).filter(Boolean).slice(0, max) : [];

/** A story keeps its description and criteria, a bug only its repro steps (the skill's fields). */
function normalizeFields<T extends Pick<TicketItem, "kind" | "description" | "acceptanceCriteria" | "reproSteps">>(item: T): T {
  return item.kind === "bug" ? { ...item, description: "", acceptanceCriteria: "" } : { ...item, reproSteps: "" };
}

/** What the assistant does, in words for someone who does not program. */
function describeTool(event: Extract<NexuraEvent, { kind: "toolUse" }>): string {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const detail = String(input["file_path"] ?? input["path"] ?? input["pattern"] ?? "");
  if (event.name.startsWith("mcp__")) {
    return "Consultando la memoria del proyecto…";
  }
  if (event.name === "Read") {
    return `Revisando el código: ${basename(detail)}`;
  }
  return detail ? `Buscando en el código: ${detail.slice(0, 60)}` : "Revisando el código…";
}

/** The board as the assistant needs to know it: project or repo, team, default area, types and sprints. */
function boardText(source: TicketSource, options: TicketOptions | undefined, error: string | undefined): string {
  if (!options) {
    return `- ${PROVIDER_LABEL[source]}: no se pudo consultar el tablero (${error ?? "sin datos"}). Guíate por el CLAUDE.md del repo y pregunta si hace falta.`;
  }
  const current = options.iterations.find((iteration) => iteration.current);
  const lines = [
    `- ${PROVIDER_LABEL[source]} · ${source === "azure" ? "proyecto" : "repo"} **${options.target}**${options.team ? ` · equipo **${options.team}**` : ""}`,
    source === "azure"
      ? `- Tipos de work item del proceso: historia = "${options.types.story}", bug = "${options.types.bug}"`
      : `- Tipos de issue de la organización: ${options.types.story || options.types.bug ? `historia = "${options.types.story}", bug = "${options.types.bug}"` : "ninguno (se usan etiquetas)"}`,
    options.areaPath ? `- Área por defecto del equipo: ${options.areaPath}` : "",
    current ? `- Sprint en curso: ${current.name}` : "- No hay sprint en curso",
    options.labels.length ? `- Etiquetas del repo: ${options.labels.join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The team's latest tickets: every title (prefixes, areas, tags) and the texts of the first few. */
function similarText(samples: TicketSample[], error: string | undefined): string {
  if (!samples.length) {
    return error ? `No se pudieron leer (${error}).` : "No hay tickets de este tipo todavía: usa las plantillas.";
  }
  const meta = (sample: TicketSample): string =>
    [sample.area && `área: ${sample.area}`, sample.iteration && `sprint: ${sample.iteration}`, sample.tags.length && `tags: ${sample.tags.join(", ")}`].filter(Boolean).join("; ");
  const titles = samples.map((sample) => `- #${sample.id} [${sample.type} · ${sample.state}] ${sample.title}${meta(sample) ? ` (${meta(sample)})` : ""}`);
  const full = samples
    .filter((sample) => sample.description || sample.acceptanceCriteria || sample.reproSteps)
    .map((sample) =>
      [
        `### #${sample.id} ${sample.title}`,
        sample.description ? `**Description**\n${sample.description}` : "",
        sample.acceptanceCriteria ? `**Acceptance Criteria**\n${sample.acceptanceCriteria}` : "",
        sample.reproSteps ? `**Repro Steps**\n${sample.reproSteps}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  return [titles.join("\n"), ...full].join("\n\n");
}

function readConfigFile(configDir: string, name: string): string {
  const file = join(configDir, "ticket-assistant", name);
  if (!existsSync(file)) {
    throw new Error(`Falta ${file}`);
  }
  return readFileSync(file, "utf8");
}

/** Checks the assistant's answer against the schema's shape, so a sloppy agent cannot break the draft. */
function parseOutput(value: unknown): AssistantOutput {
  const output = (typeof value === "string" ? JSON.parse(value) : value) as Partial<AssistantOutput> | undefined;
  if (!output || typeof output !== "object" || !Array.isArray(output.items)) {
    throw new Error("El asistente no devolvió el borrador en el formato esperado");
  }
  return {
    message: text(output.message, 4000).trim(),
    questions: (Array.isArray(output.questions) ? output.questions : [])
      .map((question) => ({ text: text(question?.text, 500).trim(), options: texts(question?.options, MAX_OPTIONS) }))
      .filter((question) => question.text)
      .slice(0, MAX_QUESTIONS),
    items: output.items.slice(0, MAX_ITEMS).map((item) =>
      normalizeFields({
        side: TICKET_SIDES.includes(item?.side as TicketSide) ? item.side : "frontend",
        kind: TICKET_KINDS.includes(item?.kind as TicketKind) ? item.kind : "story",
        title: text(item?.title, 300).trim(),
        description: text(item?.description),
        acceptanceCriteria: text(item?.acceptanceCriteria),
        reproSteps: text(item?.reproSteps),
        tags: texts(item?.tags, 10),
      }),
    ),
    board: { areaPath: text(output.board?.areaPath, 300).trim(), sprint: output.board?.sprint === "current" ? "current" : "backlog" },
    suggestSplit: Boolean(output.suggestSplit),
    missing: texts(output.missing, 10),
    ready: Boolean(output.ready),
  };
}

/**
 * The Tickets section: a headless agent, read-only on the repo, that asks the person plain
 * questions and fills in a ticket in the team's format (ai-toolkit `create-work-item`). Each
 * turn is one agent run with the JSON schema; the next turns resume its session. Nothing
 * reaches the board until the person presses «Crear» (`create`), and then the server does it.
 *
 * It lives outside the flow queue: a person waiting on an answer must not wait behind flows.
 */
export class TicketAssistant extends EventEmitter {
  private readonly store: TicketDraftStore;
  private readonly repos: () => RepoConfig[];
  private readonly settings: () => Pick<NexuraSettings, "memoryEnabled">;
  private readonly quotaUntil: (agent: AgentKind) => Promise<number | undefined>;
  private readonly forge: TicketForge;
  private readonly configDir: string;
  private readonly timeoutMs: number;
  private readonly running = new Map<string, AgentProcess>();
  private readonly stopped = new Set<string>();
  /** Drafts being created on the board right now. */
  private readonly creating = new Set<string>();
  /** Drafts with a turn under way (from queued to done). */
  private readonly turns = new Set<string>();

  public constructor(store: TicketDraftStore, options: TicketAssistantOptions = {}) {
    super();
    this.store = store;
    this.repos = options.repos ?? (() => loadConfig().repos);
    this.settings = options.settings ?? (() => ({ memoryEnabled: true }));
    this.quotaUntil = options.quotaUntil ?? (async () => undefined);
    this.forge = options.forge ?? DEFAULT_TICKET_FORGE;
    this.configDir = options.configDir ?? CONFIG_DIR;
    this.timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
    // Agent processes do not outlive the server: a turn that was running is lost.
    for (const draft of store.list().filter((candidate) => candidate.status === "thinking")) {
      draft.status = "error";
      draft.error = "Se interrumpió al reiniciar Nexura: vuelve a enviar tu respuesta.";
      store.save(draft);
    }
  }

  public list(): TicketDraft[] {
    return this.store.list();
  }

  public get(id: string): TicketDraft {
    const draft = this.store.get(id);
    if (!draft) {
      throw new TicketDraftError(404, `No existe el borrador ${id}`);
    }
    return draft;
  }

  /** Creates the draft and runs the first turn in the background (progress over the WebSocket). */
  public async start(request: NewTicketDraft): Promise<TicketDraft> {
    const repo = this.requireRepo(request.repo);
    const idea = text(request.idea, MAX_IDEA).trim();
    if (!idea) {
      throw new TicketDraftError(400, "Cuenta qué pasa o qué necesitas");
    }
    if (!TICKET_KINDS.includes(request.kind)) {
      throw new TicketDraftError(400, `Tipo de ticket desconocido: ${request.kind}`);
    }
    const agent: TicketAssistantAgent = { ...DEFAULT_TICKET_ASSISTANT, ...request.agent };
    if (!AGENT_KINDS.includes(agent.agent)) {
      throw new TicketDraftError(400, `Agente desconocido: ${agent.agent}`);
    }
    // Model and effort go to the CLI as arguments: the same checks as a step's.
    if (!isValidModel(agent.agent, agent.model) || !EFFORTS.has(agent.effort)) {
      throw new TicketDraftError(400, `Modelo o esfuerzo no válido para ${AGENT_LABELS[agent.agent]}: ${agent.model} / ${agent.effort}`);
    }
    this.checkCapacity();
    const source = await this.forge.sourceOf(repo);
    const at = now();
    const draft: TicketDraft = {
      id: randomUUID(),
      repo: repo.name,
      source,
      kind: request.kind,
      idea,
      agent,
      messages: [{ role: "user", text: idea, at }],
      items: [emptyItem(request.kind, repo.name)],
      suggestSplit: false,
      missing: [],
      ready: false,
      status: "thinking",
      createdAt: at,
      updatedAt: at,
    };
    this.persist(draft);
    void this.runTurn(draft.id, { kind: "first" });
    return draft;
  }

  /**
   * The person's answer: the next turn, on the same session. `edited` = the items as the
   * person left them, applied first (edits still waiting to be saved travel with the answer).
   */
  public reply(id: string, answer: string, edited?: TicketDraftUpdate): TicketDraft {
    const draft = this.editable(id);
    const textAnswer = text(answer, MAX_IDEA).trim();
    if (!textAnswer) {
      throw new TicketDraftError(400, "Escribe una respuesta");
    }
    this.applyEdits(draft, edited);
    return this.queueTurn(draft, textAnswer, { kind: "reply", text: textAnswer });
  }

  /** «Dividir en frontend y backend»: the assistant writes the two linked items. */
  public split(id: string, edited?: TicketDraftUpdate): TicketDraft {
    const draft = this.editable(id);
    if (draft.items.length >= MAX_ITEMS) {
      throw new TicketDraftError(409, "El ticket ya está dividido en frontend y backend");
    }
    this.applyEdits(draft, edited);
    return this.queueTurn(draft, SPLIT_REQUEST, { kind: "split" });
  }

  /** Saves what the person edited by hand: the items' texts, tags and where they go. */
  public update(id: string, update: TicketDraftUpdate): TicketDraft {
    const draft = this.editable(id);
    this.applyEdits(draft, update);
    this.persist(draft);
    return draft;
  }

  private applyEdits(draft: TicketDraft, update: TicketDraftUpdate | undefined): void {
    if (!update) {
      return;
    }
    const incoming = Array.isArray(update.items) ? update.items : [];
    const seen = new Set<string>();
    const items = incoming
      .map((item) => {
        // Only the draft's own items, once each: an edit never adds items.
        const current = draft.items.find((candidate) => candidate.key === item?.key);
        if (!current || seen.has(current.key)) {
          return undefined;
        }
        seen.add(current.key);
        if (current.created) {
          // Already on the board: where it went is fixed (a retry links the rest to it).
          return current;
        }
        const repo = this.repos().some((candidate) => candidate.name === item.repo) ? item.repo : current.repo;
        return normalizeFields<TicketItem>({
          ...current,
          side: TICKET_SIDES.includes(item.side) ? item.side : current.side,
          kind: TICKET_KINDS.includes(item.kind) ? item.kind : current.kind,
          title: text(item.title, 300),
          description: text(item.description),
          acceptanceCriteria: text(item.acceptanceCriteria),
          reproSteps: text(item.reproSteps),
          tags: texts(item.tags, 20),
          repo,
          iteration: text(item.iteration, 500),
          assignee: text(item.assignee, 300),
          areaPath: text(item.areaPath, 500),
          team: item.team ? text(item.team, 200) : undefined,
        });
      })
      .filter((item): item is TicketItem => Boolean(item))
      .slice(0, MAX_ITEMS);
    // An item already created cannot be dropped from the draft either.
    for (const created of draft.items.filter((item) => item.created && !seen.has(item.key))) {
      items.unshift(created);
    }
    if (!items.length) {
      throw new TicketDraftError(400, "El borrador necesita al menos un item");
    }
    draft.items = items.slice(0, MAX_ITEMS);
    draft.suggestSplit = draft.suggestSplit && items.length < MAX_ITEMS;
  }

  /** Stops the running turn; the draft keeps what it had. */
  public cancel(id: string): TicketDraft {
    const draft = this.get(id);
    const process = this.running.get(id);
    if (process) {
      this.stopped.add(id);
      process.kill();
    }
    return draft;
  }

  /**
   * Creates the items on the board (Azure DevOps or GitHub). Each one is saved as soon as it
   * exists, so a failure halfway keeps it and a retry only creates the rest.
   */
  public async create(id: string, edited?: TicketDraftUpdate): Promise<TicketDraft> {
    const draft = this.editable(id);
    if (edited) {
      // Kept even if a check below fails: they are the person's edits.
      this.applyEdits(draft, edited);
      this.persist(draft);
    }
    for (const item of draft.items) {
      const label = draft.items.length > 1 ? ` (${TICKET_SIDE_LABELS[item.side]})` : "";
      if (!item.title.trim()) {
        throw new TicketDraftError(400, `Falta el título${label}`);
      }
      if (item.kind === "bug" && !item.reproSteps.trim()) {
        throw new TicketDraftError(400, `Faltan los pasos para reproducir el bug${label}`);
      }
      if (item.kind === "story" && !item.description.trim() && !item.acceptanceCriteria.trim()) {
        throw new TicketDraftError(400, `Falta la descripción de la historia${label}`);
      }
    }
    // The board's own tickets reach the assistant's prompt: never publish what looks like a credential.
    const secret = secretIn(draft.items.filter((item) => !item.created));
    if (secret) {
      throw new TicketDraftError(400, `El ticket parece contener ${secret}. Quítalo del texto antes de crearlo.`);
    }
    this.creating.add(id);
    draft.activity = `Creando en ${PROVIDER_LABEL[draft.source]}…`;
    draft.error = undefined;
    this.emitDraft(draft);
    try {
      draft.items = await this.forge.create(
        draft.items,
        (item) => this.forge.target(draft.source, item.repo),
        (items) => {
          draft.items = items;
          if (this.store.get(id)) {
            this.persist(draft);
          }
        },
      );
      draft.status = "created";
      draft.suggestSplit = false;
    } catch (error) {
      draft.status = "error";
      draft.error = `No se pudo crear: ${(error as Error).message}`;
      throw error;
    } finally {
      this.creating.delete(id);
      draft.activity = undefined;
      // Deleted meanwhile: do not bring it back.
      if (this.store.get(id)) {
        this.persist(draft);
      }
    }
    return draft;
  }

  public delete(id: string): void {
    this.get(id);
    this.running.get(id)?.kill();
    this.store.delete(id);
    this.emit("message", { type: "ticketDraftDeleted", id } satisfies ServerMessage);
  }

  /** Kills the running turns (server shutdown). */
  public dispose(): void {
    for (const process of this.running.values()) {
      process.kill();
    }
  }

  // ---------------------------------------------------------------- internals

  private requireRepo(name: string): RepoConfig {
    const repo = this.repos().find((candidate) => candidate.name === name);
    if (!repo) {
      throw new TicketDraftError(400, `Repo desconocido: ${name}`);
    }
    return repo;
  }

  /** A draft that can take a new turn or an edit: not thinking, not creating, not on the board yet. */
  private editable(id: string): TicketDraft {
    const draft = this.get(id);
    if (draft.status === "thinking" || this.running.has(id)) {
      throw new TicketDraftError(409, "Espera a que el asistente termine");
    }
    if (this.creating.has(id)) {
      throw new TicketDraftError(409, "Se está creando en el tablero");
    }
    if (draft.status === "created") {
      throw new TicketDraftError(409, "Este ticket ya está creado");
    }
    return draft;
  }

  private checkCapacity(): void {
    if (this.turns.size >= MAX_RUNNING_TURNS) {
      throw new TicketDraftError(429, `Ya hay ${this.turns.size} asistentes de tickets trabajando: espera a que termine alguno`);
    }
  }

  private queueTurn(draft: TicketDraft, userText: string, turn: Turn): TicketDraft {
    if (draft.messages.length >= MAX_MESSAGES) {
      throw new TicketDraftError(409, "La conversación ya es muy larga: crea el ticket o empieza uno nuevo");
    }
    this.checkCapacity();
    draft.messages.push({ role: "user", text: userText, at: now() });
    draft.status = "thinking";
    draft.error = undefined;
    this.persist(draft);
    void this.runTurn(draft.id, turn);
    return draft;
  }

  private persist(draft: TicketDraft): void {
    draft.updatedAt = now();
    this.store.save(draft);
    this.emitDraft(draft);
  }

  private emitDraft(draft: TicketDraft): void {
    this.emit("message", { type: "ticketDraft", draft } satisfies ServerMessage);
  }

  /** One turn of the assistant; any failure ends up on the draft (status `error`), never thrown. */
  private async runTurn(id: string, turn: Turn): Promise<void> {
    // The same object all along: edits are refused while it thinks, and the session id lands on it.
    const draft = this.store.get(id);
    if (!draft) {
      return;
    }
    this.turns.add(id);
    let options: TicketOptions | undefined;
    try {
      const repo = this.requireRepo(draft.repo);
      const until = await this.quotaUntil(draft.agent.agent);
      if (until) {
        const time = new Date(until * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        throw new Error(`La cuota de ${AGENT_LABELS[draft.agent.agent]} está en pausa hasta las ${time} (Configuración > General). Vuelve a intentarlo entonces.`);
      }
      const first = turn.kind === "first" || !draft.sessionId ? await this.firstPrompt(draft, repo) : undefined;
      options = first?.options;
      const followUp = turn.kind === "first" ? "" : this.replyPrompt(draft, turn);
      let prompt = first ? [first.prompt, followUp].filter(Boolean).join("\n\n---\n\n") : followUp;
      let outcome = await this.runAgent(draft, repo, prompt, draft.sessionId);
      if (!outcome.result && draft.sessionId && !this.stopped.has(id)) {
        // The session could not be resumed (deleted, another machine): start afresh with everything.
        const fresh = await this.firstPrompt(draft, repo);
        options = fresh.options;
        prompt = [fresh.prompt, this.conversationText(draft), followUp].filter(Boolean).join("\n\n---\n\n");
        draft.sessionId = undefined;
        outcome = await this.runAgent(draft, repo, prompt, undefined);
      }
      if (this.stopped.has(id)) {
        draft.messages.push({ role: "assistant", text: "Parado. Puedes seguir escribiendo cuando quieras.", at: now() });
        draft.status = "idle";
      } else {
        this.apply(draft, parseOutput(this.checkOutcome(draft, outcome)), turn, options);
      }
    } catch (error) {
      draft.status = "error";
      draft.error = (error as Error).message;
    } finally {
      this.turns.delete(id);
      this.stopped.delete(id);
      this.running.delete(id);
      if (this.store.get(id)) {
        draft.activity = undefined;
        this.persist(draft);
      }
    }
  }

  private async runAgent(draft: TicketDraft, repo: RepoConfig, prompt: string, resume: string | undefined): Promise<AgentOutcome> {
    const memory = this.settings().memoryEnabled
      ? memoryRunOptions("read", { project: await projectOf(repo.path), step: STEP, runId: draft.id, allowedTools: [] })
      : undefined;
    const process = new AgentProcess({
      agent: draft.agent.agent,
      cwd: repo.path,
      prompt,
      model: draft.agent.model,
      effort: draft.agent.effort,
      tools: TOOLS,
      allowedTools: memory?.allowedTools ?? [],
      disallowedTools: SECRET_READS,
      jsonSchema: JSON.parse(readConfigFile(this.configDir, "schema.json")) as object,
      timeoutMs: this.timeoutMs,
      resume,
      ...(memory ? { mcpConfig: memory.mcpConfig, appendSystemPrompt: memory.appendSystemPrompt } : {}),
    });
    this.running.set(draft.id, process);
    let lastActivity = 0;
    process.on("event", (event) => {
      if (event.kind === "init" && event.sessionId) {
        draft.sessionId = event.sessionId;
      }
      if (event.kind === "toolUse" && Date.now() - lastActivity > ACTIVITY_MS) {
        lastActivity = Date.now();
        draft.activity = describeTool(event);
        this.emitDraft(draft);
      }
    });
    const outcome = await process.run();
    draft.sessionId = outcome.sessionId ?? draft.sessionId;
    return outcome;
  }

  /** The structured answer, or why there is none (in Spanish, for the person). */
  private checkOutcome(draft: TicketDraft, outcome: AgentOutcome): unknown {
    const agent = AGENT_LABELS[draft.agent.agent];
    const result = outcome.result;
    if (outcome.timedOut) {
      throw new Error(`${agent} tardó más de ${Math.round(this.timeoutMs / 60_000)} min en contestar. Vuelve a intentarlo.`);
    }
    if (!result) {
      throw new Error(`${agent} terminó sin contestar (exit ${outcome.exitCode}). ${outcome.stderr.slice(-400)}`.trim());
    }
    if (!result.success) {
      if (result.apiErrorStatus === 429) {
        throw new Error(`Límite de uso de ${agent}: vuelve a intentarlo más tarde.`);
      }
      throw new Error(`${agent} no pudo terminar: ${result.text.slice(0, 400)}`);
    }
    if (result.structuredOutput === undefined || result.structuredOutput === null) {
      throw new Error(`${agent} no devolvió el borrador en el formato esperado. Vuelve a intentarlo.`);
    }
    return result.structuredOutput;
  }

  /** The first prompt: rules, the board, the team's similar tickets, the repo's context and the templates. */
  private async firstPrompt(draft: TicketDraft, repo: RepoConfig): Promise<{ prompt: string; options?: TicketOptions }> {
    let options: TicketOptions | undefined;
    let boardError: string | undefined;
    let samples: TicketSample[] = [];
    let samplesError: string | undefined;
    try {
      const target = await this.forge.target(draft.source, repo.name);
      options = await this.forge.options(target, draft.items[0]?.team);
      samples = await this.forge.similar(target, draft.kind, options.types).catch((error: Error) => {
        samplesError = error.message;
        return [];
      });
    } catch (error) {
      boardError = (error as Error).message;
    }
    const worktree = { repo: repo.name, path: repo.path, repoPath: repo.path } as Worktree;
    const project = await projectOf(repo.path).catch(() => repo.name);
    const prompt = renderTemplate(readConfigFile(this.configDir, "prompt.md"), {
      kind: TICKET_KIND_LABELS[draft.kind],
      repo: repo.name,
      idea: draft.idea,
      board: boardText(draft.source, options, boardError),
      similar: similarText(samples, samplesError ?? boardError),
      repoMap: await repoMap(worktree).catch(() => ""),
      repoNotes: readRepoNotes(repo.name),
      memory: this.settings().memoryEnabled ? readMemory(memoryStore(), project, draft.idea) : "",
      templates: readConfigFile(this.configDir, "templates.md"),
    });
    return { prompt, options };
  }

  private replyPrompt(draft: TicketDraft, turn: Exclude<Turn, { kind: "first" }>): string {
    const items = draft.items.map(({ side, kind, title, description, acceptanceCriteria, reproSteps, tags }) => ({
      side,
      kind,
      title,
      description,
      acceptanceCriteria,
      reproSteps,
      tags,
    }));
    return renderTemplate(readConfigFile(this.configDir, "reply.md"), {
      instruction: turn.kind === "split" ? SPLIT_INSTRUCTION : REPLY_INSTRUCTION,
      answer: turn.kind === "split" ? SPLIT_REQUEST : turn.text,
      items: "```json\n" + JSON.stringify(items, null, 2) + "\n```",
    });
  }

  /** The conversation so far, when a lost session has to be rebuilt. */
  private conversationText(draft: TicketDraft): string {
    const lines = draft.messages.slice(1, -1).map((message) => `**${message.role === "user" ? "Persona" : "Tú"}:** ${message.text}`);
    return lines.length ? `## Conversación hasta ahora\n\n${lines.join("\n\n")}` : "";
  }

  /**
   * Folds the answer into the draft. Each item keeps where it goes (repo, sprint, assignee):
   * that is the person's call. A new item from a split starts where the first one goes. The
   * first turn applies the board defaults the assistant saw in the team's tickets.
   */
  private apply(draft: TicketDraft, output: AssistantOutput, turn: Turn, options: TicketOptions | undefined): void {
    draft.messages.push({
      role: "assistant",
      text: output.message || (output.ready ? "El borrador está listo. Revísalo y créalo cuando quieras." : "He actualizado el borrador."),
      ...(output.questions.length ? { questions: output.questions } : {}),
      at: now(),
    });
    if (output.items.length) {
      const previous = draft.items;
      const used = new Set<string>();
      draft.items = output.items.map((item) => {
        // Same side first; otherwise the next unused one (the assistant changed the side).
        const base =
          previous.find((candidate) => candidate.side === item.side && !used.has(candidate.key)) ??
          previous.find((candidate) => !used.has(candidate.key));
        if (base) {
          used.add(base.key);
          return { ...base, ...item };
        }
        const template = previous[0];
        return { ...emptyItem(item.kind, draft.repo, item.side), ...(template ? { repo: template.repo, iteration: template.iteration, assignee: template.assignee, areaPath: template.areaPath, team: template.team } : {}), ...item };
      });
    }
    if (turn.kind === "first" && options) {
      const current = options.iterations.find((iteration) => iteration.current);
      for (const item of draft.items) {
        item.iteration = output.board.sprint === "current" && current ? current.value : "";
        item.areaPath = draft.source === "azure" && output.board.areaPath && output.board.areaPath !== options.areaPath ? output.board.areaPath : "";
        item.team = options.team;
      }
    }
    draft.suggestSplit = output.suggestSplit && draft.items.length < MAX_ITEMS;
    draft.missing = output.missing;
    draft.ready = output.ready;
    draft.status = "idle";
    draft.error = undefined;
  }
}
