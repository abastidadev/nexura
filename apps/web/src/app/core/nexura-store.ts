import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from "@angular/core";
import { Router } from "@angular/router";
import type { AchievementView, AiSetupSession, Conversation, NexuraSettings, QuotaInfo, Run, ServerMessage, TicketDraft } from "@nexura/shared";
import { setCustomStepLabels, stepLabel, type Tone } from "./format";
import { Api, type NexuraConfigView, type StoredEvent } from "./api";
import { Notifier, type Chime } from "./notifier";
import { readStorage, writeStorage } from "./storage";

export { readStorage, writeStorage };

const TABS_KEY = "nexura.tabs";
const TAB_LABELS_KEY = "nexura.tabLabels";
const TAB_LABEL_MAX = 60;
const THEME_KEY = "nexura.theme";
const RECONNECT_MS = 2000;
const CLOCK_MS = 1000;
const NOTIFY_KEY = "nexura.notifications";
const NOTICES_KEY = "nexura.noticeCenter";
const UNSEEN_REVIEWS_KEY = "nexura.unseenReviews";
/** The Nexura window the user used last: the one that opens what the 3D office asks for. */
const ACTIVE_WINDOW_KEY = "nexura.activeWindow";
const TOAST_MS = 8000;
const MAX_TOASTS = 4;
const MAX_NOTICES = 30;
/** How long a trophy stays on screen before the next one (if any) takes its place. */
const TROPHY_MS = 20_000;

/** Where clicking a toast (or its system notification) takes the user. */
export type ToastLink = { path: string[]; queryParams?: Record<string, string> };

