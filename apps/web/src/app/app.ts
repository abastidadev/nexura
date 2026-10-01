import { DatePipe } from "@angular/common";
import { Component, computed, effect, ElementRef, HostListener, inject, signal, viewChild, type OnInit } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { Api } from "./core/api";
import { RUN_STATUS, TONE_CLASSES, type Tone } from "./core/format";
import { draftStatus, draftTitle } from "./features/tickets/ticket-format";
import { setupStatus, setupTitle } from "./features/ai-setup/ai-setup-format";
import { isPrReview, NexuraStore, reviewLink, type Notice, type Toast } from "./core/nexura-store";
import { Notifier } from "./core/notifier";
import { readStorage, writeStorage } from "./core/storage";
import { Icon, type IconName } from "./shared/icon";
import { QuotaMeter } from "./shared/quota-meter";
import { TrophyToast } from "./shared/trophy-toast";

const COLLAPSED_KEY = "nexura.sidebarCollapsed";

type NavItem = { path: string; label: string; icon: IconName };

/** A header tab: a flow, a PR review or a terminal conversation. */
type HeaderTab = {
  id: string;
  icon: IconName;
  label: string;
  title: string;
  status: string;
  live: boolean;
  dot: string;
  link: string[];
  queryParams?: Record<string, string>;
  /** Open PR comment threads (flows only). */
  comments: number;
};

@Component({
  selector: "nx-root",
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DatePipe, QuotaMeter, Icon, TrophyToast],
  templateUrl: "./app.html",
  host: { class: "flex h-full flex-col" },
})
export class App implements OnInit {
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  protected readonly store = inject(NexuraStore);
  protected readonly notifier = inject(Notifier);
  protected readonly loadError = signal<string | null>(null);
  protected readonly noticeCenterOpen = signal(false);
  protected readonly toastDot: Record<Tone, string> = {
    ok: "bg-ok",
    err: "bg-err",
    warn: "bg-warn",
    info: "bg-info",
    accent: "bg-accent",
    muted: "bg-muted",
  };

  protected readonly primaryNav: NavItem[] = [
    { path: "/", label: "Panel", icon: "dashboard" },
    { path: "/runs", label: "Flujos", icon: "flows" },
    { path: "/reviews", label: "Revisiones", icon: "reviews" },
    { path: "/tickets", label: "Tickets", icon: "ticket" },
    { path: "/ai-setup", label: "Setup IA", icon: "wand" },
    { path: "/terminal", label: "Terminal", icon: "terminal" },
    { path: "/agents", label: "Agentes", icon: "agents" },
    { path: "/office-3d", label: "Oficina 3D", icon: "office" },
    { path: "/achievements", label: "Logros", icon: "trophy" },
  ];
  protected readonly systemNav: NavItem[] = [
    { path: "/metrics", label: "Métricas", icon: "metrics" },
    { path: "/config", label: "Configuración", icon: "settings" },
  ];

  /** Icon-only sidebar, to leave more room for the terminal and the run view. */
  protected readonly collapsed = signal<boolean>(readStorage<boolean>(COLLAPSED_KEY, false));

  protected readonly themeIcon = computed<IconName>(() => {
    const preference = this.store.themePreference();
    return preference === "system" ? "monitor" : preference === "light" ? "sun" : "moon";
  });
  protected readonly themeLabel = computed(() => {
    const labels = { system: "Tema: el del sistema", light: "Tema: claro", dark: "Tema: oscuro" };
    return `${labels[this.store.themePreference()]}. Pulsa para cambiarlo`;
  });

  /** The banner waits a moment so a quick reconnect (or the first load) does not flash it. */
  private readonly everConnected = signal(false);
  protected readonly showDisconnected = signal(false);

  /** Everything open in the header: flows, PR reviews, tickets and terminal conversations, with the names the user gave them. */
  protected readonly tabs = computed<HeaderTab[]>(() => {
    const labels = this.store.tabLabels();
    return this.autoTabs().map((tab) => (labels[tab.id] && tab.icon !== "terminal" ? { ...tab, label: labels[tab.id]! } : tab));
  });

