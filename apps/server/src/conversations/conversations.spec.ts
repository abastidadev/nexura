import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentKind, Conversation, TranscriptMessage } from "@nexura/shared";
import type { Pty, PtyOptions } from "../terminal/pty.ts";
import { ConversationManager, type ClientSocket } from "./conversation-manager.ts";
import { ConversationStore } from "./conversation-store.ts";
import { conversationHistory, HANDOFF_MARKER, handoffMarkdown, handoffPrompt, planHandoff } from "./handoff.ts";
import { interactiveArgs } from "./interactive-args.ts";
import { claudeProjectSlug, findCodexSession, readTranscript, sessionTitle, type SessionHomes } from "./transcripts.ts";

let root: string;
let homes: SessionHomes;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nexura-conv-"));
  homes = { claude: join(root, "claude"), codex: join(root, "codex"), copilot: join(root, "copilot") };
  cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const line = (file: string, value: object): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + "\n");
};

/** What each real CLI writes for a user message and its answer. */
function say(agent: AgentKind, sessionId: string, user: string, reply: string, ts: string): void {
  if (agent === "claude") {
    const file = join(homes.claude, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
    line(file, { type: "user", message: { role: "user", content: user }, timestamp: ts, sessionId });
    line(file, { type: "assistant", message: { content: [{ type: "text", text: reply }] }, timestamp: ts, sessionId });
  } else if (agent === "codex") {
    const file = join(homes.codex, "sessions", "2026", "09", "26", `rollout-2026-09-26T10-00-00-${sessionId}.jsonl`);
    if (!existsSync(file)) {
      line(file, { type: "session_meta", payload: { id: sessionId, cwd } });
    }
    line(file, { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: user } });
    line(file, { timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: reply } });
  } else {
    const file = join(homes.copilot, "session-state", sessionId, "events.jsonl");
    line(file, { type: "user.message", data: { content: user }, timestamp: ts });
    line(file, { type: "assistant.message", data: { content: reply, toolRequests: [] }, timestamp: ts });
  }
}

describe("interactiveArgs", () => {
  it("claude: the prompt goes first (--add-dir is variadic), then model, effort, mode and session", () => {
    expect(
      interactiveArgs({ agent: "claude", model: "opus", effort: "max", mode: "plan", sessionId: "s1", prompt: "hola", addDirs: ["D:\\h"], name: "Mi tarea" }),
    ).toEqual(["hola", "--model", "opus", "--effort", "max", "--permission-mode", "plan", "--session-id", "s1", "--name", "Mi tarea", "--add-dir", "D:\\h"]);
    expect(interactiveArgs({ agent: "claude", model: "", effort: "", mode: "bypass", resume: "s1" })).toEqual(["--dangerously-skip-permissions", "--resume", "s1"]);
  });

  it("codex: resume and its id first, the prompt last, inline mode", () => {
    expect(interactiveArgs({ agent: "codex", model: "gpt-5.5", effort: "high", mode: "acceptEdits", resume: "c1", prompt: "sigue" })).toEqual([
      "resume",
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--no-alt-screen",
      "--no-daemon",
      "c1",
      "sigue",
    ]);
  });

  it("copilot: its own session id, -i for the first message", () => {
    expect(interactiveArgs({ agent: "copilot", model: "gpt-5-mini", effort: "", mode: "auto", sessionId: "p1", prompt: "-v rompe", addDirs: ["h"] })).toEqual([
      "--model",
      "gpt-5-mini",
      "--autopilot",
      "--session-id",
      "p1",
      "--add-dir",
      "h",
      "-i",
      " -v rompe",
    ]);
  });

  it("refuses a model that would read as a flag", () => {
    expect(() => interactiveArgs({ agent: "claude", model: "--dangerously-skip-permissions", effort: "", mode: "default" })).toThrow(/Modelo no válido/);
  });
});

