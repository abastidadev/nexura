import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentKind, NexuraEvent } from "@nexura/shared";
import type { AgentLaunch, AgentRunOptions } from "./agent-adapter.ts";
import { adapterFor } from "./agents.ts";
import { claudeEnv } from "./claude-process.ts";
import { LineSplitter, parseLine } from "./stream-parser.ts";

export type AgentOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  stderr: string;
  result?: Extract<NexuraEvent, { kind: "result" }>;
  sessionId?: string;
};

type AgentProcessEvents = {
  raw: [line: string];
  event: [event: NexuraEvent];
  exit: [outcome: AgentOutcome];
};

/**
 * One headless execution of a coding agent (`claude -p`, `codex exec` or `copilot -p`).
 * Emits every raw stdout line and every normalised event; the adapter of the agent builds
 * the arguments and maps its output format.
 */
export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  public readonly agent: AgentKind;
  private child?: ChildProcess;
  private killed = false;
  /** stdin stays open until the first `result`, so `send` can reach the running turn. */
  private accepting = false;
  private readonly options: AgentRunOptions;
  private readonly launch: AgentLaunch;

  public constructor(options: AgentRunOptions) {
    super();
    this.options = options;
    this.agent = options.agent;
    this.launch = adapterFor(options.agent).launch(options);
  }

  public get args(): string[] {
    return this.launch.args;
  }

  /** Whether messages can be sent while it runs (only claude reads more input mid-turn). */
  public get interactive(): boolean {
    return this.launch.interactive;
  }

  public run(): Promise<AgentOutcome> {
    const launch = this.launch;
    let command: ReturnType<ReturnType<typeof adapterFor>["command"]>;
    try {
      command = adapterFor(this.agent).command();
    } catch (error) {
      launch.cleanup?.();
      return Promise.reject(error);
    }
    const child = spawn(command.command, [...command.prefixArgs, ...launch.args], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeEnv(),
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on("error", () => undefined);
    if (launch.stdin !== undefined) {
      child.stdin.write(launch.stdin);
    }
    if (launch.interactive) {
      this.accepting = true;
    } else {
      child.stdin.end();
    }

    const splitter = new LineSplitter();
    const outcome: AgentOutcome = { exitCode: null, timedOut: false, killed: false, stderr: "" };

    const handleEvents = (events: NexuraEvent[]): void => {
      for (const event of events) {
        if (event.kind === "init") {
          outcome.sessionId = event.sessionId;
        }
        if (event.kind === "result") {
          outcome.result = event;
          if (this.accepting) {
            // The turn is over: closing stdin lets the agent exit instead of waiting for more input.
            this.accepting = false;
            child.stdin.end();
          }
        }
        this.emit("event", event);
      }
    };
    const handleLine = (line: string): void => {
      this.emit("raw", line);
      const raw = parseLine(line);
      handleEvents(raw ? launch.normalize(raw) : (launch.text?.(line) ?? []));
    };

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => splitter.push(chunk).forEach(handleLine));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (outcome.stderr += chunk));

    const timer = this.options.timeoutMs
      ? setTimeout(() => {
          outcome.timedOut = true;
          this.kill();
        }, this.options.timeoutMs)
      : undefined;

    return new Promise((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        this.accepting = false;
        splitter.flush().forEach(handleLine);
        if (!this.killed) {
          handleEvents(launch.finish?.(code, outcome.stderr) ?? []);
        }
        launch.cleanup?.();
        outcome.exitCode = code;
        outcome.killed = this.killed;
        this.emit("exit", outcome);
        resolve(outcome);
      });
      child.on("error", (error) => {
        outcome.stderr += String(error);
      });
    });
  }

  /**
   * Sends another user message to the running step. Claude folds it into the current
   * turn (verified with claude 2.1: a single `result` comes out). False once the turn
   * ended, or when the agent does not take input mid-run (codex, copilot).
   */
  public send(text: string): boolean {
    const stdin = this.child?.stdin;
    if (!this.accepting || !stdin?.writable || !this.launch.userMessage) {
      return false;
    }
    stdin.write(this.launch.userMessage(text));
    return true;
  }

  public kill(): void {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    this.killed = true;
    if (process.platform === "win32" && this.child.pid) {
      // Kill the whole tree: the agent may have spawned shells, MCP servers, subagents.
      spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      this.child.kill("SIGTERM");
    }
  }
}