  private readonly autoTabs = computed<HeaderTab[]>(() => {
    const runs = new Map(this.store.runs().map((run) => [run.id, run]));
    const conversations = new Map(this.store.conversations().map((conversation) => [conversation.id, conversation]));
    const drafts = new Map(this.store.ticketDrafts().map((draft) => [draft.id, draft]));
    const setups = new Map(this.store.aiSetupSessions().map((session) => [session.id, session]));
    return this.store.openTabs().flatMap((id): HeaderTab[] => {
      const run = runs.get(id);
      if (run) {
        const status = RUN_STATUS[run.status];
        const common = { id, status: status.label, live: status.live, dot: TONE_CLASSES[status.tone].dot };
        if (isPrReview(run)) {
          const link = reviewLink(run);
          const pr = run.request.prReview;
          return [{
            ...common,
            icon: "reviews",
            label: `PR #${pr?.id ?? "?"}`,
            title: `Revisión · ${pr?.title ?? run.request.repos[0] ?? ""}`,
            link: link.path,
            queryParams: link.queryParams,
            comments: 0,
          }];
        }
        return [{
          ...common,
          icon: "flows",
          label: run.request.ticketId ? `#${run.request.ticketId}` : run.request.ticketText.split("\n")[0]!.slice(0, 28),
          title: run.request.ticketText.split("\n")[0] ?? "",
          link: ["/runs", id],
          comments: run.reviewWatch?.prStatus === "active" ? run.reviewWatch.activeThreads : 0,
        }];
      }
      const conversation = conversations.get(id);
      if (conversation) {
        const running = conversation.status === "running";
        return [{
          id,
          icon: "terminal",
          label: conversation.title.slice(0, 28),
          title: `Terminal · ${conversation.title}`,
          status: running ? "En marcha" : "Detenida",
          live: running,
          dot: running ? "bg-ok" : "bg-muted",
          link: ["/terminal"],
          queryParams: { c: id },
          comments: 0,
        }];
      }
      const draft = drafts.get(id);
      if (draft) {
        const state = draftStatus(draft);
        const title = draftTitle(draft);
        return [{
          id,
          icon: "ticket",
          label: title.slice(0, 28),
          title: `Ticket · ${title}`,
          status: state.label,
          live: state.live,
          dot: TONE_CLASSES[state.tone].dot,
          link: ["/tickets"],
          queryParams: { draft: id },
          comments: 0,
        }];
      }
      const setup = setups.get(id);
      if (setup) {
        const state = setupStatus(setup);
        const title = setupTitle(setup);
        return [{
          id,
          icon: "wand",
          label: title.slice(0, 28),
          title: `Setup IA · ${title}`,
          status: state.label,
          live: state.live,
          dot: TONE_CLASSES[state.tone].dot,
          link: ["/ai-setup"],
          queryParams: { session: id },
          comments: 0,
        }];
      }
      return [];
    });
  });

  // ---- renaming a tab (double click on its name)
  protected readonly renaming = signal<string | null>(null);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>("rename");

  protected startRename(event: Event, tab: HeaderTab): void {
    event.preventDefault();
    event.stopPropagation();
    this.renaming.set(tab.id);
  }

  /** Terminals rename their conversation (the same title everywhere); other tabs keep the name in this browser. */
  protected async finishRename(tab: HeaderTab, value: string | null): Promise<void> {
    if (this.renaming() !== tab.id) {
      return;
    }
    this.renaming.set(null);
    if (value === null) {
      return;
    }
    if (tab.icon === "terminal") {
      const title = value.trim();
      if (title && title !== tab.label) {
        this.store.upsertConversation(await this.api.updateConversation(tab.id, { title }));
      }
      return;
    }
    const automatic = this.autoTabs().find((candidate) => candidate.id === tab.id)?.label;
    this.store.renameTab(tab.id, value.trim() === automatic ? "" : value);
  }

  protected onRenameKey(event: KeyboardEvent, tab: HeaderTab): void {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void this.finishRename(tab, (event.target as HTMLInputElement).value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void this.finishRename(tab, null);
    }
  }