describe("transcripts", () => {
  it("claude: merges one turn's pieces, labels tools, skips slash-command noise and subagents", () => {
    const file = join(homes.claude, "projects", claudeProjectSlug(cwd).toLowerCase(), "s1.jsonl");
    line(file, { type: "user", message: { content: "<command-name>/model</command-name>" }, timestamp: "2026-09-26T10:00:00Z" });
    line(file, { type: "user", message: { content: "arregla el bug" }, timestamp: "2026-09-26T10:00:01Z" });
    line(file, { type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] }, timestamp: "2026-09-26T10:00:02Z" });
    line(file, { type: "assistant", message: { content: [{ type: "text", text: "Miro el fichero" }, { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] }, timestamp: "2026-09-26T10:00:03Z" });
    line(file, { type: "user", message: { content: [{ type: "tool_result", content: "..." }] }, timestamp: "2026-09-26T10:00:04Z" });
    line(file, { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagente" }] } });
    line(file, { type: "assistant", message: { content: [{ type: "text", text: "Arreglado" }] }, timestamp: "2026-09-26T10:00:05Z" });
    line(file, { type: "ai-title", aiTitle: "Arreglar el bug", sessionId: "s1" });

    const messages = readTranscript("claude", "s1", cwd, homes);
    expect(messages.map((message) => [message.role, message.text, message.tools])).toEqual([
      ["user", "arregla el bug", undefined],
      ["assistant", "Miro el fichero\n\nArreglado", ["Read src/a.ts"]],
    ]);
    expect(sessionTitle("claude", "s1", cwd, homes)).toBe("Arreglar el bug");
  });

  it("codex: user and agent events, tool calls and patches", () => {
    const file = join(homes.codex, "sessions", "2026", "09", "26", "rollout-2026-09-26T10-00-00-c1.jsonl");
    line(file, { type: "session_meta", payload: { id: "c1", cwd } });
    line(file, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } });
    line(file, { timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "añade tests" } });
    line(file, { timestamp: "t2", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) } });
    line(file, { timestamp: "t3", type: "event_msg", payload: { type: "patch_apply_end", changes: { "src/a.spec.ts": {} } } });
    line(file, { timestamp: "t4", type: "event_msg", payload: { type: "agent_message", message: "Hecho" } });
    line(join(homes.codex, "session_index.jsonl"), { id: "c1", thread_name: "Añadir tests" });

    expect(readTranscript("codex", "c1", cwd, homes).map((message) => [message.role, message.text, message.tools])).toEqual([
      ["user", "añade tests", undefined],
      ["assistant", "Hecho", ["shell npm test", "Edit src/a.spec.ts"]],
    ]);
    expect(sessionTitle("codex", "c1", cwd, homes)).toBe("Añadir tests");
  });

  it("codex CLI 0.157: item_completed events, not the response_items that repeat them", () => {
    const file = join(homes.codex, "sessions", "2026", "09", "26", "rollout-2026-09-26T13-36-03-c2.jsonl");
    const item = (ts: string, value: object): void => line(file, { timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: value } });
    line(file, { type: "session_meta", payload: { id: "c2", cwd } });
    line(file, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } });
    item("t1", { type: "UserMessage", id: "u", content: [{ type: "text", text: "lee el traspaso" }] });
    item("t2", { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "Leeré el traspaso." }], phase: "commentary" });
    line(file, { timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Leeré el traspaso." }] } });
    line(file, { timestamp: "t3", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "const xs = await tools.exec_command(…)" } });
    item("t3", {
      type: "CommandExecution",
      command: ["C:\\pwsh.exe", "-NoProfile", "-Command", "Get-Content -Raw handoff-2.md"],
      parsed_cmd: [{ type: "read", cmd: "Get-Content -Raw handoff-2.md", name: "handoff-2.md" }],
    });
    item("t4", { type: "FileChange", changes: { "src/a.ts": { type: "update" } } });
    item("t5", { type: "AgentMessage", id: "a2", content: [{ type: "Text", text: "PERA" }], phase: "final_answer" });

    expect(readTranscript("codex", "c2", cwd, homes).map((message) => [message.role, message.text, message.tools])).toEqual([
      ["user", "lee el traspaso", undefined],
      ["assistant", "Leeré el traspaso.\n\nPERA", ["shell Get-Content -Raw handoff-2.md", "Edit src/a.ts"]],
    ]);
  });

  it("copilot: user and assistant messages with their tool requests", () => {
    const file = join(homes.copilot, "session-state", "p1", "events.jsonl");
    line(file, { type: "session.start", data: { sessionId: "p1" } });
    line(file, { type: "user.message", data: { content: "hola" }, timestamp: "t1" });
    line(file, { type: "assistant.message", data: { content: "", toolRequests: [{ name: "view", arguments: { path: "README.md" } }] }, timestamp: "t2" });
    line(file, { type: "assistant.message", data: { content: "Listo", toolRequests: [] }, timestamp: "t3" });
    expect(readTranscript("copilot", "p1", cwd, homes).map((message) => [message.role, message.text, message.tools])).toEqual([
      ["user", "hola", undefined],
      ["assistant", "Listo", ["view README.md"]],
    ]);
  });

  it("finds the codex session started in a folder, skipping other folders and claimed ids", () => {
    const since = Date.now() - 1000;
    const day = join(homes.codex, "sessions", "2026", "09", "26");
    line(join(day, "rollout-a-other.jsonl"), { type: "session_meta", payload: { id: "other", cwd: join(root, "elsewhere") } });
    line(join(day, "rollout-b-taken.jsonl"), { type: "session_meta", payload: { id: "taken", cwd } });
    expect(findCodexSession(cwd, since, new Set(["taken"]), homes)).toBeUndefined();
    line(join(day, "rollout-c-mine.jsonl"), { type: "session_meta", payload: { id: "mine", cwd: cwd.toUpperCase() } });
    expect(findCodexSession(cwd, since, new Set(["taken"]), homes)).toBe(process.platform === "win32" ? "mine" : undefined);
  });
});

