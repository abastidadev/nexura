import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from "@angular/core";
import { Router } from "@angular/router";
import type { NexuraSettings, QuotaInfo, Run, ServerMessage } from "@nexura/shared";
import { STEP_LABELS, type Tone } from "./format";
import { Api, type NexuraConfigView, type StoredEvent } from "./api";

const TABS_KEY = "nexura.tabs";
const THEME_KEY = "nexura.theme";
const RECONNECT_MS = 2000;
const CLOCK_MS = 1000;
const NOTIFY_KEY = "nexura.notifications";
const TOAST_MS = 8000;
const MAX_TOASTS = 4;

export type Toast = { id: number; title: string; body: string; tone: Tone; runId?: string };

export type Theme = "dark" | "light";

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): the UI still works, it just forgets tabs.
  }
}

function mergeEvents(current: StoredEvent[], incoming: StoredEvent[]): StoredEvent[] {
  const bySeq = new Map(current.map((item) => [item.seq, item]));
  for (const item of incoming) {
    bySeq.set(item.seq, item);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** App-wide state: runs, config, quota and live events, kept in sync over the WebSocket. */
@Service()
export class NexuraStore {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private toastSeq = 0;
  private readonly runsById = signal<Record<string, Run>>({});
  private readonly eventSignals = new Map<string, WritableSignal<StoredEvent[]>>();
  private readonly loadedEvents = new Set<string>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  public readonly config = signal<NexuraConfigView | null>(null);
  public readonly quota = signal<QuotaInfo | null>(null);
  public readonly connected = signal(false);
  public readonly now = signal(Date.now());
  public readonly openTabs = signal<string[]>(readStorage<string[]>(TABS_KEY, []));
  public readonly theme = signal<Theme>(readStorage<Theme>(THEME_KEY, "dark"));
  public readonly settings = signal<NexuraSettings | null>(null);
  public readonly toasts = signal<Toast[]>([]);
  public readonly notificationsEnabled = signal<boolean>(readStorage<boolean>(NOTIFY_KEY, false));
  /** Runs waiting for the user (paused on a breakpoint or an approval). */
  public readonly needsAttention = computed(() => this.runs().filter((run) => run.status === "paused").length);

  public readonly runs = computed(() =>
    Object.values(this.runsById()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  public readonly activeCount = computed(
    () => this.runs().filter((run) => ["running", "queued", "waiting-rate-limit", "paused"].includes(run.status)).length,
  );

  public constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      clearTimeout(this.reconnectTimer);
      this.socket?.close();
    });
    effect(() => writeStorage(TABS_KEY, this.openTabs()));
    effect(() => writeStorage(NOTIFY_KEY, this.notificationsEnabled()));
    // "(n) " prefix on the page title while runs wait for the user; the route title stays.
    effect(() => {
      const waiting = this.needsAttention();
      const base = document.title.replace(/^\(\d+\) /, "");
      document.title = waiting ? `(${waiting}) ${base}` : base;
    });
    effect(() => {
      const theme = this.theme();
      document.documentElement.classList.toggle("light", theme === "light");
      writeStorage(THEME_KEY, theme);
    });
  }

  public async init(): Promise<void> {
    this.connect();
    const [runs, config, quota, settings] = await Promise.all([
      this.api.listRuns(),
      this.api.getConfig(),
      this.api.getQuota(),
      this.api.getSettings(),
    ]);
    this.settings.set(settings);
    this.runsById.set(Object.fromEntries(runs.map((run) => [run.id, run])));
    this.config.set(config);
    if (quota) {
      this.quota.set(quota);
    }
    // Drop tabs of runs that no longer exist.
    this.openTabs.update((tabs) => tabs.filter((id) => runs.some((run) => run.id === id)));
  }

  public async reloadConfig(): Promise<void> {
    this.config.set(await this.api.getConfig());
  }

  public run(id: string): Signal<Run | undefined> {
    return computed(() => this.runsById()[id]);
  }

  public upsertRun(run: Run): void {
    this.runsById.update((runs) => ({ ...runs, [run.id]: run }));
  }

  /** Events of one step: loads the history once, then live events are appended. */
  public events(runId: string, stepRunId: string): Signal<StoredEvent[]> {
    const events = this.eventSignal(stepRunId);
    if (!this.loadedEvents.has(stepRunId)) {
      this.loadedEvents.add(stepRunId);
      this.api
        .getEvents(runId, stepRunId)
        .then((history) => events.update((current) => mergeEvents(current, history)))
        .catch(() => this.loadedEvents.delete(stepRunId));
    }
    return events;
  }

  public openTab(id: string): void {
    this.openTabs.update((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
  }

  public closeTab(id: string): void {
    this.openTabs.update((tabs) => tabs.filter((tab) => tab !== id));
  }

  public async toggleNotifications(): Promise<void> {
    if (this.notificationsEnabled()) {
      this.notificationsEnabled.set(false);
      return;
    }
    const permission = "Notification" in window ? await Notification.requestPermission() : "denied";
    this.notificationsEnabled.set(permission === "granted");
    if (permission !== "granted") {
      this.toast({ title: "Notificaciones bloqueadas", body: "Permítelas para este sitio en el navegador.", tone: "warn" });
    }
  }

  public dismissToast(id: number): void {
    this.toasts.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }

  public openRun(runId: string): void {
    this.openTab(runId);
    void this.router.navigate(["/runs", runId]);
  }

  /** In-app toast always; system notification too when the page is not in front. */
  public toast(message: Omit<Toast, "id">): void {
    const toast = { ...message, id: ++this.toastSeq };
    this.toasts.update((toasts) => [...toasts, toast].slice(-MAX_TOASTS));
    setTimeout(() => this.dismissToast(toast.id), TOAST_MS);
    const inBackground = document.visibilityState !== "visible" || !document.hasFocus();
    if (this.notificationsEnabled() && inBackground && "Notification" in window && Notification.permission === "granted") {
      const notification = new Notification(message.title, { body: message.body, tag: message.runId });
      notification.onclick = () => {
        window.focus();
        if (message.runId) {
          this.openRun(message.runId);
        }
      };
    }
  }

  public toggleTheme(): void {
    this.theme.update((theme) => (theme === "dark" ? "light" : "dark"));
  }

  /** Turns a status change into a notification when it needs (or informs) the user. */
  private announce(run: Run): void {
    const firstLine = run.request.ticketText.split("\n")[0] ?? run.id;
    const title = run.request.ticketId ? `#${run.request.ticketId} · ${firstLine}` : firstLine;
    const step = run.steps.at(-1);
    const stepLabel = step ? (STEP_LABELS[step.step] ?? step.step) : "";
    switch (run.status) {
      case "done":
        this.toast({ title, body: `Terminado · ${run.pullRequests?.length ? "PR creada" : "ramas en local"}`, tone: "ok", runId: run.id });
        break;
      case "failed":
        this.toast({ title, body: `Falló en ${stepLabel}: ${run.error ?? ""}`.slice(0, 180), tone: "err", runId: run.id });
        break;
      case "paused": {
        const pending = run.pendingStep;
        const body = pending?.prDrafts
          ? "Revisa y aprueba la PR antes de subirla."
          : pending?.replies
            ? "Revisa las respuestas a la revisión antes de publicarlas."
            : `Pausado antes de ${pending ? (STEP_LABELS[pending.step] ?? pending.step) : "el siguiente paso"}.`;
        this.toast({ title, body, tone: "warn", runId: run.id });
        break;
      }
      case "waiting-rate-limit":
        this.toast({ title, body: "Esperando a que se libere la cuota del plan.", tone: "warn", runId: run.id });
        break;
    }
  }

  private eventSignal(stepRunId: string): WritableSignal<StoredEvent[]> {
    let events = this.eventSignals.get(stepRunId);
    if (!events) {
      events = signal<StoredEvent[]>([]);
      this.eventSignals.set(stepRunId, events);
    }
    return events;
  }

  private connect(): void {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.connected.set(true);
      // Catch up on anything missed while disconnected.
      void this.api.listRuns().then((runs) => runs.forEach((run) => this.upsertRun(run)));
    };
    socket.onmessage = (message) => this.handle(JSON.parse(String(message.data)) as ServerMessage);
    socket.onclose = () => {
      this.connected.set(false);
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "run": {
        const previous = this.runsById()[message.run.id];
        this.upsertRun(message.run);
        if (previous && previous.status !== message.run.status) {
          this.announce(message.run);
        }
        break;
      }
      case "notice":
        this.toast({ title: message.title, body: message.body, tone: message.level === "warn" ? "warn" : "info", runId: message.runId });
        break;
      case "quota":
        this.quota.set(message.quota);
        break;
      case "event":
        this.eventSignal(message.stepRunId).update((current) =>
          mergeEvents(current, [{ seq: message.seq, ts: message.ts, event: message.event }]),
        );
        break;
    }
  }
}
