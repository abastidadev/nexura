import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AI_SETUP_KINDS,
  AI_SETUP_MODES,
  AI_SETUP_MODE_LABELS,
  AI_SETUP_PRIORITIES,
  AI_SETUP_SCOPES,
  DEFAULT_AI_SETUP_AGENT,
  type AgentKind,
  type AiSetupAgent,
  type AiSetupAssessment,
  type AiSetupFile,
  type AiSetupKind,
  type AiSetupPlacement,
  type AiSetupPriority,
  type AiSetupQuestion,
  type AiSetupRepo,
  type AiSetupScope,
  type AiSetupSession,
  type AiSetupUpdate,
  type ClaudeInventory,
  type NewAiSetupSession,
  type NexuraEvent,
  type NexuraSettings,
  type RepoConfig,
  type ServerMessage,
  type Worktree,
} from "@nexura/shared";
import { EFFORTS, isValidModel, loadConfig } from "../config/config-loader.ts";
import { CONFIG_DIR } from "../config/paths.ts";
import { memoryRunOptions, memoryStore, readMemory } from "../memory/memory.ts";
import { projectOf } from "../memory/memory-store.ts";
import { renderTemplate } from "../prompt/render.ts";
import { AgentProcess, type AgentOutcome } from "../runner/agent-process.ts";
import { SECRET_READS, secretInText } from "../tickets/ticket-assistant.ts";
import { claudeInventory } from "../workspace/claude-inventory.ts";
import { git, isAgentConfigPath } from "../workspace/git.ts";
import { readRepoNotes, repoMap } from "../workspace/repo-context.ts";
import type { AiSetupStore } from "./ai-setup-store.ts";
import { MAX_FILE_CHARS, checkSetupFile, checkSetupPath, diskHash, isToolkitRepo, SetupPathError, writeSetupFile } from "./setup-files.ts";

const STEP = "aiSetup";
/** Read-only: the assistant proposes, Nexura writes what the person approves. No Bash, no MCP but the memory. */
const TOOLS = ["Read", "Glob", "Grep"];
const TURN_TIMEOUT_MS = 8 * 60_000;
const ACTIVITY_MS = 800;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 4;
const MAX_RECOMMENDATIONS = 12;
const MAX_FILES = 12;
const MAX_IDEA = 20_000;
const MAX_AI_FILES = 80;
/** Turns running at once across all sessions (each one is an agent process spending quota). */
const MAX_RUNNING_TURNS = 3;
const MAX_MESSAGES = 60;
const ASSESS_REQUEST = "Valora cómo está preparado este repo para trabajar con agentes y recomiéndame qué añadir.";
const PROJECT_PLACEMENT =
  "Este repo no es el ai-toolkit: escribe igualmente los ficheros en `.claude/` del repo para que la persona pueda usarlos ya, y explica en `message` que lo ideal es llevarlo al plugin del ai-toolkit (Nexura le ofrece hacerlo allí).";
const TOOLKIT_PLACEMENT =
  "Este repo **es** un marketplace de plugins (el ai-toolkit o uno como él): escribe la pieza dentro de `plugins/<plugin>/` con su eval de disparo, sube la `version` del `plugin.json`, añade la línea al `CHANGELOG.md` y actualiza la tabla del `README.md` si añades una skill o un agente.";

/** A request the session cannot take right now; `status` is the HTTP status the API answers with. */
export class AiSetupError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The assistant's structured answer (config/ai-setup/schema.json). */
type AssistantOutput = {
  message: string;
  questions: AiSetupQuestion[];
  assessment: Omit<AiSetupAssessment, "recommendations"> & { recommendations: Omit<AiSetupAssessment["recommendations"][number], "key">[] };
  placement: AiSetupPlacement;
  files: Pick<AiSetupFile, "path" | "kind" | "purpose" | "content">[];
  missing: string[];
  ready: boolean;
};

type Turn = { kind: "first" } | { kind: "reply"; text: string };