function conversation(segments: Conversation["segments"]): Conversation {
  return { id: "x", title: "Demo", kind: "agent", cwd, createdAt: "", updatedAt: "", status: "stopped", segments };
}

const message = (agent: AgentKind, sessionId: string, role: "user" | "assistant", text: string, ts: string): TranscriptMessage => ({ agent, sessionId, role, text, ts });

describe("handoff", () => {
  it("history: every session once, in time order, without Nexura's handoff prompts", () => {
    const read = (agent: AgentKind, sessionId: string): TranscriptMessage[] =>
      ({
        s1: [message("claude", "s1", "user", "uno", "2026-09-26T10:00:00Z"), message("claude", "s1", "user", `${HANDOFF_MARKER} lee`, "2026-09-26T10:02:00Z"), message("claude", "s1", "assistant", "tres", "2026-09-26T10:03:00Z")],
        c1: [message("codex", "c1", "user", `${HANDOFF_MARKER} lee`, "2026-09-26T10:01:00Z"), message("codex", "c1", "assistant", "dos", "2026-09-26T10:01:30Z")],
      })[sessionId] ?? [];
    const history = conversationHistory(
      conversation([
        { agent: "claude", sessionId: "s1", model: "", effort: "", mode: "default", startedAt: "" },
        { agent: "codex", sessionId: "c1", model: "", effort: "", mode: "default", startedAt: "" },
        { agent: "claude", sessionId: "s1", model: "", effort: "", mode: "default", startedAt: "" },
      ]),
      read,
    );
    expect(history.map((entry) => entry.text)).toEqual(["uno", "dos", "tres"]);
  });

  it("going back to an agent reopens its session with only what the others said since", () => {
    const talk = conversation([
      { agent: "claude", sessionId: "s1", model: "", effort: "", mode: "default", startedAt: "2026-09-26T10:00:00Z", endedAt: "2026-09-26T10:05:00Z" },
      { agent: "codex", sessionId: "c1", model: "", effort: "", mode: "default", startedAt: "2026-09-26T10:05:00Z", endedAt: "2026-09-26T10:09:00Z" },
    ]);
    const history = [
      message("claude", "s1", "user", "antes", "2026-09-26T10:01:00Z"),
      message("codex", "c1", "assistant", "después", "2026-09-26T10:06:00Z"),
    ];
    const plan = planHandoff(talk, "claude", history);
    expect(plan.resume?.sessionId).toBe("s1");
    expect(plan.messages.map((entry) => entry.text)).toEqual(["después"]);
    expect(planHandoff(talk, "copilot", history)).toEqual({ messages: history });
  });

  it("the file keeps the first request and the latest messages, and no instructions", () => {
    const long = "x".repeat(7000);
    const messages = [message("claude", "s1", "user", "petición inicial", "2026-09-26T10:00:00Z"), ...Array.from({ length: 40 }, (_, index) => message("claude", "s1", "assistant", `${index} ${long}`, "2026-09-26T10:01:00Z"))];
    const markdown = handoffMarkdown(conversation([{ agent: "claude", sessionId: "s1", model: "opus", effort: "", mode: "default", startedAt: "" }]), messages, "codex");
    expect(markdown).toContain("Claude Code (opus)");
    expect(markdown).toContain("petición inicial");
    expect(markdown).toContain("39 x");
    expect(markdown).not.toContain("\n0 x");
    expect(markdown).toMatch(/Se omiten \d+ mensajes antiguos/);
    expect(markdown).toContain("IDE local del usuario");
    expect(handoffPrompt("h.md", ["claude", "codex", "copilot", "codex"], { resumed: false })).toContain("con Claude Code, Codex y Copilot en");
    expect(handoffPrompt("h.md", ["codex"], { resumed: true, instruction: "  di KIWI " })).toMatch(/con Codex en Nexura.*Lo que te pido ahora: di KIWI$/);
  });
});

