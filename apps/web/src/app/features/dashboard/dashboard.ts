import { Component, computed, inject, resource, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { AGENT_LABELS, type DashboardInbox, type InboxPrState, type Metrics, type Run } from "@nexura/shared";
import { Api } from "../../core/api";
import { formatTokens, RUN_STATUS, stepLabel, TONE_CLASSES, type Tone } from "../../core/format";
import { isPrReview, NexuraStore, reviewLink } from "../../core/nexura-store";
import { Icon, type IconName } from "../../shared/icon";
import { StatusPill } from "../../shared/status-pill";

const RANGES = [7, 14, 30] as const;
const DAY_MS = 86_400_000;
const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);

const PR_STATE: Record<InboxPrState, { label: string; tone: Tone }> = {
  pending: { label: "Sin revisar", tone: "warn" },
  outdated: { label: "Commits nuevos", tone: "warn" },
  reviewing: { label: "Revisando", tone: "info" },
  ready: { label: "Lista para publicar", tone: "accent" },
  published: { label: "Publicada", tone: "ok" },
};

/** Something the user has to act on, most urgent first. */
type AttentionItem = {
  key: string;
  tone: Tone;
  icon: IconName;
  title: string;
  detail: string;
  link: string[];
  queryParams?: Record<string, string>;
};

function runTitle(run: Run): string {
  const title = run.request.ticketText.split("\n")[0] || `Flujo ${run.id}`;
  return run.request.ticketId ? `#${run.request.ticketId} ${title}` : title;
}

/** Share of the largest value, for inline bars (at least a sliver when the value is not zero). */
function share(value: number, max: number): number {
  return max > 0 && value > 0 ? Math.max(2, (value / max) * 100) : 0;
}

@Component({
  selector: "nx-dashboard",
  imports: [RouterLink, Icon, StatusPill],
  templateUrl: "./dashboard.html",
  host: { class: "block h-full overflow-y-auto" },
})
export class DashboardPage {
  private readonly api = inject(Api);
  private readonly store = inject(NexuraStore);

  protected readonly ranges = RANGES;
  protected readonly days = signal<number>(14);
  protected readonly formatTokens = formatTokens;
  protected readonly agentLabels = AGENT_LABELS;

  /** Reloads when the range changes or a run changes state. */
  protected readonly data = resource({
    params: () => ({ days: this.days(), version: this.store.runs().map((run) => `${run.id}:${run.status}:${run.steps.length}`).join() }),
    loader: ({ params }) => this.api.metrics(params.days),
  });
  protected readonly metrics = computed<Metrics | undefined>(() => (this.data.hasValue() ? this.data.value() : undefined));

  /** PRs and tickets from GitHub / Azure DevOps: loaded on open and on demand, not on every run change. */
  protected readonly inboxRefresh = signal(0);
  protected readonly inboxData = resource({
    params: () => ({ refresh: this.inboxRefresh() }),
    loader: () => this.api.dashboardInbox(),
  });
  protected readonly inbox = computed<DashboardInbox | undefined>(() => (this.inboxData.hasValue() ? this.inboxData.value() : undefined));
  protected readonly prState = PR_STATE;
  protected readonly toReview = computed(() => (this.inbox()?.pullRequests ?? []).filter((pr) => pr.state === "pending" || pr.state === "outdated"));
  protected readonly reviewed = computed(() => (this.inbox()?.pullRequests ?? []).filter((pr) => pr.state !== "pending" && pr.state !== "outdated"));
  /** Open tickets, with the state of the flow that took them (if any). */
  protected readonly pendingTickets = computed(() => {
    // The ticket's project is its GitHub repo or Azure project: prefill the flow with the matching configured repo.
    const repos = this.store.config()?.repos ?? [];
    return (this.inbox()?.tickets ?? []).map((ticket) => ({
      ...ticket,
      badge: ticket.runStatus ? RUN_STATUS[ticket.runStatus] : { label: "Sin empezar", tone: "muted" as Tone, live: false },
      newRunParams: {
        ticket: String(ticket.id),
        source: ticket.source,
        ...(repos.length === 1 ? { repo: repos[0]!.name } : {}),
      } as Record<string, string>,
    }));
  });
  protected readonly mineCount = computed(() => this.pendingTickets().filter((ticket) => ticket.mine).length);

