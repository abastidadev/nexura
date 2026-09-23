import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from "@angular/core";
import type { QuotaInfo, Run, ServerMessage } from "@nexura/shared";
import { Api, type NexuraConfigView, type StoredEvent } from "./api";

const TABS_KEY = "nexura.tabs";
const THEME_KEY = "nexura.theme";
const RECONNECT_MS = 2000;
const CLOCK_MS = 1000;

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
    effect(() => {
      const theme = this.theme();
      document.documentElement.classList.toggle("light", theme === "light");
      writeStorage(THEME_KEY, theme);
    });
  }

  public async init(): Promise<void> {
    this.connect();
    const [runs, config, quota] = await Promise.all([this.api.listRuns(), this.api.getConfig(), this.api.getQuota()]);
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

  public toggleTheme(): void {
    this.theme.update((theme) => (theme === "dark" ? "light" : "dark"));
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
      case "run":
        this.upsertRun(message.run);
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