export type AiSetupOptions = {
  repos?: () => RepoConfig[];
  settings?: () => Pick<NexuraSettings, "memoryEnabled">;
  /** Epoch seconds until which the agent's quota is paused (Configuración > General), if it is. */
  quotaUntil?: (agent: AgentKind) => Promise<number | undefined>;
  configDir?: string;
  timeoutMs?: number;
};

const now = (): string => new Date().toISOString();
const text = (value: unknown, max = 50_000): string => (typeof value === "string" ? value.slice(0, max) : "");
const texts = (value: unknown, max: number, chars = 500): string[] =>
  Array.isArray(value) ? value.map((entry) => text(entry, chars).trim()).filter(Boolean).slice(0, max) : [];
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);

/** What the assistant does, in plain words. */
function describeTool(event: Extract<NexuraEvent, { kind: "toolUse" }>): string {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const detail = String(input["file_path"] ?? input["path"] ?? input["pattern"] ?? "");
  if (event.name.startsWith("mcp__")) {
    return "Consultando la memoria del proyecto…";
  }
  if (event.name === "Read") {
    return `Leyendo ${basename(detail)}`;
  }
  return detail ? `Buscando: ${detail.slice(0, 60)}` : "Revisando el repo…";
}

/** The inventory as a short list per kind, with where each piece comes from. */
export function inventoryText(inventory: ClaudeInventory | undefined): string {
  if (!inventory) {
    return "No se pudo leer.";
  }
  const line = (name: string, source: string, detail: string): string => `- \`${name}\` (${source})${detail ? `: ${detail.slice(0, 160)}` : ""}`;
  const block = (title: string, lines: string[]): string => `**${title}**\n${lines.length ? lines.join("\n") : "- ninguno"}`;
  return [
    block("Skills", inventory.skills.map((skill) => line(skill.name, skill.source, skill.description))),
    block("Agentes", inventory.agents.map((agent) => line(agent.name, agent.source, agent.description))),
    block("Servidores MCP", inventory.mcpServers.map((server) => line(server.name, server.source, `${server.transport}${server.enabled ? "" : ", sin aprobar"}`))),
  ].join("\n\n");
}