  /** PRs the flows opened that are still open, with the comment threads the watcher last saw. */
  protected readonly myPrs = computed(() =>
    this.store
      .runs()
      .filter((run) => run.pullRequests?.length && (run.reviewWatch?.prStatus ?? "active") === "active")
      .flatMap((run) =>
        (run.pullRequests ?? []).map((pr) => ({ ...pr, runId: run.id, threads: run.reviewWatch?.activeThreads ?? 0, checkedAt: run.reviewWatch?.checkedAt })),
      )
      .sort((a, b) => b.threads - a.threads),
  );

  /** Live from the store: what is waiting on the user right now. */
  protected readonly attention = computed<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    const weekAgo = Date.now() - 7 * DAY_MS;
    for (const run of this.store.runs()) {
      if (isPrReview(run)) {
        if (run.status === "done" && run.prReview && !run.prReview.published) {
          const target = run.request.prReview;
          const link = reviewLink(run);
          items.push({
            key: `review-${run.id}`, tone: "accent", icon: "reviews",
            title: `Revisión lista para publicar: PR #${target?.id ?? "?"} ${target?.title ?? ""}`.trim(),
            detail: `${run.request.repos[0] ?? ""} · ${run.prReview.comments.length} comentario(s) propuestos`,
            link: link.path,
            queryParams: link.queryParams,
          });
        }
        continue;
      }
      if (run.status === "paused") {
        const pending = run.pendingStep;
        const what = pending?.prDrafts ? "Aprueba la PR antes de publicarla" : pending?.replies ? "Aprueba las respuestas a los comentarios" : `El paso ${stepLabel(pending?.step ?? "")} espera tu visto bueno`;
        items.push({ key: `paused-${run.id}`, tone: "warn", icon: "clock", title: runTitle(run), detail: what, link: ["/runs", run.id] });
      } else if (run.status === "failed" && Date.parse(run.createdAt) >= weekAgo) {
        const step = run.steps.findLast((item) => item.status === "failed");
        items.push({
          key: `failed-${run.id}`, tone: "err", icon: "alert", title: runTitle(run),
          detail: `Falló${step ? ` en ${stepLabel(step.step)}` : ""}${run.error ? `: ${run.error}` : ""}`,
          link: ["/runs", run.id],
        });
      }
    }
    for (const pr of this.myPrs()) {
      if (pr.threads > 0) {
        items.push({
          key: `comments-${pr.runId}-${pr.id}`, tone: "info", icon: "bell",
          title: `Tu PR #${pr.id} ${pr.title}`,
          detail: `${pr.threads} comentario(s) sin resolver en ${pr.repo}`,
          link: ["/runs", pr.runId],
        });
      }
    }
    const order: Record<Tone, number> = { err: 0, warn: 1, info: 2, accent: 3, ok: 4, muted: 5 };
    return items.sort((a, b) => order[a.tone] - order[b.tone]);
  });
  protected readonly toneClasses = TONE_CLASSES;

  protected readonly tiles = computed(() => {
    const m = this.metrics();
    if (!m) {
      return [];
    }
    const tiles: { label: string; value: string; hint: string; icon: IconName; tone: Tone }[] = [
      { label: "Activos", value: String(m.totals.active), hint: "en marcha o en pausa", icon: "activity", tone: "info" },
      { label: "Terminados", value: String(m.totals.done), hint: `de ${m.totals.runs} flujos`, icon: "done", tone: "ok" },
      { label: "Fallidos", value: String(m.totals.failed), hint: `${m.totals.cancelled} cancelados`, icon: "alert", tone: "err" },
      { label: "Tokens", value: formatTokens(m.totals.tokens), hint: "usados por los agentes", icon: "spark", tone: "accent" },
      { label: "Commits", value: String(m.commits.total), hint: `en ${m.commits.runs} flujos`, icon: "fork", tone: "accent" },
      { label: "Pull requests", value: String(m.commits.prs), hint: "creadas por Nexura", icon: "reviews", tone: "accent" },
    ];
    return tiles.map((tile) => ({ ...tile, text: TONE_CLASSES[tile.tone].text }));
  });

  /** Proportional bar of every run by final state; the legend repeats the counts. */
  protected readonly statusBar = computed(() => {
    const m = this.metrics();
    if (!m || m.totals.runs === 0) {
      return [];
    }
    const parts: { key: string; label: string; count: number; dot: string }[] = [
      { key: "active", label: "Activos", count: m.totals.active, dot: TONE_CLASSES.info.dot },
      { key: "done", label: "Terminados", count: m.totals.done, dot: TONE_CLASSES.ok.dot },
      { key: "failed", label: "Fallidos", count: m.totals.failed, dot: TONE_CLASSES.err.dot },
      { key: "cancelled", label: "Cancelados", count: m.totals.cancelled, dot: TONE_CLASSES.muted.dot },
    ];
    return parts.map((part) => ({ ...part, percent: (part.count / m.totals.runs) * 100 }));
  });

  /** Live list from the store (updates over WebSocket without reloading the metrics). */
  protected readonly activeRuns = computed(() =>
    this.store
      .runs()
      .filter((run) => ACTIVE.has(run.status))
      .slice(0, 6)
      .map((run) => {
        // A paused run waits before its next step, which has no StepRun yet.
        const current = run.pendingStep ?? run.steps.at(-1);
        return {
          id: run.id,
          title: run.request.ticketText.split("\n")[0] || (isPrReview(run) ? "Revisión de PR" : `Flujo ${run.id}`),
          ticketId: run.request.ticketId,
          step: current ? stepLabel(current.step) : "Preparando",
          status: RUN_STATUS[run.status],
        };
      }),
  );

  /** Every day of the range, including the ones without flows. */
  protected readonly daySeries = computed(() => {
    const m = this.metrics();
    const byDay = new Map((m?.byDay ?? []).map((day) => [day.day, day]));
    const today = Date.now();
    const series = Array.from({ length: this.days() }, (_, index) => {
      const key = new Date(today - (this.days() - 1 - index) * DAY_MS).toISOString().slice(0, 10);
      const day = byDay.get(key);
      return { day: key, tokens: day?.tokens ?? 0, runs: day?.runs ?? 0, done: day?.done ?? 0 };
    });
    const max = Math.max(0, ...series.map((day) => day.tokens));
    return series.map((day, index) => ({
      ...day,
      percent: share(day.tokens, max),
      label: new Date(`${day.day}T12:00:00`).toLocaleDateString("es-ES", { day: "numeric", month: "short" }),
      // Labels every few columns, counted back from today, so they do not collide at 30 days.
      showLabel: (series.length - 1 - index) % Math.ceil(this.days() / 7) === 0,
    }));
  });
  protected readonly rangeTokens = computed(() => this.daySeries().reduce((sum, day) => sum + day.tokens, 0));
  protected readonly rangeRuns = computed(() => this.daySeries().reduce((sum, day) => sum + day.runs, 0));

  protected readonly models = computed(() => {
    const rows = (this.metrics()?.byModel ?? []).slice(0, 8);
    const max = Math.max(0, ...rows.map((row) => row.tokens));
    return rows.map((row) => ({ ...row, percent: share(row.tokens, max) }));
  });

  protected readonly tokenKinds = computed(() => {
    const split = this.metrics()?.tokenSplit;
    if (!split) {
      return [];
    }
    const rows = [
      { label: "Entrada", hint: "prompt y contexto nuevos", value: split.input },
      { label: "Salida", hint: "lo que escribe el modelo", value: split.output },
      { label: "Lectura de caché", hint: "contexto reutilizado", value: split.cacheRead },
      { label: "Escritura de caché", hint: "contexto guardado", value: split.cacheCreation },
    ];
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return rows.map((row) => ({ ...row, percent: total > 0 ? (row.value / total) * 100 : 0 }));
  });

  protected readonly commitTypes = computed(() => {
    const rows = this.metrics()?.commits.byType ?? [];
    const max = Math.max(0, ...rows.map((row) => row.count));
    return rows.map((row) => ({ ...row, percent: share(row.count, max) }));
  });

  protected readonly recentCommits = computed(() => this.metrics()?.commits.recent ?? []);

  protected tokensTitle(day: { label: string; tokens: number; runs: number; done: number }): string {
    return `${day.label}: ${formatTokens(day.tokens)} tokens · ${day.runs} flujo(s), ${day.done} terminado(s)`;
  }
}
