import { activityFor, clipBubble, inputField, toolBubble, type AgentKind, type NexuraEvent, type RepoConfig, type Run, type ServerMessage, type StepRun } from "@nexura/shared";

/** A Nexura run as a worker at a desk of the 3D office (third_party/agent-office, src/server/nexura/bridge.ts). */
export type OfficeWorker = {
  /** Stable per run: `nexura-<runId>`. */
  id: string;
  runId: string;
  /** Name over its head: the ticket id, or the start of its title. */
  name: string;
  /** Ticket or PR title. */
  title: string;
  status: "starting" | "working" | "needs_input" | "done" | "exited";
  /** Step running now, or the last one that ran. */
  step?: string;
  provider?: "claude" | "codex" | "custom";
  model?: string;
  /** Speech bubble: what the step is doing ("Edit app.ts", "esperando aprobación"…). */
  activity?: string;
  /** Latest tool call, for the office to act it out (reading, typing, running tests…). */
  tool?: { name: string; command?: string };
  /** Local checkouts of the run's repos, to pick the floor of the same project. */
  repoDirs: string[];
  pr?: { number: number; url: string };
  /** The run in Nexura's UI. */
  url: string;
  createdAt: number;
  /** When it started waiting for the user (approval or quota). */
  waitingSince?: number;
};

type Live = { stepRunId: string; bubble?: string; tool?: { name: string; command?: string } };

const ACTIVE = new Set<Run["status"]>(["queued", "running", "paused", "waiting-rate-limit"]);
/** Finished runs stay at their desk this long, so the office shows how they ended. */
export const RECENT_MS = 15 * 60_000;
/** Resent even without changes, so a restarted office gets its workers back. */
const HEARTBEAT_MS = 20_000;
const DEBOUNCE_MS = 300;
const NAME_MAX = 18;

const PROVIDERS: Record<AgentKind, OfficeWorker["provider"]> = { claude: "claude", codex: "codex", copilot: "custom" };

function lastStep(run: Run): StepRun | undefined {
  return run.steps.find((step) => step.status === "running") ?? run.steps.at(-1);
}

function finishedAt(run: Run): number {
  const times = run.steps.map((step) => Date.parse(step.finishedAt ?? step.startedAt ?? "")).filter((time) => !Number.isNaN(time));
  return Math.max(Date.parse(run.createdAt), ...times);
}

function titleOf(run: Run): string {
  const target = run.request.prReview;
  if (target) {
    return `PR #${target.id} · ${target.title}`;
  }
  return run.request.ticketText.split("\n")[0]?.trim() || `Flujo ${run.id}`;
}

function nameOf(run: Run, title: string): string {
  if (run.request.ticketId) {
    return `#${run.request.ticketId}`;
  }
  return title.length > NAME_MAX ? title.slice(0, NAME_MAX - 1) + "…" : title;
}

function statusOf(run: Run): OfficeWorker["status"] {
  switch (run.status) {
    case "queued":
      return "starting";
    case "running":
      return "working";
    case "paused":
    case "waiting-rate-limit":
      return "needs_input";
    case "done":
      return "done";
    default:
      return "exited";
  }
}

function waitingText(run: Run): string | undefined {
  if (run.status === "paused") {
    return run.pendingStep?.prDrafts ? "esperando aprobación del PR" : "esperando aprobación";
  }
  if (run.status === "waiting-rate-limit") {
    return "esperando cuota";
  }
  if (run.status === "failed") {
    return clipBubble(`falló: ${run.error ?? "error"}`);
  }
  if (run.status === "cancelled") {
    return "cancelado";
  }
  return undefined;
}

/** The runs worth a desk: the live ones and those that finished a moment ago. */
export function officeWorkers(
  runs: readonly Run[],
  options: { repos: readonly RepoConfig[]; nexuraUrl: string; now: number; live?: ReadonlyMap<string, Live>; waitingSince?: ReadonlyMap<string, number> },
): OfficeWorker[] {
  const workers: OfficeWorker[] = [];
  for (const run of runs) {
    if (!ACTIVE.has(run.status) && options.now - finishedAt(run) > RECENT_MS) {
      continue;
    }
    const step = lastStep(run);
    const live = options.live?.get(run.id);
    const current = live && step && live.stepRunId === step.id && run.status === "running" ? live : undefined;
    const title = titleOf(run);
    const status = statusOf(run);
    const pr = run.pullRequests?.[0] ?? (run.request.prReview ? { id: run.request.prReview.id, url: run.request.prReview.url } : undefined);
    workers.push({
      id: `nexura-${run.id}`,
      runId: run.id,
      name: nameOf(run, title),
      title,
      status,
      step: step?.step,
      provider: step && step.kind !== "builtin" ? PROVIDERS[step.agent ?? "claude"] : undefined,
      model: step && step.kind !== "builtin" ? step.model : undefined,
      activity: waitingText(run) ?? current?.bubble,
      tool: current?.tool,
      repoDirs: run.request.repos.flatMap((name) => options.repos.find((repo) => repo.name === name)?.path ?? []),
      pr: pr ? { number: pr.id, url: pr.url } : undefined,
      url: `${options.nexuraUrl.replace(/\/$/, "")}/runs/${run.id}`,
      createdAt: Date.parse(run.createdAt),
      waitingSince: status === "needs_input" ? (options.waitingSince?.get(run.id) ?? options.now) : undefined,
    });
  }
  return workers;
}

