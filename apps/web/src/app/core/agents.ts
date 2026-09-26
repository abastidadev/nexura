import { agentOf, orderSteps, type AgentKind, type FlowProfile, type NexuraEvent, type Run, type StepDefinition, type StepName, type StepRun } from "@nexura/shared";
import { modelDetail, stepLabel } from "./format";

export type AgentActivity =
  | "waiting"
  | "idle"
  | "thinking"
  | "reading"
  | "typing"
  | "running"
  | "delegating"
  | "blocked"
  | "done"
  | "failed";

export type AgentNode = {
  /** stepRun.id, `planned-<step>` or the toolUseId of a subagent. */
  id: string;
  runId: string;
  kind: "step" | "planned" | "subagent" | "builtin";
  /** Runs without an LLM (drawn as a robot); also set on planned builtin steps. */
  builtin?: boolean;
  /** Step it belongs to (subagents: the step that launched them). */
  step: StepName;
  /** Step run to open when the agent is clicked (none for planned steps). */
  stepRunId?: string;
  label: string;
  /** Agent CLI that runs it (missing for robots). */
  agent?: AgentKind;
  model?: string;
  activity: AgentActivity;
  currentTool?: string;
  /** Short summary of what it is doing, e.g. "Edit app.ts". */
  bubble?: string;
  costUsd?: number;
  numTurns?: number;
  startedAt?: string;
  finishedAt?: string;
  children: AgentNode[];
};

export type PlannedStep = { name: StepName; detail: string; agent?: AgentKind; model?: string; builtin: boolean };

/** Anything shaped like the store's StoredEvent. */
export type AgentEvent = { ts?: string; event: NexuraEvent };

export type AgentConfig = { profiles: FlowProfile[]; steps: Pick<StepDefinition, "name" | "kind" | "custom" | "after">[] };

export const ACTIVITY_LABELS: Record<AgentActivity, string> = {
  waiting: "En espera",
  idle: "Hablando",
  thinking: "Pensando",
  reading: "Leyendo",
  typing: "Escribiendo código",
  running: "Ejecutando comandos",
  delegating: "Delegando en subagentes",
  blocked: "Bloqueado",
  done: "Terminado",
  failed: "Falló",
};

export const ACTIVE_RUN_STATUSES: readonly string[] = ["queued", "running", "paused", "waiting-rate-limit"];

const CLASSIFY_DETAIL = "haiku/low";
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "LS"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RUN_TOOLS = new Set(["Bash", "Shell", "PowerShell"]);
/** A failed tool shows the agent blocked only for a moment, then it goes back to thinking. */
const BLOCKED_FLASH_MS = 3000;
const BUBBLE_MAX = 34;

/** Steps of the run's resolved profile, in pipeline order (classify first when the profile is "auto"). */
export function plannedSteps(run: Run, config: AgentConfig | null): PlannedStep[] {
  if (!config) {
    return [];
  }
  const result: PlannedStep[] = [];
  if (run.request.profile === "auto") {
    result.push({ name: "classify", detail: CLASSIFY_DETAIL, agent: "claude", model: "haiku", builtin: false });
  }
  const profile = config.profiles.find((candidate) => candidate.name === run.resolvedProfile);
  for (const { name } of orderSteps(config.steps)) {
    const step = profile?.steps[name];
    if (name !== "classify" && name !== "addressReview" && step?.enabled) {
      const builtin = config.steps.find((definition) => definition.name === name)?.kind === "builtin";
      result.push({ name, detail: builtin ? "sin LLM" : modelDetail(step), agent: builtin ? undefined : agentOf(step), model: builtin ? undefined : step.model, builtin });
    }
  }
  return result;
}

function clip(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > BUBBLE_MAX ? line.slice(0, BUBBLE_MAX - 1) + "…" : line;
}