/** The agent configuration files in the repo (tracked or not, ignored ones aside), with their size. */
async function aiFilesText(repoPath: string, toolkit: boolean): Promise<string> {
  const listed = await git(repoPath, ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"]).catch(() => "");
  const files = listed
    .split(/\r?\n/)
    .filter((file) => file && (isAgentConfigPath(file) || (toolkit && /^(plugins\/[^/]+\/\.claude-plugin\/|\.claude-plugin\/)/.test(file))));
  if (!files.length) {
    return "Ninguno: el repo no tiene CLAUDE.md, AGENTS.md, .claude/ ni .mcp.json.";
  }
  const sized = files.slice(0, MAX_AI_FILES).map((file) => {
    let lines = "";
    try {
      lines = statSync(join(repoPath, file)).size > 0 ? ` (${readFileSync(join(repoPath, file), "utf8").split("\n").length} líneas)` : " (vacío)";
    } catch {
      // Listed but gone: say nothing about its size.
    }
    return `- ${file}${lines}`;
  });
  return [...sized, files.length > MAX_AI_FILES ? `- … y ${files.length - MAX_AI_FILES} más` : ""].filter(Boolean).join("\n");
}

function readConfigFile(configDir: string, name: string): string {
  const file = join(configDir, "ai-setup", name);
  if (!existsSync(file)) {
    throw new Error(`Falta ${file}`);
  }
  return readFileSync(file, "utf8");
}

/** Checks the assistant's answer against the schema's shape, so a sloppy agent cannot break the session. */
function parseOutput(value: unknown): AssistantOutput {
  const output = (typeof value === "string" ? JSON.parse(value) : value) as Partial<AssistantOutput> | undefined;
  if (!output || typeof output !== "object") {
    throw new Error("El asistente no devolvió la respuesta en el formato esperado");
  }
  const assessment = (output.assessment ?? {}) as Partial<AssistantOutput["assessment"]>;
  return {
    message: text(output.message, 4000).trim(),
    questions: (Array.isArray(output.questions) ? output.questions : [])
      .map((question) => ({ text: text(question?.text, 500).trim(), options: texts(question?.options, MAX_OPTIONS) }))
      .filter((question) => question.text)
      .slice(0, MAX_QUESTIONS),
    assessment: {
      profile: text(assessment.profile, 2000).trim(),
      strengths: texts(assessment.strengths, 10, 400),
      issues: texts(assessment.issues, 10, 600),
      recommendations: (Array.isArray(assessment.recommendations) ? assessment.recommendations : [])
        .map((entry) => ({
          kind: oneOf<AiSetupKind>(entry?.kind, AI_SETUP_KINDS, "skill"),
          scope: oneOf<AiSetupScope>(entry?.scope, AI_SETUP_SCOPES, "project"),
          priority: oneOf<AiSetupPriority>(entry?.priority, AI_SETUP_PRIORITIES, "medium"),
          title: text(entry?.title, 200).trim(),
          why: text(entry?.why, 1500).trim(),
          command: text(entry?.command, 500).trim(),
          createPrompt: text(entry?.createPrompt, 3000).trim(),
        }))
        .filter((entry) => entry.title)
        .slice(0, MAX_RECOMMENDATIONS),
    },
    placement: {
      scope: oneOf<AiSetupScope>(output.placement?.scope, AI_SETUP_SCOPES, "project"),
      plugin: text(output.placement?.plugin, 100).trim(),
      reason: text(output.placement?.reason, 1000).trim(),
    },
    files: (Array.isArray(output.files) ? output.files : [])
      .map((file) => ({
        path: text(file?.path, 300).trim(),
        kind: oneOf<AiSetupKind>(file?.kind, AI_SETUP_KINDS, "skill"),
        purpose: text(file?.purpose, 300).trim(),
        content: text(file?.content, MAX_FILE_CHARS),
      }))
      .filter((file) => file.path && file.content.trim())
      .slice(0, MAX_FILES),
    missing: texts(output.missing, 10),
    ready: Boolean(output.ready),
  };
}

/**
 * The Setup IA section: a headless agent, read-only on the repo, that assesses how the project
 * is set up for coding agents or writes the skill, agent, hook, MCP server or instructions the
 * person asks for, following the ai-toolkit's rules. Each turn is one agent run with the JSON
 * schema; the next turns resume its session. Nothing reaches the repo until the person presses
 * «Escribir en el repo» (`apply`), and then the server writes it, only agent configuration paths.
 */
export class AiSetupAssistant extends EventEmitter {
  private readonly store: AiSetupStore;
  private readonly repos: () => RepoConfig[];
  private readonly settings: () => Pick<NexuraSettings, "memoryEnabled">;
  private readonly quotaUntil: (agent: AgentKind) => Promise<number | undefined>;
  private readonly configDir: string;
  private readonly timeoutMs: number;
  private readonly running = new Map<string, AgentProcess>();
  private readonly stopped = new Set<string>();
  private readonly turns = new Set<string>();

  public constructor(store: AiSetupStore, options: AiSetupOptions = {}) {
    super();
    this.store = store;
    this.repos = options.repos ?? (() => loadConfig().repos);
    this.settings = options.settings ?? (() => ({ memoryEnabled: true }));
    this.quotaUntil = options.quotaUntil ?? (async () => undefined);
    this.configDir = options.configDir ?? CONFIG_DIR;
    this.timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
    // Agent processes do not outlive the server: a turn that was running is lost.
    for (const session of store.list().filter((candidate) => candidate.status === "thinking")) {
      session.status = "error";
      session.error = "Se interrumpió al reiniciar Nexura: vuelve a enviar tu mensaje.";
      store.save(session);
    }
  }

  public list(): AiSetupSession[] {
    return this.store.list();
  }

  public get(id: string): AiSetupSession {
    const session = this.store.get(id);
    if (!session) {
      throw new AiSetupError(404, `No existe la sesión ${id}`);
    }
    return session;
  }

  /** The configured repos, and which of them are plugin marketplaces (zero tokens). */
  public repoKinds(): AiSetupRepo[] {
    return this.repos().map((repo) => ({ name: repo.name, toolkit: isToolkitRepo(repo.path) }));
  }

  /** Creates the session and runs the first turn in the background (progress over the WebSocket). */
  public start(request: NewAiSetupSession): AiSetupSession {
    const repo = this.requireRepo(request.repo);
    if (!AI_SETUP_MODES.includes(request.mode)) {
      throw new AiSetupError(400, `Modo desconocido: ${request.mode}`);
    }
    const idea = text(request.idea, MAX_IDEA).trim();
    if (request.mode === "create" && !idea) {
      throw new AiSetupError(400, "Cuenta qué quieres crear");
    }
    const agent: AiSetupAgent = { ...DEFAULT_AI_SETUP_AGENT, ...request.agent };
    if (!AGENT_KINDS.includes(agent.agent)) {
      throw new AiSetupError(400, `Agente desconocido: ${agent.agent}`);
    }
    // Model and effort go to the CLI as arguments: the same checks as a step's.
    if (!isValidModel(agent.agent, agent.model) || !EFFORTS.has(agent.effort)) {
      throw new AiSetupError(400, `Modelo o esfuerzo no válido para ${AGENT_LABELS[agent.agent]}: ${agent.model} / ${agent.effort}`);
    }
    this.checkCapacity();
    const at = now();
    const session: AiSetupSession = {
      id: randomUUID(),
      repo: repo.name,
      mode: request.mode,
      idea,
      agent,
      messages: [{ role: "user", text: idea || ASSESS_REQUEST, at }],
      files: [],
      missing: [],
      ready: false,
      status: "thinking",
      createdAt: at,
      updatedAt: at,
    };
    this.persist(session);
    void this.runTurn(session.id, { kind: "first" });
    return session;
  }

  /** The person's answer: the next turn, on the same session, with their latest edits applied first. */
  public reply(id: string, answer: string, edited?: AiSetupUpdate): AiSetupSession {
    const session = this.editable(id);
    const reply = text(answer, MAX_IDEA).trim();
    if (!reply) {
      throw new AiSetupError(400, "Escribe un mensaje");
    }
    this.applyEdits(session, edited);
    if (session.messages.length >= MAX_MESSAGES) {
      throw new AiSetupError(409, "La conversación ya es muy larga: empieza una sesión nueva");
    }
    this.checkCapacity();
    session.messages.push({ role: "user", text: reply, at: now() });
    session.status = "thinking";
    session.error = undefined;
    this.persist(session);
    void this.runTurn(session.id, { kind: "reply", text: reply });
    return session;
  }

  /** Saves what the person edited by hand: the files' paths and contents. */
  public update(id: string, update: AiSetupUpdate): AiSetupSession {
    const session = this.editable(id);
    this.applyEdits(session, update);
    this.persist(session);
    return session;
  }

  /** Drops a proposed file (not yet written) from the session. */
  public removeFile(id: string, key: string): AiSetupSession {
    const session = this.editable(id);
    const file = session.files.find((candidate) => candidate.key === key);
    if (!file) {
      throw new AiSetupError(404, "Ese fichero ya no está en la propuesta");
    }
    if (file.written) {
      throw new AiSetupError(409, `${file.path} ya está escrito en el repo`);
    }
    session.files = session.files.filter((candidate) => candidate.key !== key);
    this.persist(session);
    return session;
  }

  private applyEdits(session: AiSetupSession, update: AiSetupUpdate | undefined): void {
    if (!update || !Array.isArray(update.files)) {
      return;
    }
    const repo = this.requireRepo(session.repo);
    for (const edit of update.files) {
      // Only the session's own files: an edit never adds one, and a written one stays as it is.
      const file = session.files.find((candidate) => candidate.key === edit?.key);
      if (!file || file.written) {
        continue;
      }
      const path = text(edit.path, 300).trim().replace(/\\/g, "/");
      if (path && path !== file.path) {
        file.path = path;
        // A new place: what is there now is what the person is about to overwrite.
        file.baseHash = this.safeHash(repo.path, path);
      }
      file.content = text(edit.content, MAX_FILE_CHARS);
    }
  }

  /** Stops the running turn; the session keeps what it had. */
  public cancel(id: string): AiSetupSession {
    const session = this.get(id);
    const process = this.running.get(id);
    if (process) {
      this.stopped.add(id);
      process.kill();
    }
    return session;
  }

  /**
   * Writes the proposed files into the repo's working tree (no commit). Every file is checked
   * first (agent configuration path, inside the repo, valid JSON, no credential, unchanged on
   * disk since it was read), so a bad one stops them all.
   */
  public apply(id: string, edited?: AiSetupUpdate): AiSetupSession {
    const session = this.editable(id);
    if (edited) {
      // Kept even if a check below fails: they are the person's edits.
      this.applyEdits(session, edited);
      this.persist(session);
    }
    const pending = session.files.filter((file) => !file.written);
    if (!pending.length) {
      throw new AiSetupError(400, "No hay ficheros que escribir");
    }
    const repo = this.requireRepo(session.repo);
    const toolkit = isToolkitRepo(repo.path);
    const paths = new Set<string>();
    const checked = pending.map((file) => {
      const path = this.setupCall(() => checkSetupFile(repo.path, file, toolkit, secretInText));
      if (paths.has(path.toLowerCase())) {
        throw new AiSetupError(400, `${path} aparece dos veces`);
      }
      paths.add(path.toLowerCase());
      return { file, path };
    });
    try {
      for (const { file, path } of checked) {
        writeSetupFile(repo.path, path, file.content);
        file.path = path;
        file.written = true;
      }
      session.status = "applied";
      session.error = undefined;
    } catch (error) {
      session.status = "error";
      session.error = `No se pudo escribir: ${(error as Error).message}`;
      throw new AiSetupError(500, session.error);
    } finally {
      this.persist(session);
    }
    return session;
  }

  public delete(id: string): void {
    this.get(id);
    this.running.get(id)?.kill();
    this.store.delete(id);
    this.emit("message", { type: "aiSetupDeleted", id } satisfies ServerMessage);
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
      throw new AiSetupError(400, `Repo desconocido: ${name}`);
    }
    return repo;
  }

  private setupCall<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      throw error instanceof SetupPathError ? new AiSetupError(error.status, error.message) : error;
    }
  }

  /** The hash of an allowed path; a path Setup IA cannot write reads as new (the write refuses it later). */
  private safeHash(repoPath: string, path: string): string {
    try {
      return diskHash(repoPath, checkSetupPath(path, isToolkitRepo(repoPath)));
    } catch {
      return "";
    }
  }

  /** A session that can take a new turn or an edit: not thinking, not written yet. */
  private editable(id: string): AiSetupSession {
    const session = this.get(id);
    if (session.status === "thinking" || this.running.has(id)) {
      throw new AiSetupError(409, "Espera a que el asistente termine");
    }
    if (session.status === "applied") {
      throw new AiSetupError(409, "Estos ficheros ya están escritos: empieza otra sesión para seguir");
    }
    return session;
  }

  private checkCapacity(): void {
    if (this.turns.size >= MAX_RUNNING_TURNS) {
      throw new AiSetupError(429, `Ya hay ${this.turns.size} asistentes de Setup IA trabajando: espera a que termine alguno`);
    }
  }

  private persist(session: AiSetupSession): void {
    session.updatedAt = now();
    this.store.save(session);
    this.emitSession(session);
  }

  private emitSession(session: AiSetupSession): void {
    this.emit("message", { type: "aiSetup", session } satisfies ServerMessage);
  }

  /** One turn of the assistant; any failure ends up on the session (status `error`), never thrown. */
  private async runTurn(id: string, turn: Turn): Promise<void> {
    const session = this.store.get(id);
    if (!session) {
      return;
    }
    this.turns.add(id);
    try {
      const repo = this.requireRepo(session.repo);
      const until = await this.quotaUntil(session.agent.agent);
      if (until) {
        const time = new Date(until * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        throw new Error(`La cuota de ${AGENT_LABELS[session.agent.agent]} está en pausa hasta las ${time} (Configuración > General). Vuelve a intentarlo entonces.`);
      }
      const followUp = turn.kind === "first" ? "" : this.replyPrompt(session, turn.text);
      let prompt = turn.kind === "first" || !session.sessionId ? [await this.firstPrompt(session, repo), followUp].filter(Boolean).join("\n\n---\n\n") : followUp;
      let outcome = await this.runAgent(session, repo, prompt, session.sessionId);
      if (!outcome.result && session.sessionId && !this.stopped.has(id)) {
        // The session could not be resumed (deleted, another machine): start afresh with everything.
        prompt = [await this.firstPrompt(session, repo), this.conversationText(session), followUp].filter(Boolean).join("\n\n---\n\n");
        session.sessionId = undefined;
        outcome = await this.runAgent(session, repo, prompt, undefined);
      }
      if (this.stopped.has(id)) {
        session.messages.push({ role: "assistant", text: "Parado. Puedes seguir escribiendo cuando quieras.", at: now() });
        session.status = "idle";
      } else {
        this.fold(session, repo, parseOutput(this.checkOutcome(session, outcome)));
      }
    } catch (error) {
      session.status = "error";
      session.error = (error as Error).message;
    } finally {
      this.turns.delete(id);
      this.stopped.delete(id);
      this.running.delete(id);
      if (this.store.get(id)) {
        session.activity = undefined;
        this.persist(session);
      }
    }
  }

  private async runAgent(session: AiSetupSession, repo: RepoConfig, prompt: string, resume: string | undefined): Promise<AgentOutcome> {
    const memory = this.settings().memoryEnabled
      ? memoryRunOptions("read", { project: await projectOf(repo.path), step: STEP, runId: session.id, allowedTools: [] })
      : undefined;
    const process = new AgentProcess({
      agent: session.agent.agent,
      cwd: repo.path,
      prompt,
      model: session.agent.model,
      effort: session.agent.effort,
      tools: TOOLS,
      allowedTools: memory?.allowedTools ?? [],
      disallowedTools: SECRET_READS,
      jsonSchema: JSON.parse(readConfigFile(this.configDir, "schema.json")) as object,
      timeoutMs: this.timeoutMs,
      resume,
      ...(memory ? { mcpConfig: memory.mcpConfig, appendSystemPrompt: memory.appendSystemPrompt } : {}),
    });
    this.running.set(session.id, process);
    let lastActivity = 0;
    process.on("event", (event) => {
      if (event.kind === "init" && event.sessionId) {
        session.sessionId = event.sessionId;
      }
      if (event.kind === "toolUse" && Date.now() - lastActivity > ACTIVITY_MS) {
        lastActivity = Date.now();
        session.activity = describeTool(event);
        this.emitSession(session);
      }
    });
    const outcome = await process.run();
    session.sessionId = outcome.sessionId ?? session.sessionId;
    return outcome;
  }

  /** The structured answer, or why there is none (in Spanish, for the person). */
  private checkOutcome(session: AiSetupSession, outcome: AgentOutcome): unknown {
    const agent = AGENT_LABELS[session.agent.agent];
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
      throw new Error(`${agent} no devolvió la respuesta en el formato esperado. Vuelve a intentarlo.`);
    }
    return result.structuredOutput;
  }

  /** The first prompt: the mode's rules, what the repo has, the toolkit's catalogue, rules and templates. */
  private async firstPrompt(session: AiSetupSession, repo: RepoConfig): Promise<string> {
    const toolkit = isToolkitRepo(repo.path);
    const worktree = { repo: repo.name, path: repo.path, repoPath: repo.path } as Worktree;
    const project = await projectOf(repo.path).catch(() => repo.name);
    let inventory: ClaudeInventory | undefined;
    try {
      inventory = claudeInventory(repo.path);
    } catch {
      inventory = undefined;
    }
    const vars = {
      repo: repo.name,
      mode: AI_SETUP_MODE_LABELS[session.mode],
      toolkitNote: toolkit ? " (es un marketplace de plugins: el ai-toolkit o uno como él)." : ".",
      placementRule: toolkit ? TOOLKIT_PLACEMENT : PROJECT_PLACEMENT,
      toolkitPaths: toolkit ? "; en este repo también `plugins/**`, `.claude-plugin/**`, `CHANGELOG.md` y `README.md`." : ".",
    };
    const modeRules = renderTemplate(readConfigFile(this.configDir, session.mode === "assess" ? "assess.md" : "create.md"), vars);
    return renderTemplate(readConfigFile(this.configDir, "prompt.md"), {
      ...vars,
      modeRules,
      idea: session.idea || ASSESS_REQUEST,
      inventory: inventoryText(inventory),
      aiFiles: await aiFilesText(repo.path, toolkit),
      repoMap: await repoMap(worktree).catch(() => ""),
      repoNotes: readRepoNotes(repo.name),
      memory: this.settings().memoryEnabled ? readMemory(memoryStore(), project, session.idea || "claude skills agents hooks mcp") : "",
      toolkit: readConfigFile(this.configDir, "toolkit.md"),
      guide: readConfigFile(this.configDir, "guide.md"),
      templates: readConfigFile(this.configDir, "templates.md"),
    });
  }

  private replyPrompt(session: AiSetupSession, answer: string): string {
    const files = session.files.map(({ path, kind, purpose, content, written }) => ({ path, kind, purpose, content, ...(written ? { written } : {}) }));
    return renderTemplate(readConfigFile(this.configDir, "reply.md"), {
      mode: AI_SETUP_MODE_LABELS[session.mode],
      instruction:
        session.mode === "assess"
          ? "Devuelve la valoración entera otra vez (actualizada con lo que te dice). Si te pide que escribas algo, explícale que pulse «Crear» en la recomendación."
          : "Devuelve siempre **todos** los ficheros, completos y en el mismo orden.",
      answer,
      files: files.length ? "```json\n" + JSON.stringify(files, null, 2) + "\n```" : "",
    });
  }

  /** The conversation so far, when a lost session has to be rebuilt. */
  private conversationText(session: AiSetupSession): string {
    const lines = session.messages.slice(1, -1).map((message) => `**${message.role === "user" ? "Persona" : "Tú"}:** ${message.text}`);
    return lines.length ? `## Conversación hasta ahora\n\n${lines.join("\n\n")}` : "";
  }

  /**
   * Folds the answer into the session. A file keeps its key when the assistant returns the same
   * path, and its `baseHash` is the version on disk now: what the person reviews is what gets
   * replaced. Written files are never dropped.
   */
  private fold(session: AiSetupSession, repo: RepoConfig, output: AssistantOutput): void {
    session.messages.push({
      role: "assistant",
      text: output.message || (output.ready ? "Listo. Revísalo y escríbelo cuando quieras." : "He actualizado la propuesta."),
      ...(output.questions.length ? { questions: output.questions } : {}),
      at: now(),
    });
    if (session.mode === "assess") {
      const previous = session.assessment?.recommendations ?? [];
      session.assessment = {
        ...output.assessment,
        recommendations: output.assessment.recommendations.map((entry) => ({
          key: previous.find((candidate) => candidate.title === entry.title)?.key ?? randomUUID(),
          ...entry,
        })),
      };
    } else {
      session.placement = output.placement;
      const written = session.files.filter((file) => file.written);
      const proposed = output.files
        .filter((file) => !written.some((done) => done.path === file.path))
        .map((file): AiSetupFile => {
          const path = file.path.replace(/\\/g, "/").replace(/^\.\//, "");
          const previous = session.files.find((candidate) => candidate.path === path);
          return { key: previous?.key ?? randomUUID(), ...file, path, baseHash: this.safeHash(repo.path, path) };
        });
      session.files = [...written, ...proposed];
    }
    session.missing = output.missing;
    session.ready = output.ready;
    session.status = "idle";
    session.error = undefined;
  }
}
