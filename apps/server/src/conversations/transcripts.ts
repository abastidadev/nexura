import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentKind, TranscriptMessage } from "@nexura/shared";

type Json = Record<string, any>;

/** Where each CLI keeps its sessions (the same variables the CLIs read). */
export type SessionHomes = Record<AgentKind, string>;

export function sessionHomes(env: NodeJS.ProcessEnv = process.env): SessionHomes {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    codex: env.CODEX_HOME || join(homedir(), ".codex"),
    copilot: env.COPILOT_HOME || join(homedir(), ".copilot"),
  };
}

const TOOL_LABEL_MAX = 120;

/** Claude Code's project folder name for a cwd: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function samePath(a: string, b: string): boolean {
  const normal = (path: string) => resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The session's transcript file, or undefined when the CLI has not written it (yet). */
export function sessionFile(agent: AgentKind, sessionId: string, cwd: string, homes: SessionHomes = sessionHomes()): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) {
    return undefined;
  }
  switch (agent) {
    case "claude": {
      const projects = join(homes.claude, "projects");
      // The folder of the cwd first (its drive letter may be in either case), then any other.
      const slug = claudeProjectSlug(cwd).toLowerCase();
      const dirs = list(projects).sort((a, b) => Number(b.toLowerCase() === slug) - Number(a.toLowerCase() === slug));
      return dirs.map((dir) => join(projects, dir, `${sessionId}.jsonl`)).find((file) => existsSync(file));
    }
    case "codex":
      return codexRollouts(homes).find((file) => file.endsWith(`-${sessionId}.jsonl`));
    case "copilot": {
      const state = join(homes.copilot, "session-state");
      return [join(state, sessionId, "events.jsonl"), join(state, `${sessionId}.jsonl`)].find((file) => existsSync(file));
    }
  }
}

/** Codex rollout files (`sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`), newest day first. */
function codexRollouts(homes: SessionHomes, days = Infinity): string[] {
  const root = join(homes.codex, "sessions");
  const dayDirs: string[] = [];
  for (const year of list(root).sort().reverse()) {
    for (const month of list(join(root, year)).sort().reverse()) {
      for (const day of list(join(root, year, month)).sort().reverse()) {
        dayDirs.push(join(root, year, month, day));
      }
    }
    if (dayDirs.length >= days) {
      break;
    }
  }
  return dayDirs
    .slice(0, days)
    .flatMap((dir) => list(dir).filter((name) => /^rollout-.*\.jsonl$/.test(name)).map((name) => join(dir, name)));
}

function readLines(file: string): Json[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      lines.push(JSON.parse(line) as Json);
    } catch {
      // A line being written right now, or not JSON: skip it.
    }
  }
  return lines;
}

/** "Edit src/app.ts", "Bash npm test"… */
export function toolLabel(name: string, input: unknown): string {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Free-form input (codex custom tools).
    }
  }
  const fields = (value ?? {}) as Json;
  const command = Array.isArray(fields.command) ? fields.command.join(" ") : fields.command;
  const target = [fields.file_path, fields.path, command, fields.cmd, fields.pattern, fields.query, fields.url, fields.description].find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  ) as string | undefined;
  const raw = typeof value === "string" ? value : target;
  const label = raw ? `${name} ${raw.trim().split(/\r?\n/)[0]}` : name;
  return label.length > TOOL_LABEL_MAX ? `${label.slice(0, TOOL_LABEL_MAX - 1)}…` : label;
}

/** Collects messages, merging one turn's assistant pieces (text split by tool calls) into one message. */
class Collector {
  public readonly messages: TranscriptMessage[] = [];
  private readonly agent: AgentKind;
  private readonly sessionId: string;

  public constructor(agent: AgentKind, sessionId: string) {
    this.agent = agent;
    this.sessionId = sessionId;
  }

  public user(text: string, ts: string): void {
    if (text.trim()) {
      this.messages.push({ role: "user", text: text.trim(), agent: this.agent, sessionId: this.sessionId, ts });
    }
  }

  public assistant(text: string, tools: string[], ts: string): void {
    if (!text.trim() && !tools.length) {
      return;
    }
    const last = this.messages.at(-1);
    if (last?.role === "assistant") {
      if (text.trim()) {
        last.text = last.text ? `${last.text}\n\n${text.trim()}` : text.trim();
      }
      if (tools.length) {
        last.tools = [...(last.tools ?? []), ...tools];
      }
      return;
    }
    this.messages.push({ role: "assistant", text: text.trim(), agent: this.agent, sessionId: this.sessionId, ts, ...(tools.length ? { tools } : {}) });
  }
}

/** User entries that are Claude Code bookkeeping, not something the user typed (slash commands, their output, reminders). */
const CLAUDE_NOISE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>/;

