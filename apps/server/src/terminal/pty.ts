import { createRequire } from "node:module";

export type Pty = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtyOptions = { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv };

type PtyModule = { spawn(file: string, args: string[], options: PtyOptions): Pty };

// node-pty is CommonJS with a native addon; load it lazily so the rest of the server works without it.
const require = createRequire(import.meta.url);
let ptyModule: PtyModule | undefined;

export function spawnPty(file: string, args: string[], options: PtyOptions): Pty {
  ptyModule ??= require("@lydell/node-pty") as PtyModule;
  return ptyModule.spawn(file, args, options);
}

export function shellCommand(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo"] }
    : { command: process.env.SHELL ?? "bash", args: [] };
}

/** Kills a PTY and waits for it to exit (at most `timeoutMs`): on Windows a live shell keeps its cwd locked. */
export function killPty(pty: Pty, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, timeoutMs);
    pty.onExit(() => {
      clearTimeout(timer);
      done();
    });
    try {
      pty.kill();
    } catch {
      clearTimeout(timer);
      done(); // Already exited.
    }
  });
}
