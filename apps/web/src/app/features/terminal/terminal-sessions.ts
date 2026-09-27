import { effect, inject, Service, signal, type Signal, type WritableSignal } from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { Api, apiError } from "../../core/api";
import { NexuraStore } from "../../core/nexura-store";

const FONT_SIZE = 13;
const SCROLLBACK = 10_000;
const RECONNECT_MS = 2000;

type Session = {
  id: string;
  terminal: Terminal;
  fit: FitAddon;
  /** xterm's container: moved between hosts, so the screen survives navigation. */
  element: HTMLElement;
  socket?: WebSocket;
  connected: WritableSignal<boolean>;
  reconnect?: ReturnType<typeof setTimeout>;
  disposed: boolean;
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith("image/"));
}

/** The file's bytes as base64 (without the `data:` prefix). */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function theme(): ITheme {
  return {
    background: cssVar("--nx-bg"),
    foreground: cssVar("--nx-fg"),
    cursor: cssVar("--nx-accent"),
    selectionBackground: cssVar("--nx-accent-soft"),
  };
}

/**
 * One xterm.js per terminal conversation, kept for the whole app session: leaving the
 * Terminal page only detaches its element, so coming back is instant and keeps the screen.
 * Each one is connected to the conversation's PTY on the server (`/cpty`), which replays its
 * recent output on (re)connect.
 */
@Service()
export class TerminalSessions {
  private readonly store = inject(NexuraStore);
  private readonly api = inject(Api);
  private readonly sessions = new Map<string, Session>();

  public constructor() {
    effect(() => {
      this.store.theme();
      // The theme class is toggled by another effect: read the variables once it is applied.
      requestAnimationFrame(() => this.sessions.forEach((session) => (session.terminal.options.theme = theme())));
    });
  }

  /** Puts the conversation's terminal in `host`, creating and connecting it on first use. */
  public mount(id: string, host: HTMLElement): Signal<boolean> {
    const existing = this.sessions.get(id);
    const session = existing ?? this.create(id, host);
    if (existing) {
      host.appendChild(session.element);
    }
    this.fit(id);
    if (!session.socket || session.socket.readyState === WebSocket.CLOSED) {
      this.connect(session);
    }
    session.terminal.focus();
    return session.connected;
  }

  public unmount(id: string): void {
    this.sessions.get(id)?.element.remove();
  }

  public fit(id: string): void {
    const session = this.sessions.get(id);
    if (session?.element.isConnected) {
      try {
        session.fit.fit();
        session.terminal.refresh(0, session.terminal.rows - 1);
      } catch {
        // Not laid out yet.
      }
    }
  }

  public focus(id: string): void {
    this.sessions.get(id)?.terminal.focus();
  }

  /** Types text into the conversation's CLI (as if pasted). */
  public paste(id: string, text: string): void {
    this.sessions.get(id)?.terminal.paste(text);
  }

  public clear(id: string): void {
    this.sessions.get(id)?.terminal.clear();
  }

  /** The conversation is gone: close its socket and free the terminal. */
  public dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.disposed = true;
    clearTimeout(session.reconnect);
    session.socket?.close();
    session.terminal.dispose();
    session.element.remove();
    this.sessions.delete(id);
  }

  /** Drops the terminals of conversations that no longer exist (deleted from another tab). */
  public prune(ids: ReadonlySet<string>): void {
    for (const id of [...this.sessions.keys()]) {
      if (!ids.has(id)) {
        this.dispose(id);
      }
    }
  }

  private create(id: string, host: HTMLElement): Session {
    const element = document.createElement("div");
    element.className = "h-full w-full";
    // xterm measures its font when it opens: the element has to be in the page by then.
    host.appendChild(element);
    const terminal = new Terminal({
      fontFamily: cssVar("--font-mono") || "Consolas, monospace",
      fontSize: FONT_SIZE,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      theme: theme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    const session: Session = { id, terminal, fit, element, connected: signal(false), disposed: false };
    this.sessions.set(id, session);

    const send = (payload: object): void => {
      if (session.socket?.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify(payload));
      }
    };
    terminal.onData((data) => send({ t: "i", d: data }));
    terminal.onResize(({ cols, rows }) => send({ t: "r", c: cols, r: rows }));
    terminal.attachCustomKeyEventHandler((event) => {
      // Shift+Enter: a new line in the agent's input box (ESC + CR, what Alt+Enter sends).
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey) {
        if (event.type === "keydown") {
          event.preventDefault();
          send({ t: "i", d: "\x1b\r" });
        }
        return false;
      }
      if (event.type !== "keydown" || !event.ctrlKey || event.altKey) {
        return true;
      }
      // Ctrl+C with a selection copies it instead of interrupting the agent.
      if (event.key === "c" && !event.shiftKey && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        terminal.clearSelection();
        return false;
      }
      if (event.key === "C" && event.shiftKey) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        return false;
      }
      // Ctrl+V: the browser pastes (xterm takes the paste event); the CLI must not see ^V.
      return event.key !== "v" && event.key !== "V";
    });

    // Images pasted or dropped on the terminal go to the CLI as a saved file's path. Capture
    // phase: xterm's own paste handler (on its textarea, inside `element`) must not see them.
    element.addEventListener(
      "paste",
      (event) => {
        // Text copied from Office, Teams or a web page carries a picture of itself too: text wins.
        const images = event.clipboardData?.getData("text/plain") ? [] : imageFiles(event.clipboardData);
        if (images.length) {
          event.preventDefault();
          event.stopPropagation();
          void this.attachImages(session, images);
        }
      },
      true,
    );
    element.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    });
    element.addEventListener("drop", (event) => {
      const images = imageFiles(event.dataTransfer);
      if (images.length) {
        event.preventDefault();
        void this.attachImages(session, images);
      }
    });
    return session;
  }

  private async attachImages(session: Session, images: File[]): Promise<void> {
    for (const image of images) {
      try {
        const saved = await this.api.saveConversationImage(session.id, { mimeType: image.type, data: await base64(image) });
        session.terminal.paste(saved.text);
      } catch (error) {
        this.store.toast({ title: "No se pudo adjuntar la imagen", body: apiError(error, String(error)), tone: "err" });
      }
    }
    session.terminal.focus();
  }

  private connect(session: Session): void {
    clearTimeout(session.reconnect);
    // The server replays the recent output: start from a clean screen so nothing shows twice.
    session.terminal.reset();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ id: session.id, cols: String(session.terminal.cols), rows: String(session.terminal.rows) });
    const socket = new WebSocket(`${protocol}://${location.host}/cpty?${params}`);
    session.socket = socket;
    socket.onopen = () => session.connected.set(true);
    socket.onmessage = (message) => session.terminal.write(String(message.data));
    socket.onclose = () => {
      session.connected.set(false);
      // The server restarted or the connection dropped: try again while the conversation is open here.
      if (!session.disposed && session.socket === socket) {
        session.reconnect = setTimeout(() => {
          if (!session.disposed && session.element.isConnected) {
            this.connect(session);
          }
        }, RECONNECT_MS);
      }
    };
  }
}