function readClaude(lines: Json[], collector: Collector): void {
  for (const line of lines) {
    if (line.isSidechain) {
      continue; // Subagent conversations.
    }
    const ts = String(line.timestamp ?? "");
    const content = line.message?.content;
    if (line.type === "user" && !line.isMeta) {
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block: Json) => block.type === "text").map((block: Json) => block.text).join("\n") : "";
      if (CLAUDE_NOISE.test(text.trim())) {
        continue;
      }
      collector.user(line.isCompactSummary ? `(Resumen de la parte anterior de la conversación)\n${text}` : text, ts);
    } else if (line.type === "assistant" && Array.isArray(content)) {
      const text = content.filter((block: Json) => block.type === "text").map((block: Json) => String(block.text ?? "")).join("\n");
      const tools = content.filter((block: Json) => block.type === "tool_use").map((block: Json) => toolLabel(String(block.name), block.input));
      collector.assistant(text, tools, ts);
    }
  }
}

function readCodex(lines: Json[], collector: Collector): void {
  for (const line of lines) {
    const ts = String(line.timestamp ?? "");
    const payload = (line.payload ?? {}) as Json;
    if (line.type === "event_msg") {
      if (payload.type === "user_message") {
        collector.user(String(payload.message ?? ""), ts);
      } else if (payload.type === "agent_message") {
        collector.assistant(String(payload.message ?? ""), [], ts);
      } else if (payload.type === "patch_apply_end" && payload.changes && typeof payload.changes === "object") {
        collector.assistant("", [`Edit ${Object.keys(payload.changes as Json).join(", ")}`], ts);
      }
    } else if (line.type === "response_item") {
      if (payload.type === "function_call") {
        collector.assistant("", [toolLabel(String(payload.name), payload.arguments)], ts);
      } else if (payload.type === "custom_tool_call") {
        collector.assistant("", [toolLabel(String(payload.name), payload.input)], ts);
      } else if (payload.type === "local_shell_call") {
        collector.assistant("", [toolLabel("shell", payload.action)], ts);
      }
    }
  }
}

function readCopilot(lines: Json[], collector: Collector): void {
  for (const line of lines) {
    const ts = String(line.timestamp ?? "");
    const data = (line.data ?? {}) as Json;
    if (line.type === "user.message") {
      collector.user(String(data.content ?? ""), ts);
    } else if (line.type === "assistant.message") {
      const tools = ((data.toolRequests ?? []) as Json[]).map((request) => toolLabel(String(request.name ?? "tool"), request.arguments));
      collector.assistant(String(data.content ?? ""), tools, ts);
    }
  }
}

/** The user and assistant messages of one agent session (empty when its file is missing). */
export function readTranscript(agent: AgentKind, sessionId: string, cwd: string, homes: SessionHomes = sessionHomes()): TranscriptMessage[] {
  const file = sessionFile(agent, sessionId, cwd, homes);
  if (!file) {
    return [];
  }
  const collector = new Collector(agent, sessionId);
  const lines = readLines(file);
  if (agent === "claude") {
    readClaude(lines, collector);
  } else if (agent === "codex") {
    readCodex(lines, collector);
  } else {
    readCopilot(lines, collector);
  }
  return collector.messages;
}

/** The title the agent gave the session (claude's ai-title or /rename, codex's thread name), if any. */
export function sessionTitle(agent: AgentKind, sessionId: string, cwd: string, homes: SessionHomes = sessionHomes()): string | undefined {
  if (agent === "claude") {
    const file = sessionFile(agent, sessionId, cwd, homes);
    let title: string | undefined;
    for (const line of file ? readLines(file) : []) {
      if (line.type === "custom-title" && line.customTitle) {
        title = String(line.customTitle);
      } else if (line.type === "ai-title" && line.aiTitle) {
        title = String(line.aiTitle);
      }
    }
    return title;
  }
  if (agent === "codex") {
    const entry = readLines(join(homes.codex, "session_index.jsonl")).findLast((line) => line.id === sessionId && line.thread_name);
    return entry ? String(entry.thread_name) : undefined;
  }
  return undefined;
}

const FIRST_LINE_MAX = 1 << 20;

/** First line of a file (codex's session_meta), read without loading the whole rollout. */
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(FIRST_LINE_MAX, statSync(file).size));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    return end >= 0 ? text.slice(0, end) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The codex session an interactive `codex` started in `cwd` after `sinceMs`: codex picks its
 * own id, so it is read from the first rollout of that folder created since then that no
 * other conversation claims. Undefined until codex writes it (on the first message).
 */
export function findCodexSession(cwd: string, sinceMs: number, claimed: ReadonlySet<string>, homes: SessionHomes = sessionHomes()): string | undefined {
  const candidates = codexRollouts(homes, 2)
    .map((file) => {
      try {
        const stat = statSync(file);
        return { file, created: stat.birthtimeMs || stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { file: string; created: number } => Boolean(entry) && entry!.created >= sinceMs - 2000)
    .sort((a, b) => a.created - b.created);
  for (const { file } of candidates) {
    let meta: Json;
    try {
      meta = JSON.parse(firstLine(file)) as Json;
    } catch {
      continue;
    }
    const payload = (meta.payload ?? {}) as Json;
    const id = String(payload.id ?? payload.session_id ?? /-([0-9a-f-]{36})\.jsonl$/.exec(basename(file))?.[1] ?? "");
    if (meta.type === "session_meta" && id && !claimed.has(id) && typeof payload.cwd === "string" && samePath(payload.cwd, cwd)) {
      return id;
    }
  }
  return undefined;
}