export type Toast = { id: number; title: string; body: string; tone: Tone; runId?: string; link?: ToastLink };
export type Notice = Toast & { createdAt: number; seen: boolean };

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
  private toastSeq = Date.now();
  private readonly runsById = signal<Record<string, Run>>({});
  private readonly conversationsById = signal<Record<string, Conversation>>({});
  private readonly ticketDraftsById = signal<Record<string, TicketDraft>>({});
  private readonly aiSetupById = signal<Record<string, AiSetupSession>>({});
  private readonly eventSignals = new Map<string, WritableSignal<StoredEvent[]>>();
  private readonly loadedEvents = new Set<string>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  public readonly config = signal<NexuraConfigView | null>(null);
  public readonly quota = signal<QuotaInfo | null>(null);
  public readonly connected = signal(false);
  public readonly now = signal(Date.now());
  public readonly openTabs = signal<string[]>(readStorage<string[]>(TABS_KEY, []));
  /** Names the user gave to header tabs (flows, reviews, tickets); terminals rename the conversation itself. */
  public readonly tabLabels = signal<Record<string, string>>(readStorage<Record<string, string>>(TAB_LABELS_KEY, {}));
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
  public readonly notices = signal<Notice[]>(readStorage<Notice[]>(NOTICES_KEY, []).filter((notice) => !notice.seen));
  public readonly unreadNotices = computed(() => this.notices().filter((notice) => !notice.seen).length);
  public readonly notificationsEnabled = signal<boolean>(readStorage<boolean>(NOTIFY_KEY, false));
  /** Trophies waiting to be shown, the one on screen first (PlayStation-style, top right). */
  public readonly trophies = signal<AchievementView[]>([]);
  /** Trophies won and not yet seen on the Logros page. */
  public readonly freshAchievements = signal(0);
  /** Bumps with every trophy won, for views that show achievements to reload. */
  public readonly achievementsVersion = signal(0);
  /** Coins in the wallet (null until first known); bumps `rewardsVersion` whenever they move. */
  public readonly coins = signal<number | null>(null);
  public readonly rewardsVersion = signal(0);
  private trophyTimer?: ReturnType<typeof setTimeout>;
  private readonly windowId = crypto.randomUUID();
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
  /** Tickets section: drafts and created tickets, the most recently touched first. */
  public readonly ticketDrafts = computed(() => Object.values(this.ticketDraftsById()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  public readonly thinkingDrafts = computed(() => this.ticketDrafts().filter((draft) => draft.status === "thinking").length);
  /** Setup IA section: assessments and creations, the most recently touched first. */
  public readonly aiSetupSessions = computed(() => Object.values(this.aiSetupById()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  public readonly thinkingAiSetup = computed(() => this.aiSetupSessions().filter((session) => session.status === "thinking").length);
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
    effect(() => writeStorage(TAB_LABELS_KEY, this.tabLabels()));
    effect(() => writeStorage(NOTIFY_KEY, this.notificationsEnabled()));
    effect(() => writeStorage(NOTICES_KEY, this.notices()));
    effect(() => writeStorage(UNSEEN_REVIEWS_KEY, this.unseenReviews()));
    // The tab title and favicon show notices that have not been reviewed yet.
    effect(() => this.notifier.attention.set(this.unreadNotices()));
    effect(() => {
      document.documentElement.classList.toggle("light", this.theme() === "light");
      writeStorage(THEME_KEY, this.themePreference());
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => this.systemDark.set(event.matches));
    // The office in its own window opens runs in the Nexura window used last (see "open").
    const claim = (): void => writeStorage(ACTIVE_WINDOW_KEY, this.windowId);
    if (document.hasFocus() || !readStorage<string | null>(ACTIVE_WINDOW_KEY, null)) {
      claim();
    }
    window.addEventListener("focus", claim);
    window.addEventListener("pagehide", () => {
      if (readStorage<string | null>(ACTIVE_WINDOW_KEY, null) === this.windowId) {
        writeStorage(ACTIVE_WINDOW_KEY, null);
      }
    });
  }

  public async init(): Promise<void> {
    this.connect();
    void this.refreshAchievements();
    void this.refreshCoins();
    const [runs, config, quota, settings, conversations, drafts, setups] = await Promise.all([
      this.api.listRuns(),
      this.api.getConfig(),
      this.api.getQuota(),
      this.api.getSettings(),
      this.api.listConversations(),
      this.loadTicketDrafts(),
      this.loadAiSetup(),
    ]);
    this.settings.set(settings);
    this.conversationsById.set(Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])));
    this.runsById.set(Object.fromEntries(runs.map((run) => [run.id, run])));
    this.setConfig(config);
    if (quota) {
      this.quota.set(quota);
    }
    // Drop tabs (and their names) of flows, reviews, terminals, tickets and Setup IA sessions that no longer exist.
    const exists = (id: string): boolean =>
      runs.some((run) => run.id === id) ||
      conversations.some((conversation) => conversation.id === id) ||
      (drafts ?? []).some((draft) => draft.id === id) ||
      (setups ?? []).some((session) => session.id === id);
    this.openTabs.update((tabs) => tabs.filter(exists));
    this.tabLabels.update((labels) => Object.fromEntries(Object.entries(labels).filter(([id]) => exists(id))));
    this.unseenReviews.update((ids) => ids.filter((id) => runs.some((run) => run.id === id)));
    // Reviews left unseen by older versions also need an entry in the new center.
    const unseen = new Set(this.unseenReviews());
    this.notices.update((notices) => {
      const missing = runs.filter((run) => unseen.has(run.id) && isPrReview(run) && !notices.some((notice) => notice.runId === run.id));
      return [
        ...missing.map((run): Notice => ({
          id: ++this.toastSeq,
          title: `PR #${run.request.prReview?.id ?? "?"} · ${run.request.prReview?.title ?? "Revisión terminada"}`,
          body: "Revisión terminada. Consulta los resultados.",
          tone: "accent",
          runId: run.id,
          link: reviewLink(run),
          createdAt: Date.now(),
          seen: false,
        })),
        ...notices,
      ].slice(0, MAX_NOTICES);
    });
  }

  /** How many trophies wait on the Logros page; a failure just leaves the badge off. */
  public async refreshAchievements(): Promise<void> {
    const summary = await this.api.getAchievements().catch(() => undefined);
    if (summary) {
      this.freshAchievements.set(summary.achievements.filter((achievement) => achievement.fresh).length);
    }
  }

  /** A trophy was won: its toast (after any already on screen), its chime and an entry in the notice center. No system notification: it would be a second toast. */
  private trophy(achievement: AchievementView): void {
    this.freshAchievements.update((count) => count + 1);
    this.achievementsVersion.update((version) => version + 1);
    const wasEmpty = this.trophies().length === 0;
    this.trophies.update((queue) => [...queue, achievement]);
    if (wasEmpty) {
      this.showTrophy();
    }
    const title = `🏆 ${achievement.title}`;
    const link: ToastLink = { path: ["/achievements"] };
    this.notices.update((notices) => [{ id: ++this.toastSeq, title, body: "Logro desbloqueado", tone: "accent" as Tone, link, createdAt: Date.now(), seen: false }, ...notices].slice(0, MAX_NOTICES));
  }

  /** Puts the first trophy of the queue on screen, with its chime, and schedules the next. */
  private showTrophy(): void {
    clearTimeout(this.trophyTimer);
    if (!this.trophies().length) {
      return;
    }
    if (this.notifier.soundEnabled()) {
      this.notifier.playTrophy();
    }
    this.trophyTimer = setTimeout(() => this.dismissTrophy(), TROPHY_MS);
  }

  public dismissTrophy(): void {
    this.trophies.update((queue) => queue.slice(1));
    this.showTrophy();
  }

  /** The wallet's balance, for the sidebar; a failure just leaves it off. */
  public async refreshCoins(): Promise<void> {
    const summary = await this.api.getRewards().catch(() => undefined);
    if (summary) {
      this.coins.set(summary.coins);
    }
  }

  /** Coins came in or went out: the balance, and a quiet toast for what came in (no notice, no system notification). */
  private coinsMoved(delta: number, balance: number, reason: string): void {
    this.coins.set(balance);
    this.rewardsVersion.update((version) => version + 1);
    if (delta <= 0) {
      return;
    }
    const toast: Toast = { id: ++this.toastSeq, title: `🪙 +${delta} monedas`, body: reason, tone: "accent", link: { path: ["/shop"] } };
    this.toasts.update((toasts) => [...toasts, toast].slice(-MAX_TOASTS));
    setTimeout(() => this.dismissToast(toast.id), TOAST_MS);
  }

  /** The Logros page was opened: nothing is new any more. */
  public async markAchievementsSeen(): Promise<void> {
    this.freshAchievements.set(0);
    await this.api.markAchievementsSeen().catch(() => undefined);
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

  /** Drafts of the Tickets section; a failure leaves the rest of the app working. */
  private async loadTicketDrafts(): Promise<TicketDraft[] | undefined> {
    const drafts = await this.api.listTicketDrafts().catch(() => undefined);
    if (drafts) {
      this.ticketDraftsById.set(Object.fromEntries(drafts.map((draft) => [draft.id, draft])));
    }
    return drafts;
  }

  /** Sessions of the Setup IA section; a failure leaves the rest of the app working. */
  private async loadAiSetup(): Promise<AiSetupSession[] | undefined> {
    const sessions = await this.api.listAiSetup().catch(() => undefined);
    if (sessions) {
      this.aiSetupById.set(Object.fromEntries(sessions.map((session) => [session.id, session])));
    }
    return sessions;
  }

  public upsertAiSetup(session: AiSetupSession): void {
    this.aiSetupById.update((all) => ({ ...all, [session.id]: session }));
  }

  public forgetAiSetup(id: string): void {
    this.aiSetupById.update(({ [id]: _removed, ...rest }) => rest);
  }

  public ticketDraft(id: string): Signal<TicketDraft | undefined> {
    return computed(() => this.ticketDraftsById()[id]);
  }

  public upsertTicketDraft(draft: TicketDraft): void {
    this.ticketDraftsById.update((all) => ({ ...all, [draft.id]: draft }));
  }

  public forgetTicketDraft(id: string): void {
    this.ticketDraftsById.update(({ [id]: _removed, ...rest }) => rest);
    this.closeTab(id);
    this.renameTab(id, "");
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

  /** The tab's own name; empty = back to the automatic one. */
  public renameTab(id: string, label: string): void {
    const name = label.trim().slice(0, TAB_LABEL_MAX);
    this.tabLabels.update(({ [id]: _previous, ...rest }) => (name ? { ...rest, [id]: name } : rest));
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
    this.notices.update((notices) => notices.filter((notice) => notice.runId !== id));
    if (this.router.url.startsWith(`/runs/${id}`)) {
      void this.router.navigate(["/runs"]);
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

  /** Opening the center acknowledges notices, including finished PR reviews, without navigating to them. */
  public markNoticesSeen(): void {
    const reviewIds = new Set(this.notices().map((notice) => notice.runId).filter((id): id is string => !!id));
    this.unseenReviews.update((ids) => ids.filter((id) => !reviewIds.has(id)));
    this.notices.update((notices) => notices.map((notice) => notice.seen ? notice : { ...notice, seen: true }));
  }

  /** The reviewed items stay visible while the center is open, then leave the list. */
  public clearSeenNotices(): void {
    this.notices.update((notices) => notices.filter((notice) => !notice.seen));
  }

  public dismissNotice(id: number): void {
    const notice = this.notices().find((item) => item.id === id);
    if (notice?.runId) {
      this.markReviewSeen(notice.runId);
    }
    this.notices.update((notices) => notices.filter((item) => item.id !== id));
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
    this.notices.update((notices) => [{ ...toast, createdAt: Date.now(), seen: false }, ...notices].slice(0, MAX_NOTICES));
    setTimeout(() => this.dismissToast(toast.id), TOAST_MS);
    if (this.notificationsEnabled() && this.notifier.inBackground() && "Notification" in window && Notification.permission === "granted") {
      // Shown by the OS (on Windows, a toast of the notification centre). Nexura plays its own chime.
      const notification = new Notification(message.title, { body: message.body, tag: message.runId, silent: this.notifier.soundEnabled() });
      notification.onclick = () => {
        window.focus();
        notification.close();
        this.dismissNotice(toast.id);
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
      void this.loadTicketDrafts();
      void this.loadAiSetup();
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
      case "ticketDraft":
        this.upsertTicketDraft(message.draft);
        break;
      case "ticketDraftDeleted":
        this.forgetTicketDraft(message.id);
        break;
      case "aiSetup":
        this.upsertAiSetup(message.session);
        break;
      case "aiSetupDeleted":
        this.forgetAiSetup(message.id);
        break;
      case "achievement":
        this.trophy(message.achievement);
        break;
      case "coins":
        this.coinsMoved(message.delta, message.balance, message.reason);
        break;
      case "open": {
        // Only one window follows: the one used last (any, if none is known).
        const active = readStorage<string | null>(ACTIVE_WINDOW_KEY, null);
        if (active && active !== this.windowId) {
          break;
        }
        const [page, runId] = message.path;
        if (page === "/runs" && runId) {
          this.openRun(runId);
        } else {
          void this.router.navigate(message.path, { queryParams: message.queryParams });
        }
        break;
      }
      case "event":
        this.eventSignal(message.stepRunId).update((current) =>
          mergeEvents(current, [{ seq: message.seq, ts: message.ts, event: message.event }]),
        );
        break;
    }
  }
}