/** An in-memory PTY: records what it was launched with and can exit on demand. */
class FakePty implements Pty {
  public readonly command: string;
  public readonly args: string[];
  public readonly options: PtyOptions;
  public readonly written: string[] = [];
  public readonly sizes: [number, number][] = [];
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((event: { exitCode: number }) => void)[] = [];
  private exited = false;

  public constructor(command: string, args: string[], options: PtyOptions) {
    this.command = command;
    this.args = args;
    this.options = options;
  }

  public onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  public onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListeners.push(listener);
  }

  public write(data: string): void {
    this.written.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  public kill(): void {
    this.exit(0);
  }

  public emit(data: string): void {
    this.dataListeners.forEach((listener) => listener(data));
  }

  public exit(exitCode: number): void {
    if (!this.exited) {
      this.exited = true;
      this.exitListeners.forEach((listener) => listener({ exitCode }));
    }
  }
}

class FakeSocket implements ClientSocket {
  public readyState = 1;
  public readonly sent: string[] = [];
  private readonly listeners: Record<string, ((raw?: unknown) => void)[]> = {};

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.listeners.close?.forEach((listener) => listener());
  }

  public on(event: string, listener: (raw?: unknown) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  public input(value: object): void {
    this.listeners.message?.forEach((listener) => listener(JSON.stringify(value)));
  }
}

