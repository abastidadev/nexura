import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { NexuraEvent } from "@nexura/shared";
import { buildClaudeArgs, type ClaudeRunOptions } from "./claude-args.ts";
import { LineSplitter, normalize, parseLine } from "./stream-parser.ts";

let cachedBin: string | undefined;

/** On Windows the npm shim is a .cmd/.ps1; spawning the real exe avoids cmd.exe quoting. */
export function resolveClaudeBin(): string {
  if (cachedBin) {
    return cachedBin;
  }
  if (process.env.NEXURA_CLAUDE_BIN) {
    cachedBin = process.env.NEXURA_CLAUDE_BIN;
  } else if (process.platform !== "win32") {
    cachedBin = "claude";
  } else {
    const shim = execFileSync("where.exe", ["claude.cmd"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();
    const exe = join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (!existsSync(exe)) {
      throw new Error(`claude.exe not found next to ${shim}; set NEXURA_CLAUDE_BIN`);
    }
    cachedBin = exe;
  }
  return cachedBin;
}

export type ClaudeOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  stderr: string;
  result?: Extract<NexuraEvent, { kind: "result" }>;
  sessionId?: string;
};

type ClaudeProcessEvents = {
  raw: [line: string];
  event: [event: NexuraEvent];
  exit: [outcome: ClaudeOutcome];
};

/** One `claude -p` execution. Emits every raw line and every normalised event. */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private child?: ChildProcess;
  private killed = false;

  public constructor(private readonly options: ClaudeRunOptions) {
    super();
  }

  public get args(): string[] {
    return buildClaudeArgs(this.options);
  }

  public run(): Promise<ClaudeOutcome> {
    const child = spawn(resolveClaudeBin(), this.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.end(this.options.prompt);

    const splitter = new LineSplitter();
    const outcome: ClaudeOutcome = { exitCode: null, timedOut: false, killed: false, stderr: "" };

    const handleLine = (line: string): void => {
      this.emit("raw", line);
      const raw = parseLine(line);
      if (!raw) {
        return;
      }
      for (const event of normalize(raw)) {
        if (event.kind === "init") {
          outcome.sessionId = event.sessionId;
        }
        if (event.kind === "result") {
          outcome.result = event;
        }
        this.emit("event", event);
      }
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
        splitter.flush().forEach(handleLine);
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

  public kill(): void {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    this.killed = true;
    if (process.platform === "win32" && this.child.pid) {
      // Kill the whole tree: claude may have spawned shells, MCP servers, subagents.
      spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      this.child.kill("SIGTERM");
    }
  }
}
