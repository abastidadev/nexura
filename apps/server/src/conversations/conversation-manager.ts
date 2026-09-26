import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  CONVERSATION_EFFORTS,
  CONVERSATION_MODE_LABELS,
  CONVERSATION_MODES,
  type AgentKind,
  type Conversation,
  type ConversationChange,
  type ConversationImage,
  type ConversationSegment,
  type ConversationUpdate,
  type NewConversation,
  type RepoConfig,
  type SavedConversationImage,
  type ServerMessage,
  type TranscriptMessage,
} from "@nexura/shared";
import { loadConfig } from "../config/config-loader.ts";
import { DATA_DIR } from "../config/paths.ts";
import type { AgentCommand } from "../runner/agent-adapter.ts";
import { adapterFor } from "../runner/agents.ts";
import { claudeEnv } from "../runner/claude-process.ts";
import { killPty, shellCommand, spawnPty, type Pty, type PtyOptions } from "../terminal/pty.ts";
import type { ConversationStore } from "./conversation-store.ts";
import { conversationHistory, handoffMarkdown, handoffPrompt, planHandoff } from "./handoff.ts";
import { choosesSessionId, interactiveArgs } from "./interactive-args.ts";
import { findCodexSession, readTranscript, sessionFile, sessionHomes, sessionTitle, type SessionHomes } from "./transcripts.ts";

/** Images the agent CLIs accept, by MIME type, with the extension they are saved with. */
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Output kept per conversation, replayed to a tab that (re)attaches. */
const MAX_BUFFER = 512 * 1024;
const WATCH_MS = 2500;
/** Watch ticks between two reads of the agent's session title (~20 s). */
const TITLE_TICKS = 8;
/** Longer first messages go through a file (the Windows command line tops out at 32 767 characters). */
const MAX_INLINE_PROMPT = 8000;
const DEFAULT_TITLE = "Nueva conversación";
const TITLE_MAX = 80;
const HISTORY_MAX = 400;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export type SpawnPty = (command: string, args: string[], options: PtyOptions) => Pty;

/** What the manager needs from a WebSocket (`ws` or a test double). */
export type ClientSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (raw: unknown) => void): void;
  on(event: "close", listener: () => void): void;
};

type ClientMessage = { t: "i"; d: string } | { t: "r"; c: number; r: number };

type Live = {
  pty?: Pty;
  /** Nexura is closing it (stop, restart, delete): its exit code is Windows' kill status, not the CLI's. */
  stopping?: boolean;
  sockets: Set<ClientSocket>;
  buffer: string;
  cols: number;
  rows: number;
  launchedAt: number;
  ticks: number;
  watch?: ReturnType<typeof setInterval>;
  /** Starts and stops of one conversation run one after the other. */
  queue: Promise<unknown>;
};

export type ConversationManagerOptions = {
  spawn?: SpawnPty;
  homes?: SessionHomes;
  dataDir?: string;
  repos?: () => RepoConfig[];
  /** The binary of an agent's CLI (default: its adapter, which honours NEXURA_*_BIN). */
  command?: (agent: AgentKind) => AgentCommand;
};

type Launch = ConversationChange & { forkOf?: string };

const now = (): string => new Date().toISOString();

function clipTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function quote(arg: string): string {
  return /^[\w.:/\\=@,+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Interactive conversations: the real TUI of claude, codex or copilot (or a shell) in a
 * project folder, in a PTY that lives on the server, so it keeps running while the UI
 * navigates or reloads. Any number of tabs can attach to it (`/cpty?id=`).
 *
 * Changing model, effort or mode restarts the CLI on the same session. Changing agent
 * hands the conversation over: the history is read from the session files of the agents
 * it went through and given to the new one as a file; going back to an agent it already
 * used reopens that agent's session and hands over only what happened since.
 */
export class ConversationManager extends EventEmitter {
  private readonly store: ConversationStore;
  private readonly spawn: SpawnPty;
  private readonly homes: SessionHomes;
  private readonly dataDir: string;
  private readonly repos: () => RepoConfig[];
  private readonly command: (agent: AgentKind) => AgentCommand;
  private readonly live = new Map<string, Live>();

  public constructor(store: ConversationStore, options: ConversationManagerOptions = {}) {
    super();
    this.store = store;
    this.spawn = options.spawn ?? spawnPty;
    this.homes = options.homes ?? sessionHomes();
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.repos = options.repos ?? (() => loadConfig().repos);
    this.command = options.command ?? ((agent) => adapterFor(agent).command());
    // Processes do not outlive the server: what was running when it stopped is stopped now.
    for (const conversation of store.list().filter((candidate) => candidate.status === "running")) {
      conversation.status = "stopped";
      const segment = conversation.segments.at(-1);
      if (segment && !segment.endedAt) {
        segment.endedAt = conversation.updatedAt;
      }
      store.save(conversation);
    }
  }

  public list(): Conversation[] {
    return this.store.list();
  }

  public find(id: string): Conversation | undefined {
    return this.store.get(id);
  }

  public get(id: string): Conversation {
    const conversation = this.store.get(id);
    if (!conversation) {
      throw new Error(`No existe la conversación ${id}`);
    }
    return conversation;
  }

  /** Creates a conversation and starts its process; nothing is kept if the CLI cannot start. */
  public async create(request: NewConversation): Promise<Conversation> {
    const source = request.forkOf ? this.get(request.forkOf) : undefined;
    const kind = request.kind === "shell" ? "shell" : "agent";
    const place = source && !request.repo && !request.cwd ? { cwd: source.cwd, repo: source.repo } : this.place(request);
    const title = request.title?.trim();
    const created = now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: clipTitle(title || (source ? `${source.title} (copia)` : kind === "shell" ? `PowerShell · ${place.repo ?? basename(place.cwd)}` : DEFAULT_TITLE)),
      ...(title ? { titleLocked: true } : {}),
      kind,
      ...(place.repo ? { repo: place.repo } : {}),
      cwd: place.cwd,
      createdAt: created,
      updatedAt: created,
      status: "stopped",
      segments: [],
    };
    this.store.save(conversation);
    try {
      return await this.queue(conversation.id, () =>
        this.launch(conversation.id, {
          agent: request.agent,
          model: request.model,
          effort: request.effort,
          mode: request.mode,
          prompt: request.prompt,
          forkOf: source?.id,
        }),
      );
    } catch (error) {
      this.store.delete(conversation.id);
      this.live.delete(conversation.id);
      throw error;
    }
  }

  /** (Re)starts the process: resumes the session, or hands the history to another agent. */
  public start(id: string, change: ConversationChange = {}): Promise<Conversation> {
    this.get(id);
    return this.queue(id, () => this.launch(id, change));
  }

  public async stop(id: string): Promise<Conversation> {
    this.get(id);
    await this.queue(id, () => this.stopProcess(id));
    return this.get(id);
  }

  public update(id: string, update: ConversationUpdate): Conversation {
    const conversation = this.get(id);
    if (update.title !== undefined) {
      const title = clipTitle(update.title);
      if (!title) {
        throw new Error("El título no puede estar vacío");
      }
      conversation.title = title;
      conversation.titleLocked = true;
    }
    if (update.pinned !== undefined) {
      conversation.pinned = update.pinned || undefined;
    }
    this.persist(conversation);
    return conversation;
  }

  public async delete(id: string): Promise<void> {
    this.get(id);
    await this.queue(id, () => this.stopProcess(id));
    const live = this.live.get(id);
    if (live) {
      clearInterval(live.watch);
      for (const socket of live.sockets) {
        socket.close();
      }
      this.live.delete(id);
    }
    this.store.delete(id);
    rmSync(this.folder(id), { recursive: true, force: true });
    this.broadcast({ type: "conversationDeleted", id });
  }

  /**
   * Saves an image pasted or dropped on the terminal in the conversation's folder (removed
   * with it). Pasting its path is how the CLIs attach an image: claude and codex turn a pasted
   * image path into an attachment, copilot takes it as an `@` file mention.
   */
  public saveImage(id: string, image: ConversationImage): SavedConversationImage {
    const conversation = this.get(id);
    const extension = IMAGE_TYPES[image.mimeType];
    if (!extension) {
      throw new Error(`Formato de imagen no admitido: ${image.mimeType || "desconocido"} (usa PNG, JPEG, GIF o WebP)`);
    }
    const data = Buffer.from(String(image.data ?? ""), "base64");
    if (data.length === 0) {
      throw new Error("La imagen está vacía");
    }
    if (data.length > MAX_IMAGE_BYTES) {
      throw new Error(`La imagen pesa más de ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    const file = join(this.folder(id), "images", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.${extension}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    const quoted = /\s/.test(file) ? `"${file}"` : file;
    const agent = conversation.segments.at(-1)?.agent;
    return { path: file, text: conversation.kind === "agent" && agent === "copilot" ? `@${quoted} ` : quoted };
  }

  /** The whole conversation, across agents, read from their session files (no tokens). */
  public history(id: string): TranscriptMessage[] {
    return conversationHistory(this.get(id), this.read).slice(-HISTORY_MAX);
  }

  /** Connects a terminal tab: replays the recent output, then streams it both ways. */
  public attach(socket: ClientSocket, id: string, cols: number, rows: number): void {
    if (!this.store.get(id)) {
      socket.send("\x1b[31mLa conversación no existe.\x1b[0m\r\n");
      socket.close();
      return;
    }
    const live = this.liveOf(id);
    live.sockets.add(socket);
    if (live.buffer) {
      socket.send(live.buffer);
    }
    this.resize(live, cols, rows, true);
    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (message.t === "i" && typeof message.d === "string") {
        live.pty?.write(message.d);
      } else if (message.t === "r") {
        this.resize(live, message.c, message.r, false);
      }
    });
    socket.on("close", () => live.sockets.delete(socket));
  }

  /** Kills every process (server shutdown, tests). */
  public dispose(): void {
    for (const live of this.live.values()) {
      clearInterval(live.watch);
      try {
        live.pty?.kill();
      } catch {
        // Already exited.
      }
    }
  }

  // ---- process lifecycle

  private async launch(id: string, change: Launch): Promise<Conversation> {
    await this.stopProcess(id);
    // Work on a copy: nothing is saved unless the process starts.
    const conversation = structuredClone(this.get(id));
    if (conversation.kind === "shell") {
      const shell = shellCommand();
      this.spawnProcess(conversation, shell.command, shell.args, [basename(shell.command), ...shell.args], `PowerShell · ${conversation.cwd}`);
      return conversation;
    }

    this.resolveSession(conversation, Date.parse(conversation.segments.at(-1)?.startedAt ?? "") || 0);
    const current = conversation.segments.at(-1);
    const agent = change.agent ?? current?.agent ?? "claude";
    if (!AGENT_KINDS.includes(agent)) {
      throw new Error(`Agente desconocido: ${agent}`);
    }
    const sameAgent = current?.agent === agent;
    const model = (change.model ?? (sameAgent ? current.model : "")).trim();
    const requestedEffort = (change.effort ?? (sameAgent ? current.effort : "")).trim();
    // Effort levels differ per CLI (claude has max, codex minimal): one the new agent lacks falls back to its default.
    const effort = CONVERSATION_EFFORTS[agent].includes(requestedEffort) ? requestedEffort : "";
    const mode = change.mode ?? current?.mode ?? "default";
    if (!CONVERSATION_MODES.includes(mode)) {
      throw new Error(`Modo desconocido: ${mode}`);
    }
    const binary = this.command(agent);
    const settings = { agent, model, effort, mode };
    let prompt = change.prompt?.trim() || undefined;
    const addDirs: string[] = [];
    let sessionId: string | undefined;
    let resume: string | undefined;
    let segment: ConversationSegment;
    const newSessionId = (): string | undefined => (choosesSessionId(agent) ? randomUUID() : undefined);
    const handOver = (source: Conversation, messages: TranscriptMessage[], resumed: boolean): ConversationSegment["handoff"] => {
      const file = join(this.folder(id), `handoff-${conversation.segments.length + 1}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, handoffMarkdown(source, messages, agent));
      addDirs.push(dirname(file));
      const from = [...new Set(messages.map((message) => message.agent))];
      prompt = handoffPrompt(file, from, { resumed, instruction: prompt });
      return { file, messages: messages.length, from };
    };

    if (change.forkOf) {
      const source = this.get(change.forkOf);
      const history = conversationHistory(source, this.read);
      sessionId = newSessionId();
      segment = { ...settings, sessionId, startedAt: now() };
      if (history.length) {
        segment.handoff = handOver(source, history, false);
      }
      conversation.segments.push(segment);
    } else if (!current || change.fresh) {
      sessionId = newSessionId();
      segment = { ...settings, sessionId, startedAt: now() };
      conversation.segments.push(segment);
    } else if (sameAgent) {
      // Same agent (new model, effort or mode, or just resuming): the same session.
      segment = current;
      Object.assign(segment, settings);
      delete segment.endedAt;
      if (segment.sessionId && this.canResume(agent, segment.sessionId, conversation.cwd)) {
        resume = segment.sessionId;
      } else {
        // Nothing was said yet (no session file): start it now, under the same id when the CLI takes one.
        segment.sessionId = choosesSessionId(agent) ? (segment.sessionId ?? newSessionId()) : undefined;
        sessionId = segment.sessionId;
        segment.startedAt = now();
      }
    } else {
      const history = conversationHistory(conversation, this.read);
      let plan = planHandoff(conversation, agent, history);
      if (plan.resume && !this.canResume(agent, plan.resume.sessionId!, conversation.cwd)) {
        plan = { messages: history };
      }
      resume = plan.resume?.sessionId;
      sessionId = resume ? undefined : newSessionId();
      segment = { ...settings, sessionId: resume ?? sessionId, startedAt: now() };
      if (plan.messages.length) {
        segment.handoff = handOver(conversation, plan.messages, Boolean(resume));
      }
      conversation.segments.push(segment);
    }

    if (prompt && prompt.length > MAX_INLINE_PROMPT) {
      const file = join(this.folder(id), `prompt-${conversation.segments.length}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, prompt);
      addDirs.push(dirname(file));
      prompt = `Lee el fichero "${file}" y sigue sus instrucciones.`;
    }
    const args = interactiveArgs({
      ...settings,
      sessionId,
      resume,
      prompt,
      // Codex reads outside the project anyway (its --add-dir is for writing).
      addDirs: agent === "codex" ? [] : [...new Set(addDirs)],
      name: conversation.titleLocked ? conversation.title : undefined,
    });
    const detail = [
      AGENT_LABELS[agent],
      model || "modelo por defecto",
      ...(effort ? [`esfuerzo ${effort}`] : []),
      CONVERSATION_MODE_LABELS[mode],
      resume ? (segment.handoff ? "reanudando con lo nuevo" : "reanudando") : segment.handoff ? "con el historial" : "sesión nueva",
    ].join(" · ");
    this.spawnProcess(conversation, binary.command, [...binary.prefixArgs, ...args], [agent, ...args], detail);
    return conversation;
  }

  private spawnProcess(conversation: Conversation, file: string, args: string[], shown: string[], banner: string): void {
    const live = this.liveOf(conversation.id);
    let pty: Pty;
    try {
      pty = this.spawn(file, args, {
        name: "xterm-256color",
        cols: live.cols,
        rows: live.rows,
        cwd: conversation.cwd,
        env: { ...claudeEnv(), COLORTERM: "truecolor" },
      });
    } catch (error) {
      throw new Error(`No se pudo abrir la terminal: ${error instanceof Error ? error.message : String(error)}`);
    }
    live.pty = pty;
    live.launchedAt = Date.now();
    live.ticks = 0;
    conversation.status = "running";
    delete conversation.exitCode;
    conversation.command = shown.map(quote).join(" ");
    conversation.updatedAt = now();
    this.persist(conversation);
    this.output(live, `${live.buffer ? "\r\n" : ""}\x1b[90m── ${banner} ──\x1b[0m\r\n`);
    pty.onData((data) => this.output(live, data));
    pty.onExit(({ exitCode }) => this.exited(conversation.id, pty, exitCode));
    this.watch(conversation.id, live);
  }

  private exited(id: string, pty: Pty, exitCode: number): void {
    const live = this.live.get(id);
    if (!live || live.pty !== pty) {
      return; // A process that was already replaced.
    }
    live.pty = undefined;
    clearInterval(live.watch);
    const requested = Boolean(live.stopping);
    live.stopping = false;
    const conversation = this.store.get(id);
    if (!conversation) {
      return;
    }
    conversation.status = "stopped";
    if (requested) {
      delete conversation.exitCode;
    } else {
      conversation.exitCode = exitCode;
    }
    const segment = conversation.segments.at(-1);
    if (segment) {
      segment.endedAt = now();
    }
    this.resolveSession(conversation, live.launchedAt);
    this.refreshTitle(conversation);
    conversation.updatedAt = now();
    this.persist(conversation);
    this.output(live, `\r\n\x1b[90m[${requested ? "proceso cerrado" : `proceso terminado · código ${exitCode}`}]\x1b[0m\r\n`);
  }

  private async stopProcess(id: string): Promise<void> {
    const live = this.live.get(id);
    const pty = live?.pty;
    if (!live || !pty) {
      return;
    }
    live.stopping = true;
    await killPty(pty);
    if (live.pty === pty) {
      this.exited(id, pty, -1);
    }
  }

  /** While a process runs: find codex's session id, and follow the title the agent gives the conversation. */
  private watch(id: string, live: Live): void {
    clearInterval(live.watch);
    live.watch = setInterval(() => {
      const conversation = this.store.get(id);
      if (!conversation || !live.pty) {
        return;
      }
      live.ticks++;
      const found = this.resolveSession(conversation, live.launchedAt);
      const titled = live.ticks % TITLE_TICKS === 0 && this.refreshTitle(conversation);
      if (found || titled) {
        this.persist(conversation);
      }
    }, WATCH_MS);
    live.watch.unref?.();
  }

  // ---- sessions and titles

  private readonly read = (agent: AgentKind, sessionId: string, cwd: string): TranscriptMessage[] => readTranscript(agent, sessionId, cwd, this.homes);

  private canResume(agent: AgentKind, sessionId: string, cwd: string): boolean {
    return Boolean(sessionFile(agent, sessionId, cwd, this.homes));
  }

  /** Codex picks its own session id: read it from the rollout it wrote in this folder since `sinceMs`. */
  private resolveSession(conversation: Conversation, sinceMs: number): boolean {
    const segment = conversation.segments.at(-1);
    if (!segment || segment.sessionId || segment.agent !== "codex") {
      return false;
    }
    const claimed = new Set(this.store.list().flatMap((other) => other.segments.map((candidate) => candidate.sessionId ?? "")));
    const found = findCodexSession(conversation.cwd, sinceMs, claimed, this.homes);
    if (found) {
      segment.sessionId = found;
      return true;
    }
    return false;
  }

  /**
   * The title of the session the conversation began with (later ones start with a handoff
   * prompt, so their titles describe that), else its first message. A renamed one keeps its name.
   */
  private refreshTitle(conversation: Conversation): boolean {
    if (conversation.titleLocked || conversation.kind === "shell") {
      return false;
    }
    const first = conversation.segments.find((segment) => segment.sessionId);
    // A fork starts with a handoff prompt: the agent would title the session after it ("Nexura traspaso").
    if (!first || first.handoff) {
      return false;
    }
    let title = sessionTitle(first.agent, first.sessionId!, conversation.cwd, this.homes);
    if (!title && conversation.title === DEFAULT_TITLE) {
      title = this.read(first.agent, first.sessionId!, conversation.cwd).find((message) => message.role === "user")?.text;
    }
    const clipped = title ? clipTitle(title) : "";
    if (clipped && clipped !== conversation.title) {
      conversation.title = clipped;
      return true;
    }
    return false;
  }

  // ---- plumbing

  private place(request: NewConversation): { cwd: string; repo?: string } {
    if (request.repo) {
      const repo = this.repos().find((candidate) => candidate.name === request.repo);
      if (!repo) {
        throw new Error(`Repo desconocido: ${request.repo}`);
      }
      return { cwd: repo.path, repo: repo.name };
    }
    if (request.cwd?.trim()) {
      const cwd = resolve(request.cwd.trim());
      let isDirectory = false;
      try {
        isDirectory = statSync(cwd).isDirectory();
      } catch {
        // Missing.
      }
      if (!isDirectory) {
        throw new Error(`No existe la carpeta: ${cwd}`);
      }
      return { cwd };
    }
    throw new Error("Elige un proyecto o una carpeta");
  }

  private folder(id: string): string {
    return join(this.dataDir, "conversations", id);
  }

  private liveOf(id: string): Live {
    let live = this.live.get(id);
    if (!live) {
      live = { sockets: new Set(), buffer: "", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, launchedAt: 0, ticks: 0, queue: Promise.resolve() };
      this.live.set(id, live);
    }
    return live;
  }

  private queue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const live = this.liveOf(id);
    const next = live.queue.then(task, task);
    live.queue = next.catch(() => undefined);
    return next;
  }

  private output(live: Live, data: string): void {
    live.buffer += data;
    if (live.buffer.length > MAX_BUFFER) {
      // Cut at a line break so the replay does not start in the middle of an escape sequence.
      const cut = live.buffer.length - MAX_BUFFER;
      const newline = live.buffer.indexOf("\n", cut);
      live.buffer = live.buffer.slice(newline >= 0 ? newline + 1 : cut);
    }
    for (const socket of live.sockets) {
      if (socket.readyState === 1) {
        socket.send(data);
      }
    }
  }

  /** A tab that (re)attaches with the same size gets a redraw: a resize makes the TUI repaint. */
  private resize(live: Live, cols: number, rows: number, redraw: boolean): void {
    if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 0)) {
      return;
    }
    const same = cols === live.cols && rows === live.rows;
    live.cols = cols;
    live.rows = rows;
    const pty = live.pty;
    if (!pty) {
      return;
    }
    try {
      if (!same) {
        pty.resize(cols, rows);
      } else if (redraw) {
        pty.resize(cols - 1, rows);
        setTimeout(() => {
          try {
            live.pty?.resize(live.cols, live.rows);
          } catch {
            // Exited meanwhile.
          }
        }, 60).unref?.();
      }
    } catch {
      // Exited meanwhile.
    }
  }

  private persist(conversation: Conversation): void {
    this.store.save(conversation);
    this.broadcast({ type: "conversation", conversation });
  }

  private broadcast(message: ServerMessage): void {
    this.emit("message", message);
  }
}