/** What a step is doing after one of its events; undefined = no change. */
export function liveAfter(previous: Live | undefined, stepRunId: string, event: NexuraEvent): Live | undefined {
  const activity = activityFor(event);
  if (!activity || event.kind === "result") {
    return undefined;
  }
  // Subagent chatter doesn't change what the step's own worker is acting out.
  if ((event.kind === "toolUse" || event.kind === "toolResult") && event.parentToolUseId) {
    return undefined;
  }
  const base: Live = { stepRunId };
  if (event.kind === "toolUse") {
    return { ...base, bubble: toolBubble(event.name, event.input), tool: { name: event.name, command: inputField(event.input, "command") } };
  }
  if (event.kind === "text") {
    return { ...base, bubble: clipBubble(event.text) };
  }
  if (event.kind === "toolResult") {
    // Keep acting out the tool that just returned (a failing test run stays a test run).
    return { ...base, bubble: event.isError ? clipBubble(`error: ${event.content}`) : previous?.bubble, tool: previous?.stepRunId === stepRunId ? previous.tool : undefined };
  }
  return { ...base, bubble: previous?.stepRunId === stepRunId ? previous.bubble : undefined, tool: previous?.stepRunId === stepRunId ? previous.tool : undefined };
}

type BridgeSource = {
  on(event: "message", listener: (message: ServerMessage) => void): unknown;
};

export type OfficeBridgeOptions = {
  officeUrl: string;
  token: string;
  nexuraUrl: string;
  listRuns: () => Run[];
  repos: () => RepoConfig[];
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * Keeps the 3D office's copy of Nexura's runs up to date: one POST with every run worth a desk,
 * after each change (debounced) and on a heartbeat. The office drops them if Nexura goes quiet.
 */
export class OfficeBridge {
  private readonly live = new Map<string, Live>();
  private readonly waitingSince = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private sent = "";
  private failing = false;
  private readonly options: OfficeBridgeOptions;

  constructor(options: OfficeBridgeOptions) {
    this.options = options;
  }

  /** From NEXURA_OFFICE_URL + NEXURA_OFFICE_TOKEN (set by `npm run start:all`); undefined when either is missing. */
  static fromEnv(env: NodeJS.ProcessEnv, options: Omit<OfficeBridgeOptions, "officeUrl" | "token" | "nexuraUrl"> & { port: number }): OfficeBridge | undefined {
    const officeUrl = env.NEXURA_OFFICE_URL?.trim();
    const token = env.NEXURA_OFFICE_TOKEN?.trim();
    if (!officeUrl || !token) {
      return undefined;
    }
    return new OfficeBridge({ ...options, officeUrl, token, nexuraUrl: env.NEXURA_URL?.trim() || `http://localhost:${options.port}` });
  }

  start(source: BridgeSource): void {
    source.on("message", (message) => this.onMessage(message));
    this.heartbeat = setInterval(() => void this.push(true), HEARTBEAT_MS);
    this.heartbeat.unref();
    this.schedule();
  }

  stop(): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.timer);
  }

  onMessage(message: ServerMessage): void {
    if (message.type === "event") {
      const next = liveAfter(this.live.get(message.runId), message.stepRunId, message.event);
      if (!next) {
        return;
      }
      this.live.set(message.runId, next);
    } else if (message.type === "run") {
      const waiting = message.run.status === "paused" || message.run.status === "waiting-rate-limit";
      if (!waiting) {
        this.waitingSince.delete(message.run.id);
      } else if (!this.waitingSince.has(message.run.id)) {
        this.waitingSince.set(message.run.id, (this.options.now ?? Date.now)());
      }
      if (message.run.status !== "running") {
        this.live.delete(message.run.id);
      }
    } else if (message.type === "runDeleted") {
      this.live.delete(message.runId);
      this.waitingSince.delete(message.runId);
    } else {
      return;
    }
    this.schedule();
  }

  snapshot(): OfficeWorker[] {
    return officeWorkers(this.options.listRuns(), {
      repos: this.options.repos(),
      nexuraUrl: this.options.nexuraUrl,
      now: (this.options.now ?? Date.now)(),
      live: this.live,
      waitingSince: this.waitingSince,
    });
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.push(false);
    }, DEBOUNCE_MS);
  }

  /** Sends the snapshot; without `force`, only when it changed. */
  async push(force: boolean): Promise<void> {
    const body = JSON.stringify({ workers: this.snapshot() });
    if (!force && body === this.sent) {
      return;
    }
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.officeUrl.replace(/\/$/, "")}/nexura/workers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.sent = body;
      if (this.failing) {
        console.log("Oficina 3D: conectada de nuevo.");
      }
      this.failing = false;
    } catch (error) {
      // The office may simply not be up yet: say so once, keep trying on the heartbeat.
      if (!this.failing) {
        console.warn(`Oficina 3D: no se pudo enviar el estado de los flujos (${(error as Error).message}); se reintentará.`);
      }
      this.failing = true;
      this.sent = "";
    }
  }
}