function field(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

/** "Edit app.ts", "Bash npm test"… */
export function toolBubble(name: string, input: unknown): string {
  const target =
    field(input, "file_path")?.split(/[\\/]/).at(-1) ??
    field(input, "command") ??
    field(input, "pattern") ??
    field(input, "url") ??
    field(input, "skill") ??
    field(input, "description") ??
    "";
  return clip(target ? `${name} ${target}` : name);
}

/** What an agent is doing after this event; undefined = the event does not change it. */
export function activityFor(event: NexuraEvent): AgentActivity | undefined {
  switch (event.kind) {
    case "thinking":
    case "thinkingTokens":
      return "thinking";
    case "text":
      return "idle";
    case "toolUse":
      if (SUBAGENT_TOOLS.has(event.name)) {
        return "delegating";
      }
      if (READ_TOOLS.has(event.name)) {
        return "reading";
      }
      if (WRITE_TOOLS.has(event.name)) {
        return "typing";
      }
      if (RUN_TOOLS.has(event.name)) {
        return "running";
      }
      return "thinking";
    case "toolResult":
      return event.isError ? "blocked" : "thinking";
    case "result":
      return event.success ? "done" : "failed";
    default:
      return undefined;
  }
}

type LiveState = { activity: AgentActivity; tool?: string; bubble?: string; at?: string };

function apply(state: LiveState, { ts, event }: AgentEvent): void {
  const activity = activityFor(event);
  if (!activity) {
    return;
  }
  state.activity = activity;
  state.at = ts;
  state.tool = event.kind === "toolUse" ? event.name : undefined;
  state.bubble =
    event.kind === "toolUse"
      ? toolBubble(event.name, event.input)
      : event.kind === "text"
        ? clip(event.text)
        : event.kind === "toolResult" && event.isError
          ? clip(`error: ${event.content}`)
          : undefined;
}

/** A tool error only blocks the agent for a moment. */
function settle(state: LiveState, now: number): LiveState {
  if (state.activity === "blocked" && state.at && now - Date.parse(state.at) > BLOCKED_FLASH_MS) {
    return { activity: "thinking" };
  }
  return state;
}

/** Subagents (Agent/Task tool uses of the step itself) and the step's own live state. */
function readEvents(events: readonly AgentEvent[], base: Omit<AgentNode, "id" | "kind" | "label" | "activity" | "children">, now: number) {
  const own: LiveState = { activity: "thinking" };
  const children = new Map<string, { node: AgentNode; state: LiveState; open: boolean }>();
  for (const item of events) {
    const { event } = item;
    const parent = event.kind === "toolUse" || event.kind === "toolResult" ? event.parentToolUseId : null;
    if (parent && children.has(parent)) {
      apply(children.get(parent)!.state, item);
      continue;
    }
    if (event.kind === "toolUse" && SUBAGENT_TOOLS.has(event.name)) {
      const type = field(event.input, "subagent_type");
      children.set(event.id, {
        node: {
          ...base,
          id: event.id,
          kind: "subagent",
          label: field(event.input, "description") ?? type ?? "Subagente",
          model: field(event.input, "model") ?? base.model,
          activity: "thinking",
          bubble: type,
          startedAt: item.ts,
          finishedAt: undefined,
          costUsd: undefined,
          numTurns: undefined,
          children: [],
        },
        state: { activity: "thinking", bubble: type },
        open: true,
      });
    } else if (event.kind === "toolResult" && children.has(event.toolUseId)) {
      const child = children.get(event.toolUseId)!;
      child.open = false;
      child.state = { activity: event.isError ? "failed" : "done" };
      child.node.finishedAt = item.ts;
    }
    apply(own, item);
  }
  const nodes = [...children.values()].map(({ node, state }) => {
    const settled = settle(state, now);
    return { ...node, activity: settled.activity, currentTool: settled.tool, bubble: settled.bubble ?? node.bubble };
  });
  const openCount = [...children.values()].filter((child) => child.open).length;
  return { own: settle(own, now), children: nodes, openCount };
}

function stepNode(run: Run, step: StepRun, events: readonly AgentEvent[] | undefined, now: number): AgentNode {
  const builtin = step.kind === "builtin";
  const node: AgentNode = {
    id: step.id,
    runId: run.id,
    kind: builtin ? "builtin" : "step",
    builtin: builtin || undefined,
    step: step.step,
    stepRunId: step.id,
    label: step.attempt > 1 ? `${stepLabel(step.step)} #${step.attempt}` : stepLabel(step.step),
    agent: builtin ? undefined : agentOf(step),
    model: builtin ? undefined : step.model,
    activity: "waiting",
    costUsd: step.costUsd,
    numTurns: step.numTurns,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    children: [],
  };
  const live = events?.length ? readEvents(events, node, now) : undefined;
  switch (step.status) {
    case "succeeded":
      node.activity = "done";
      break;
    case "skipped":
      node.activity = "done";
      node.bubble = "saltado";
      break;
    case "failed":
      node.activity = "failed";
      node.bubble = step.error ? clip(step.error) : undefined;
      break;
    case "pending":
      node.activity = "waiting";
      break;
    case "running":
      if (live?.openCount) {
        node.activity = "delegating";
        node.currentTool = "Agent";
        node.bubble = live.openCount === 1 ? "1 subagente trabajando" : `${live.openCount} subagentes trabajando`;
      } else if (live) {
        node.activity = live.own.activity === "done" || live.own.activity === "failed" ? "thinking" : live.own.activity;
        node.currentTool = live.own.tool;
        node.bubble = live.own.bubble;
      } else {
        node.activity = builtin ? "running" : "thinking";
      }
      break;
  }
  if (live) {
    // Subagents left open by a finished step ended with it.
    const finished = step.status !== "running";
    node.children = live.children.map((child) =>
      finished && !child.finishedAt ? { ...child, activity: step.status === "failed" ? "failed" : "done", bubble: undefined } : child,
    );
  }
  return node;
}

/**
 * Every agent of a run: the executed steps (with the subagents they launched), then the
 * profile steps still to come. `events` only needs the steps that are running.
 */
export function buildRunAgents(
  run: Run,
  planned: readonly PlannedStep[],
  events: Readonly<Record<string, readonly AgentEvent[] | undefined>> = {},
  now = Date.now(),
): AgentNode[] {
  const executed = run.steps.map((step) => stepNode(run, step, events[step.id], now));
  const final = !ACTIVE_RUN_STATUSES.includes(run.status);
  const seen = new Set(run.steps.map((step) => step.step));
  const pending: AgentNode[] = final
    ? []
    : planned
        .filter((plan) => !seen.has(plan.name))
        .map((plan) => ({
          id: `planned-${plan.name}`,
          runId: run.id,
          kind: "planned",
          step: plan.name,
          label: stepLabel(plan.name),
          agent: plan.agent,
          model: plan.model,
          builtin: plan.builtin || undefined,
          activity: "waiting",
          children: [],
        }));
  const agents = [...executed, ...pending];

  if (run.status === "paused" || run.status === "waiting-rate-limit") {
    const bubble = run.status === "paused" ? "esperando aprobación" : "esperando cuota";
    const next = run.pendingStep?.step;
    const target =
      executed.find((_agent, index) => run.steps[index]!.status === "running") ??
      pending.find((agent) => agent.step === next) ??
      executed.findLast((agent) => agent.step === next) ??
      pending[0];
    if (target) {
      target.activity = "blocked";
      target.bubble = bubble;
      target.currentTool = undefined;
    }
  }
  return agents;
}

/** Agents doing something right now (subagents included); blocked ones are waiting for the user. */
export function countWorking(agents: readonly AgentNode[]): number {
  return agents.reduce(
    (sum, agent) =>
      sum + (["waiting", "blocked", "done", "failed"].includes(agent.activity) ? 0 : 1) + countWorking(agent.children),
    0,
  );
}