  /** Steps running right now in any flow (subagents are counted in the Agentes view). */
  protected readonly workingAgents = computed(() =>
    this.store.runs().reduce((sum, run) => sum + run.steps.filter((step) => step.status === "running").length, 0),
  );

  public constructor() {
    effect(() => writeStorage(COLLAPSED_KEY, this.collapsed()));
    // The rename box takes the focus with its text selected.
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      clearTimeout(timer);
      if (this.store.connected()) {
        this.everConnected.set(true);
        this.showDisconnected.set(false);
      } else if (this.everConnected()) {
        timer = setTimeout(() => this.showDisconnected.set(true), 2500);
      }
    });
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  /** Moves focus into the page, not only the scroll position. */
  protected skipToMain(event: Event): void {
    event.preventDefault();
    document.getElementById("main")?.focus();
  }

  // ---- reordering the run tabs by drag & drop
  protected readonly dragging = signal<string | null>(null);
  protected readonly dropTarget = signal<{ id: string; side: "before" | "after" } | null>(null);

  protected onDragStart(event: DragEvent, id: string): void {
    this.dragging.set(id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  /** The drop side follows the pointer: left half of a tab = before it, right half = after. */
  protected onDragOver(event: DragEvent, id: string): void {
    const dragging = this.dragging();
    if (!dragging) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (dragging === id) {
      this.dropTarget.set(null);
      return;
    }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const side = event.clientX < box.left + box.width / 2 ? "before" : "after";
    const current = this.dropTarget();
    if (current?.id !== id || current.side !== side) {
      this.dropTarget.set({ id, side });
    }
  }

  protected onDragLeave(id: string): void {
    if (this.dropTarget()?.id === id) {
      this.dropTarget.set(null);
    }
  }

  protected onDrop(event: DragEvent, id: string): void {
    event.preventDefault();
    const dragging = this.dragging();
    const target = this.dropTarget();
    if (dragging && target?.id === id) {
      this.store.moveTab(dragging, id, target.side);
    }
    this.onDragEnd();
  }

  protected onDragEnd(): void {
    this.dragging.set(null);
    this.dropTarget.set(null);
  }

  protected openToast(toast: Toast): void {
    this.store.dismissToast(toast.id);
    this.store.dismissNotice(toast.id);
    this.store.openToast(toast);
  }

  protected toggleNoticeCenter(): void {
    if (this.noticeCenterOpen()) {
      this.closeNoticeCenter();
      return;
    }
    this.store.markNoticesSeen();
    this.noticeCenterOpen.set(true);
  }

  protected closeNoticeCenter(): void {
    if (!this.noticeCenterOpen()) {
      return;
    }
    this.store.markNoticesSeen();
    this.store.clearSeenNotices();
    this.noticeCenterOpen.set(false);
  }

  protected openNotice(notice: Notice): void {
    this.store.dismissNotice(notice.id);
    this.closeNoticeCenter();
    this.store.openToast(notice);
  }

  @HostListener("document:keydown.escape")
  protected onEscape(): void {
    this.closeNoticeCenter();
  }

  public ngOnInit(): void {
    this.store.init().catch(() => this.loadError.set("No se puede conectar con el servidor de Nexura (npm run serve)."));
  }

  /** Closing only hides the tab: a running terminal keeps running. Closing the one on screen moves to the last open tab. */
  protected closeTab(event: Event, tab: HeaderTab): void {
    event.preventDefault();
    event.stopPropagation();
    const shown = this.isShown(tab);
    this.store.closeTab(tab.id);
    if (shown) {
      const next = this.tabs().at(-1);
      void this.router.navigate(next ? next.link : ["/"], { queryParams: next?.queryParams });
    }
  }

  private isShown(tab: HeaderTab): boolean {
    const tree = this.router.createUrlTree(tab.link, { queryParams: tab.queryParams });
    return this.router.isActive(tree, { paths: "exact", queryParams: "subset", fragment: "ignored", matrixParams: "ignored" });
  }
}
