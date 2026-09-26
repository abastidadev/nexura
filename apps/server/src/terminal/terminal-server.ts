import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RunStore } from "../store/run-store.ts";
import { adapterFor } from "../runner/agents.ts";
import { claudeEnv } from "../runner/claude-process.ts";
import { trustWorktree } from "../workspace/claude-trust.ts";
import { killPty, shellCommand, spawnPty, type Pty } from "./pty.ts";

export type TerminalMode = "resume" | "shell";

type ClientMessage = { t: "i"; d: string } | { t: "r"; c: number; r: number };

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Interactive terminals in a run's worktree, over WebSocket (`/pty?runId=&mode=&stepRunId=`):
 *  - `resume`: `claude --resume <session>` of a step, to keep talking to it by hand.
 *  - `shell`:  a plain shell (PowerShell on Windows) in the primary worktree.
 * Output is sent as text frames; the client sends `{t:"i",d}` for input and `{t:"r",c,r}` to resize.
 */
export class TerminalServer {
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly store: RunStore;
  private readonly byRun = new Map<string, Set<Pty>>();

  public constructor(store: RunStore) {
    this.store = store;
    this.sockets.on("connection", (socket: WebSocket, request: IncomingMessage) => this.connect(socket, request));
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.sockets.handleUpgrade(request, socket, head, (ws) => this.sockets.emit("connection", ws, request));
  }

  /**
   * Kills the run's terminals and waits for them to exit: on Windows a shell whose cwd is the
   * worktree keeps git from removing it.
   */
  public async closeRun(runId: string): Promise<void> {
    const ptys = [...(this.byRun.get(runId) ?? [])];
    this.byRun.delete(runId);
    await Promise.all(ptys.map((pty) => killPty(pty)));
  }

  private connect(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const fail = (message: string): void => {
      socket.send(`\x1b[31m${message}\x1b[0m\r\n`);
      socket.close();
    };

    const run = this.store.getRun(url.searchParams.get("runId") ?? "");
    const worktree = run?.worktrees[0];
    if (!run || !worktree) {
      fail("El flujo no existe o ya no tiene worktree.");
      return;
    }

    // Worktrees created before trust existed get it on first use.
    trustWorktree(worktree.path, worktree.repoPath);
    const mode = (url.searchParams.get("mode") ?? "shell") as TerminalMode;
    let command: string;
    let args: string[];
    if (mode === "resume") {
      const step = run.steps.find((candidate) => candidate.id === url.searchParams.get("stepRunId"));
      if (!step?.sessionId) {
        fail("Ese paso no tiene sesión que reanudar.");
        return;
      }
      // Reopens the session with the CLI of the agent that ran the step (claude, codex or copilot).
      const adapter = adapterFor(step.agent);
      let agent: ReturnType<typeof adapter.command>;
      try {
        agent = adapter.command();
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
      }
      command = agent.command;
      args = [...agent.prefixArgs, ...adapter.resumeArgs(step.sessionId)];
    } else {
      ({ command, args } = shellCommand());
    }

    let pty: Pty;
    try {
      pty = spawnPty(command, args, {
        name: "xterm-256color",
        cols: Number(url.searchParams.get("cols")) || DEFAULT_COLS,
        rows: Number(url.searchParams.get("rows")) || DEFAULT_ROWS,
        cwd: worktree.path,
        env: claudeEnv(),
      });
    } catch (error) {
      fail(`No se pudo abrir la terminal: ${String(error)}`);
      return;
    }

    const ptys = this.byRun.get(run.id) ?? new Set<Pty>();
    this.byRun.set(run.id, ptys.add(pty));

    pty.onData((data) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    });
    pty.onExit(({ exitCode }) => {
      ptys.delete(pty);
      if (socket.readyState === socket.OPEN) {
        socket.send(`\r\n\x1b[90m[proceso terminado · código ${exitCode}]\x1b[0m\r\n`);
        socket.close();
      }
    });
    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (message.t === "i") {
        pty.write(message.d);
      } else if (message.t === "r" && message.c > 0 && message.r > 0) {
        pty.resize(message.c, message.r);
      }
    });
    socket.on("close", () => {
      try {
        pty.kill();
      } catch {
        // Already exited.
      }
    });
  }
}