describe("ConversationManager", () => {
  let ptys: FakePty[];
  let manager: ConversationManager;

  beforeEach(() => {
    ptys = [];
    manager = new ConversationManager(new ConversationStore(":memory:"), {
      homes,
      dataDir: join(root, "data"),
      repos: () => [{ name: "demo", path: cwd, baseBranch: "main", checks: [] }],
      command: (agent) => ({ command: agent, prefixArgs: [] }),
      spawn: (command, args, options) => {
        const pty = new FakePty(command, args, options);
        ptys.push(pty);
        return pty;
      },
    });
  });

  afterEach(() => manager.dispose());

  const flag = (pty: FakePty, name: string): string | undefined => (pty.args.includes(name) ? pty.args[pty.args.indexOf(name) + 1] : undefined);

  it("starts claude on a repo with its own session id, and resumes it with another model and mode", async () => {
    const created = await manager.create({ kind: "agent", repo: "demo", agent: "claude", model: "sonnet", mode: "plan", prompt: "hola" });
    expect(created).toMatchObject({ status: "running", cwd, repo: "demo", title: "Nueva conversación" });
    const first = ptys[0]!;
    const sessionId = flag(first, "--session-id")!;
    expect(first.args[0]).toBe("hola");
    expect(flag(first, "--permission-mode")).toBe("plan");
    expect(first.options.cwd).toBe(cwd);

    say("claude", sessionId, "hola", "¿qué tal?", new Date().toISOString());
    const restarted = await manager.start(created.id, { model: "opus", mode: "acceptEdits" });
    const second = ptys[1]!;
    expect(flag(second, "--resume")).toBe(sessionId);
    expect(flag(second, "--model")).toBe("opus");
    expect(flag(second, "--permission-mode")).toBe("acceptEdits");
    expect(restarted.segments).toHaveLength(1);
    expect(restarted.segments[0]).toMatchObject({ agent: "claude", sessionId, model: "opus", mode: "acceptEdits" });
  });

  it("hands the history to another agent, then goes back to the first one with only what is new", async () => {
    const created = await manager.create({ kind: "agent", repo: "demo", agent: "claude" });
    const claudeSession = flag(ptys[0]!, "--session-id")!;
    say("claude", claudeSession, "arregla el login", "arreglado", new Date(Date.now() - 60_000).toISOString());

    // To codex: the whole history in a file, and codex's own id read from its rollout.
    const toCodex = await manager.start(created.id, { agent: "codex", model: "gpt-5.5", prompt: "ahora los tests" });
    const codexPty = ptys[1]!;
    const codexPrompt = codexPty.args.at(-1)!;
    expect(codexPrompt.startsWith(HANDOFF_MARKER)).toBe(true);
    const handoff = toCodex.segments[1]!.handoff!;
    expect(handoff).toMatchObject({ messages: 2, from: ["claude"] });
    const file = readFileSync(handoff.file, "utf8");
    expect(file).toContain("arregla el login");
    // What the user asks goes in their own message; the file is only context.
    expect(file).not.toContain("ahora los tests");
    expect(codexPrompt).toContain("Lo que te pido ahora: ahora los tests");
    expect(codexPrompt).toContain(handoff.file);

    say("codex", "codex-1", codexPrompt, "He leído el historial", new Date().toISOString());
    say("codex", "codex-1", "añade tests", "tests añadidos", new Date(Date.now() + 1000).toISOString());
    await manager.stop(created.id);
    expect(manager.get(created.id).segments[1]).toMatchObject({ agent: "codex", sessionId: "codex-1" });

    // Back to claude: its session again, with only codex's part.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const back = await manager.start(created.id, { agent: "claude" });
    const claudeAgain = ptys[2]!;
    expect(flag(claudeAgain, "--resume")).toBe(claudeSession);
    expect(claudeAgain.args[0]).toContain("Desde tu último mensaje");
    const second = readFileSync(back.segments[2]!.handoff!.file, "utf8");
    expect(second).toContain("tests añadidos");
    // Claude already has its own part (the title is its first message).
    expect(second).not.toContain("arreglado");
    expect(back.title).toBe("arregla el login");
    expect(second).not.toContain(HANDOFF_MARKER);
    expect(back.segments.map((segment) => segment.agent)).toEqual(["claude", "codex", "claude"]);

    const history = manager.history(created.id).map((entry) => entry.text);
    expect(history).toEqual(["arregla el login", "arreglado", "He leído el historial", "añade tests", "tests añadidos"]);
  });

  it("a fresh start or an empty conversation hands nothing over", async () => {
    const created = await manager.create({ kind: "agent", repo: "demo", agent: "claude" });
    const switched = await manager.start(created.id, { agent: "copilot" });
    expect(switched.segments[1]!.handoff).toBeUndefined();
    expect(flag(ptys[1]!, "--session-id")).toBe(switched.segments[1]!.sessionId);
    say("copilot", switched.segments[1]!.sessionId!, "hola", "hola", new Date().toISOString());
    const fresh = await manager.start(created.id, { agent: "codex", fresh: true });
    expect(fresh.segments[2]!.handoff).toBeUndefined();
    expect(ptys[2]!.args.some((arg) => arg.startsWith(HANDOFF_MARKER))).toBe(false);
  });

  it("forks a conversation into a new one that starts from its history", async () => {
    const created = await manager.create({ kind: "agent", repo: "demo", agent: "claude" });
    say("claude", created.segments[0]!.sessionId!, "idea A", "vale", new Date().toISOString());
    const fork = await manager.create({ kind: "agent", agent: "copilot", forkOf: created.id });
    expect(fork).toMatchObject({ cwd, repo: "demo", title: "Nueva conversación (copia)" });
    expect(fork.segments[0]!.handoff?.messages).toBe(2);
    expect(flag(ptys[1]!, "-i")).toContain(HANDOFF_MARKER);
    // Its agent titles the session after the handoff prompt: the fork keeps its own title.
    say("copilot", fork.segments[0]!.sessionId!, flag(ptys[1]!, "-i")!, "leído", new Date().toISOString());
    await manager.stop(fork.id);
    expect(manager.get(fork.id).title).toBe("Nueva conversación (copia)");
  });

  it("follows the agent's title until the user renames it", async () => {
    const created = await manager.create({ kind: "agent", repo: "demo", agent: "claude" });
    const sessionId = created.segments[0]!.sessionId!;
    say("claude", sessionId, "refactor del router", "ok", new Date().toISOString());
    await manager.stop(created.id);
    expect(manager.get(created.id).title).toBe("refactor del router");
    manager.update(created.id, { title: "Router" });
    line(join(homes.claude, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`), { type: "ai-title", aiTitle: "Otro" });
    await manager.start(created.id);
    await manager.stop(created.id);
    expect(manager.get(created.id)).toMatchObject({ title: "Router", titleLocked: true });
  });

  it("replays the output to a tab that attaches and forwards its input", async () => {
    const created = await manager.create({ kind: "shell", repo: "demo" });
    expect(created.title).toBe("PowerShell · demo");
    ptys[0]!.emit("PS> ");
    const socket = new FakeSocket();
    manager.attach(socket, created.id, 100, 40);
    expect(socket.sent.join("")).toContain("PS> ");
    expect(ptys[0]!.sizes).toContainEqual([100, 40]);
    socket.input({ t: "i", d: "ls\r" });
    expect(ptys[0]!.written).toEqual(["ls\r"]);
    ptys[0]!.emit("hecho");
    expect(socket.sent.at(-1)).toBe("hecho");

    ptys[0]!.exit(1);
    expect(manager.get(created.id)).toMatchObject({ status: "stopped", exitCode: 1 });
    // A stop asked for from Nexura has no exit code to show (on Windows it would be the kill status).
    await manager.start(created.id);
    await manager.stop(created.id);
    expect(manager.get(created.id).exitCode).toBeUndefined();
    expect(socket.sent.join("")).toContain("[proceso cerrado]");
    await manager.delete(created.id);
    expect(manager.list()).toEqual([]);
    expect(socket.readyState).toBe(3);
  });

  it("saves pasted images in the conversation's folder and says what to paste per agent", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const claude = await manager.create({ kind: "agent", repo: "demo", agent: "claude" });
    const saved = manager.saveImage(claude.id, { mimeType: "image/png", data: png });
    expect(saved.path.startsWith(join(root, "data", "conversations", claude.id, "images"))).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(readFileSync(saved.path).toString("base64")).toBe(png);
    expect(saved.text).toBe(saved.path);

    const copilot = await manager.create({ kind: "agent", repo: "demo", agent: "copilot" });
    expect(manager.saveImage(copilot.id, { mimeType: "image/jpeg", data: png }).text).toMatch(/^@.+\.jpg $/);
    expect(() => manager.saveImage(claude.id, { mimeType: "image/svg+xml", data: png })).toThrow(/no admitido/);
    expect(() => manager.saveImage(claude.id, { mimeType: "image/png", data: "" })).toThrow(/vacía/);

    await manager.delete(claude.id);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("keeps nothing when the CLI cannot start", async () => {
    const failing = new ConversationManager(new ConversationStore(":memory:"), {
      homes,
      dataDir: join(root, "data"),
      repos: () => [{ name: "demo", path: cwd, baseBranch: "main", checks: [] }],
      command: () => {
        throw new Error("No se encuentra Codex");
      },
    });
    await expect(failing.create({ kind: "agent", repo: "demo", agent: "codex" })).rejects.toThrow("No se encuentra Codex");
    expect(failing.list()).toEqual([]);
    await expect(manager.create({ kind: "agent", cwd: join(root, "missing") })).rejects.toThrow(/No existe la carpeta/);
  });
});
