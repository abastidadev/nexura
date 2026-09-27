import { afterNextRender, Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export type TerminalRequest = {
  key: number;
  runId: string;
  mode: "resume" | "shell";
  stepRunId?: string;
  title: string;
};

const FONT_SIZE = 13;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm.js bound to a server PTY over `/pty` (claude --resume or a shell in the worktree). */
@Component({
  selector: "nx-terminal-panel",
  template: `
    <div class="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 text-sm">
      <span class="size-2 rounded-full" [class]="connected() ? 'bg-ok' : 'bg-muted'" aria-hidden="true"></span>
      <span class="font-medium">{{ request().title }}</span>
      <span class="text-muted">{{ connected() ? "conectada" : "cerrada" }}</span>
      <span class="ml-auto flex gap-1">
        <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" (click)="toggleMaximize.emit()">
          ⤢ <span class="sr-only">Maximizar o restaurar</span>
        </button>
        <button type="button" class="nx-btn nx-btn-sm nx-btn-ghost" aria-label="Cerrar terminal" (click)="closed.emit()">
          ×
        </button>
      </span>
    </div>
    <div #host class="min-h-0 flex-1 bg-[var(--nx-bg)] px-2 py-1"></div>
  `,
  host: { class: "flex min-h-0 flex-col" },
})
export class TerminalPanel {
  public readonly request = input.required<TerminalRequest>();
  public readonly closed = output<void>();
  public readonly toggleMaximize = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");
  protected readonly connected = signal(false);

  public constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const request = this.request();
      const terminal = new Terminal({
        fontFamily: cssVar("--font-mono") || "Consolas, monospace",
        fontSize: FONT_SIZE,
        cursorBlink: true,
        theme: {
          background: cssVar("--nx-bg"),
          foreground: cssVar("--nx-fg"),
          cursor: cssVar("--nx-accent"),
          selectionBackground: cssVar("--nx-accent-soft"),
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(this.host().nativeElement);
      fit.fit();

      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({
        runId: request.runId,
        mode: request.mode,
        cols: String(terminal.cols),
        rows: String(terminal.rows),
      });
      if (request.stepRunId) {
        params.set("stepRunId", request.stepRunId);
      }
      const socket = new WebSocket(`${protocol}://${location.host}/pty?${params}`);
      socket.onopen = () => {
        this.connected.set(true);
        terminal.focus();
      };
      socket.onmessage = (message) => terminal.write(String(message.data));
      socket.onclose = () => this.connected.set(false);
      const send = (payload: object): void => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };
      const input = terminal.onData((data) => send({ t: "i", d: data }));
      const resize = terminal.onResize(({ cols, rows }) => send({ t: "r", c: cols, r: rows }));
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(this.host().nativeElement);

      destroyRef.onDestroy(() => {
        observer.disconnect();
        input.dispose();
        resize.dispose();
        socket.close();
        terminal.dispose();
      });
    });
  }
}
