import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from "@angular/core";
import { Router } from "@angular/router";
import type { Conversation, NexuraSettings, QuotaInfo, Run, ServerMessage } from "@nexura/shared";
import { setCustomStepLabels, stepLabel, type Tone } from "./format";
import { Api, type NexuraConfigView, type StoredEvent } from "./api";
import { Notifier, type Chime } from "./notifier";
import { readStorage, writeStorage } from "./storage";

export { readStorage, writeStorage };

const TABS_KEY = "nexura.tabs";
const THEME_KEY = "nexura.theme";
const RECONNECT_MS = 2000;
const CLOCK_MS = 1000;
const NOTIFY_KEY = "nexura.notifications";
const UNSEEN_REVIEWS_KEY = "nexura.unseenReviews";
const TOAST_MS = 8000;
const MAX_TOASTS = 4;

/** Where clicking a toast (or its system notification) takes the user. */
export type ToastLink = { path: string[]; queryParams?: Record<string, string> };

export type Toast = { id: number; title: string; body: string; tone: Tone; runId?: string; link?: ToastLink };

/** A PR review run (Revisiones) rather than a ticket flow. */
export function isPrReview(run: Run): boolean {
  return run.request.kind === "prReview";
}

/** Revisiones, on the review's repo and run. */
export function reviewLink(run: Run): ToastLink {
  return { path: ["/reviews"], queryParams: { repo: run.request.repos[0] ?? "", run: run.id } };
}

export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

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
  private readonly notifier = inject(Notifier);
  private toastSeq = 0;
  private readonly runsById = signal<Record<string, Run>>({});
  private readonly conversationsById = signal<Record<string, Conversation>>({});
  private readonly eventSignals = new Map<string, WritableSignal<StoredEvent[]>>();
  private readonly loadedEvents = new Set<string>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  public readonly config = signal<NexuraConfigView | null>(null);
  public readonly quota = signal<QuotaInfo | null>(null);
  public readonly connected = signal(false);
  public readonly now = signal(Date.now());
  public readonly openTabs = signal<string[]>(readStorage<string[]>(TABS_KEY, []));
  /** What the user picked; "system" follows the OS setting. */
  public readonly themePreference = signal<ThemePreference>(readStorage<ThemePreference>(THEME_KEY, "system"));
  private readonly systemDark = signal(matchMedia("(prefers-color-scheme: dark)").matches);
  /** The palette actually shown. */
  public readonly theme = computed<Theme>(() => {
    const preference = this.themePreference();
    return preference === "system" ? (this.systemDark() ? "dark" : "light") : preference;
  });
  public readonly settings = signal<NexuraSettings | null>(null);
  public readonly toasts = signal<Toast[]>([]);
  public readonly notificationsEnabled = signal<boolean>(readStorage<boolean>(NOTIFY_KEY, false));
  /** Runs waiting for the user (paused on a breakpoint or an approval). */
  public readonly needsAttention = computed(() => this.runs().filter((run) => run.status === "paused").length);
  /** PR reviews that finished while the user was not looking at them. */
  public readonly unseenReviews = signal<string[]>(readStorage<string[]>(UNSEEN_REVIEWS_KEY, []));

  public readonly runs = computed(() =>
    Object.values(this.runsById()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  /** Terminal conversations: pinned first, then the most recently active. */
  public readonly conversations = computed(() =>
    Object.values(this.conversationsById()).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)),
  );
  public readonly runningConversations = computed(() => this.conversations().filter((conversation) => conversation.status === "running").length);
  public readonly activeCount = computed(
    () => this.runs().filter((run) => !isPrReview(run) && ["running", "queued", "waiting-rate-limit", "paused"].includes(run.status)).length,
  );
  /** PR reviews queued or running (Revisiones tab). */
  public readonly activeReviews = computed(
    () => this.runs().filter((run) => isPrReview(run) && ["running", "queued", "waiting-rate-limit"].includes(run.status)).length,
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
    effect(() => writeStorage(UNSEEN_REVIEWS_KEY, this.unseenReviews()));
    // "(n)" on the tab title and the favicon while something waits for the user.
    effect(() => this.notifier.attention.set(this.needsAttention() + this.unseenReviews().length));
    effect(() => {
      document.documentElement.classList.toggle("light", this.theme() === "light");
      writeStorage(THEME_KEY, this.themePreference());
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => this.systemDark.set(event.matches));
  }

  public async init(): Promise<void> {
    this.connect();
    const [runs, config, quota, settings, conversations] = await Promise.all([
      this.api.listRuns(),
      this.api.getConfig(),
      this.api.getQuota(),
      this.api.getSettings(),
      this.api.listConversations(),
    ]);
    this.settings.set(settings);
    this.conversationsById.set(Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])));
    this.runsById.set(Object.fromEntries(runs.map((run) => [run.id, run])));
    this.setConfig(config);
    if (quota) {
      this.quota.set(quota);
    }
    // Drop tabs of flows, reviews and terminals that no longer exist.
    this.openTabs.update((tabs) => tabs.filter((id) => runs.some((run) => run.id === id) || conversations.some((conversation) => conversation.id === id)));
    this.unseenReviews.update((ids) => ids.filter((id) => runs.some((run) => run.id === id)));
  }

  public async reloadConfig(): Promise<void> {
    this.setConfig(await this.api.getConfig());
  }

  private setConfig(config: NexuraConfigView): void {
    setCustomStepLabels(config.steps);
    this.config.set(config);
  }

  public run(id: string): Signal<Run | undefined> {
    return computed(() => this.runsById()[id]);
  }

  public upsertConversation(conversation: Conversation): void {
    this.conversationsById.update((all) => ({ ...all, [conversation.id]: conversation }));
  }

  public forgetConversation(id: string): void {
    this.conversationsById.update(({ [id]: _removed, ...rest }) => rest);
    this.closeTab(id);
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

  /** Drag & drop of the header tabs: puts `id` right before or after `targetId`. */
  public moveTab(id: string, targetId: string, side: "before" | "after"): void {
    if (id === targetId) {
      return;
    }
    this.openTabs.update((tabs) => {
      const rest = tabs.filter((tab) => tab !== id);
      const index = rest.indexOf(targetId);
      if (index < 0 || !tabs.includes(id)) {
        return tabs;
      }
      rest.splice(side === "before" ? index : index + 1, 0, id);
      return rest;
    });
  }

  /** Deletes a finished run on the server and drops it (and its tab) here. */
  public async deleteRun(id: string, deleteBranches = false): Promise<void> {
    await this.api.deleteRun(id, deleteBranches);
    this.forgetRun(id);
  }

  /** The user opened the finished review: it no longer counts as waiting. */
  public markReviewSeen(id: string): void {
    if (this.unseenReviews().includes(id)) {
      this.unseenReviews.update((ids) => ids.filter((candidate) => candidate !== id));
    }
  }

  private forgetRun(id: string): void {
    this.runsById.update(({ [id]: _removed, ...rest }) => rest);
    this.closeTab(id);
    this.markReviewSeen(id);
    if (this.router.url.startsWith(`/runs/${id}`)) {
      void this.router.navigate(["/"]);
    }
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
    const run = this.runsById()[runId];
    if (run && isPrReview(run)) {
      this.follow(reviewLink(run));
      return;
    }
    this.openTab(runId);
    void this.router.navigate(["/runs", runId]);
  }

  /** Goes where a toast points: its link, else its run. */
  public openToast(toast: Omit<Toast, "id">): void {
    if (toast.link) {
      this.follow(toast.link);
    } else if (toast.runId) {
      this.openRun(toast.runId);
    }
  }

  private follow(link: ToastLink): void {
    void this.router.navigate(link.path, { queryParams: link.queryParams });
  }

  /** In-app toast always; system notification too when the page is not in front. */
  public toast(message: Omit<Toast, "id">): void {
    const toast = { ...message, id: ++this.toastSeq };
    this.toasts.update((toasts) => [...toasts, toast].slice(-MAX_TOASTS));
    setTimeout(() => this.dismissToast(toast.id), TOAST_MS);
    if (this.notificationsEnabled() && this.notifier.inBackground() && "Notification" in window && Notification.permission === "granted") {
      // Shown by the OS (on Windows, a toast of the notification centre). Nexura plays its own chime.
      const notification = new Notification(message.title, { body: message.body, tag: message.runId, silent: this.notifier.soundEnabled() });
      notification.onclick = () => {
        window.focus();
        notification.close();
        this.openToast(message);
      };
    }
  }

  /** Chime and blinking tab title together with the toast. */
  private alert(chime: Chime, message: Omit<Toast, "id">): void {
    this.notifier.alert(chime, `${chime === "err" ? "✖" : chime === "warn" ? "⏸" : "✔"} ${message.title}`);
    this.toast(message);
  }

  /** Cycles system → light → dark. */
  public cycleTheme(): void {
    const order: ThemePreference[] = ["system", "light", "dark"];
    this.themePreference.update((current) => order[(order.indexOf(current) + 1) % order.length]!);
  }

  /** Turns a status change into a notification when it needs (or informs) the user. */
  private announce(run: Run): void {
    if (isPrReview(run)) {
      this.announceReview(run);
      return;
    }
    const firstLine = run.request.ticketText.split("\n")[0] ?? run.id;
    const title = run.request.ticketId ? `#${run.request.ticketId} · ${firstLine}` : firstLine;
    const step = run.steps.at(-1);
    const failedStep = step ? stepLabel(step.step) : "";
    switch (run.status) {
      case "done":
        this.alert("ok", { title, body: `Terminado · ${run.pullRequests?.length ? "PR creada" : "ramas en local"}`, tone: "ok", runId: run.id });
        break;
      case "failed":
        this.alert("err", { title, body: `Falló en ${failedStep}: ${run.error ?? ""}`.slice(0, 180), tone: "err", runId: run.id });
        break;
      case "paused": {
        const pending = run.pendingStep;
        const body = pending?.prDrafts
          ? "Revisa y aprueba la PR antes de subirla."
          : pending?.replies
            ? "Revisa las respuestas a la revisión antes de publicarlas."
            : `Pausado antes de ${pending ? stepLabel(pending.step) : "el siguiente paso"}.`;
        this.alert("warn", { title, body, tone: "warn", runId: run.id });
        break;
      }
      case "waiting-rate-limit":
        this.toast({ title, body: "Esperando a que se libere la cuota del plan.", tone: "warn", runId: run.id });
        break;
    }
  }

  /** A finished review counts as unseen until opened, unless the user is already looking at it. */
  private announceReview(run: Run): void {
    const target = run.request.prReview;
    const title = target ? `PR #${target.id} · ${target.title}` : (run.request.ticketText.split("\n")[0] ?? run.id);
    const link = reviewLink(run);
    if (run.status === "done") {
      const comments = run.prReview?.comments ?? [];
      const important = comments.filter((comment) => comment.severity === "blocker" || comment.severity === "major").length;
      const body = comments.length
        ? `Revisada · ${comments.length} comentario(s)${important ? `, ${important} importante(s)` : ""}`
        : "Revisada · sin comentarios";
      const watching = !this.notifier.inBackground() && this.router.url.includes(`run=${run.id}`);
      if (!watching && !run.prReview?.published && !this.unseenReviews().includes(run.id)) {
        this.unseenReviews.update((ids) => [...ids, run.id]);
      }
      this.alert("ok", { title, body, tone: important ? "warn" : "ok", runId: run.id, link });
    } else if (run.status === "failed") {
      this.alert("err", { title, body: `Falló la revisión: ${run.error ?? ""}`.slice(0, 180), tone: "err", runId: run.id, link });
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
      void this.api
        .listConversations()
        .then((conversations) => this.conversationsById.set(Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation]))));
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
      case "runDeleted":
        this.forgetRun(message.runId);
        break;
      case "conversation":
        this.upsertConversation(message.conversation);
        break;
      case "conversationDeleted":
        this.forgetConversation(message.id);
        break;
      case "event":
        this.eventSignal(message.stepRunId).update((current) =>
          mergeEvents(current, [{ seq: message.seq, ts: message.ts, event: message.event }]),
        );
        break;
    }
  }
}
