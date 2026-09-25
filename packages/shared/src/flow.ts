import type { NexuraEvent, TokenUsage } from "./events.ts";

/** Steps shipped with Nexura, in pipeline order. Users can add their own (see StepDefinition.custom). */
export const STEP_NAMES = [
  "classify",
  "enrich",
  "plan",
  "implement",
  "codeReview",
  "qaCode",
  "release",
  "qaNotes",
  "addressReview",
] as const;

export type BuiltinStepName = (typeof STEP_NAMES)[number];

/** A built-in step or a custom one created from the UI (config/steps/<name>/). */
export type StepName = BuiltinStepName | (string & {});

/** Names a custom step may take: a letter first, then letters, digits or dashes. */
export const CUSTOM_STEP_NAME = /^[a-zA-Z][a-zA-Z0-9-]{1,39}$/;

/** Claude Code model aliases (the suggestions for `claude` steps); the CLI resolves each to its latest model. */
export type ModelAlias = "haiku" | "sonnet" | "opus" | "fable";

/**
 * The headless coding agent that runs a step: `claude -p`, `codex exec` (OpenAI Codex CLI)
 * or `copilot -p` (GitHub Copilot CLI). The steps of one flow may mix them.
 */
export type AgentKind = "claude" | "codex" | "copilot";

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "copilot"];

export const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot" };

/**
 * Model suggestions per agent; the model stays free text (any id the CLI accepts works). The first is the default.
 * Claude uses aliases, so they never go stale. Copilot's list is only a fallback: the server reads the real one
 * from the installed CLI (`AgentInfo.models`, see `modelsFor`).
 */
export const AGENT_MODELS: Record<AgentKind, readonly string[]> = {
  claude: ["sonnet", "haiku", "opus", "fable"],
  codex: ["gpt-5.3-codex", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  copilot: ["claude-sonnet-5", "claude-haiku-4.5", "claude-opus-5", "gpt-5.5", "gpt-5.4-mini", "auto"],
};

/** Models to offer for an agent: what its installed CLI reports, else the built-in suggestions. */
export function modelsFor(agent: AgentKind, agents?: readonly AgentInfo[]): readonly string[] {
  const reported = agents?.find((info) => info.agent === agent)?.models;
  return reported?.length ? reported : AGENT_MODELS[agent];
}

/** Missing agent = claude (profiles and runs from before agents existed). */
export function agentOf(config: { agent?: AgentKind } | undefined): AgentKind {
  return config?.agent ?? "claude";
}

export type Effort = "low" | "medium" | "high" | "xhigh";

/**
 * Shared memory of a step: `off` = none; `read` = gets {{memory}} and may search it
 * (mem_search / mem_get / mem_context); `readwrite` = also saves what it decides, fixes or discovers (mem_save).
 */
export type MemoryMode = "off" | "read" | "readwrite";

export const MEMORY_MODES: readonly MemoryMode[] = ["off", "read", "readwrite"];

export type StepConfig = {
  /** Missing = claude. */
  agent?: AgentKind;
  /** A Claude alias (haiku/sonnet/opus) or any model id the agent's CLI accepts. */
  model: string;
  effort: Effort;
  enabled: boolean;
};

/**
 * How codeReview runs: `single` = one reviewer; `blind` = two judges that never see each
 * other, and only what both confirm goes back to implement.
 */
export type ReviewMode = "single" | "blind";

export type FlowProfile = {
  name: string;
  description: string;
  steps: Partial<Record<StepName, StepConfig>>;
  /** How many times review/qa may send the flow back to implement. */
  maxLoops: number;
  budgetUsd?: number;
  /** Missing = `single`. */
  reviewMode?: ReviewMode;
  /** Blind review: judge B's agent/model/effort, when it should differ from codeReview's (judge A). */
  judgeB?: JudgeConfig;
};

export type JudgeConfig = { agent?: AgentKind; model: string; effort: Effort };

/** Static definition of a step, from config/steps/<step>/step.json. */
export type StepDefinition = {
  name: StepName;
  /** `claude` runs a coding agent (claude, codex or copilot, set per profile); `builtin` is plain code in the orchestrator (no tokens). */
  kind: "claude" | "builtin";
  /** Hard allowlist of built-in tools (`--tools`). Empty array disables all tools. */
  tools: string[];
  /** Permission rules added on top (`--allowedTools`), e.g. "Bash(npm run *)". */
  allowedTools: string[];
  /** Always denied (`--disallowedTools`), e.g. "Bash(git push *)". */
  disallowedTools: string[];
  /** Keep MCP servers from user/project config. Off = `--strict-mcp-config` (cheaper context). */
  useMcp: boolean;
  /** Shared memory through Nexura's memory MCP server (missing = off). */
  memory?: MemoryMode;
  timeoutMs: number;
  /** Set on steps created from the UI: they can be deleted and are ordered by `after`. */
  custom?: boolean;
  /** Custom steps: display name. */
  label?: string;
  /** Custom steps: what it is for (shown in the lists). */
  description?: string;
  /** Custom steps: runs right after this step in the pipeline. */
  after?: StepName;
};

/**
 * Pipeline order: the built-in order, with each custom step right after the step named
 * in its `after` (custom steps may chain after each other). Unknown `after` = at the end.
 */
export function orderSteps<T extends Pick<StepDefinition, "name" | "custom" | "after">>(steps: Iterable<T>): T[] {
  const all = [...steps];
  const builtins = STEP_NAMES.map((name) => all.find((step) => step.name === name && !step.custom)).filter((step): step is T => Boolean(step));
  const customs = all.filter((step) => step.custom).sort((a, b) => a.name.localeCompare(b.name));
  const ordered = [...builtins];
  let pending = customs;
  while (pending.length) {
    const next = pending.filter((step) => !ordered.some((placed) => placed.name === step.after));
    for (const step of pending.filter((candidate) => !next.includes(candidate))) {
      const index = ordered.findIndex((placed) => placed.name === step.after);
      // After its anchor and after the custom steps already anchored there.
      let insertAt = index + 1;
      while (insertAt < ordered.length && ordered[insertAt]!.custom && ordered[insertAt]!.after === step.after) {
        insertAt++;
      }
      ordered.splice(insertAt, 0, step);
    }
    if (next.length === pending.length) {
      ordered.push(...next);
      break;
    }
    pending = next;
  }
  return ordered;
}

export type RepoConfig = {
  name: string;
  path: string;
  baseBranch: string;
  branchPrefix?: string;
  /** Commands the qaCode step runs in the worktree, e.g. "npm run lint". */
  checks: string[];
  /** How the worktree gets its node_modules: junction to the main checkout (default), `npm ci`, or nothing. */
  nodeModules?: "link" | "install" | "none";
};

export type Worktree = {
  repo: string;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
};

export type RunStatus = "queued" | "running" | "paused" | "waiting-rate-limit" | "failed" | "done" | "cancelled";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type TaskItem = {
  id: string;
  title: string;
  selected: boolean;
  done: boolean;
};

export type RunRequest = {
  ticketId?: string;
  ticketText: string;
  repos: string[];
  tasks: TaskItem[];
  prompt: string;
  /** Profile name, or "auto" to let the classify step decide. */
  profile: string;
  stepByStep: boolean;
  /** `pr`: after release, pause for approval, then push and open the PR where the repo's origin lives (Azure DevOps or GitHub). */
  release?: "local" | "pr";
  /** Where `ticketId` lives (missing = azure). A PR only links it when it is opened on the same provider. */
  ticketSource?: TicketSource;
  /** GitHub: `owner/repo` of the issue, so a PR in another repo still links it. */
  ticketProject?: string;
};

/** Where tickets come from and PRs go: Azure DevOps work items or GitHub issues. */
export type TicketSource = "azure" | "github";

export const TICKET_SOURCES: readonly TicketSource[] = ["azure", "github"];

/** Ticket as loaded from Azure DevOps (HTML fields already converted to text) or GitHub (markdown). */
export type TicketDetails = {
  source: TicketSource;
  id: number;
  type: string;
  title: string;
  state: string;
  /** Azure DevOps project, or `owner/repo` on GitHub. */
  project: string;
  url: string;
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  comments: { author: string; date: string; text: string }[];
  /** Child work items (Azure) or sub-issues (GitHub). */
  children: { id: number; title: string; state: string; type: string; done: boolean }[];
  /** GitHub labels. */
  labels?: string[];
};

/** One row of the "pick a ticket" list: open (backlog or in progress) work items or issues. */
export type WorkItemSummary = {
  id: number;
  type: string;
  title: string;
  state: string;
  project: string;
  assignedTo: string;
  /** Azure iteration path, or the GitHub milestone. */
  iteration: string;
  changedDate: string;
  /** GitHub labels. */
  labels?: string[];
};

/**
 * Azure: `mine` = assigned to me in any project of the organisation; `project` = everything open in the repo's project.
 * GitHub: `mine` = open issues of the repo assigned to me; `project` = every open issue of the repo.
 */
export type WorkItemScope = "mine" | "project";

/** A pull request waiting for approval (editable) before push + create. */
export type PrDraft = {
  repo: string;
  branch: string;
  target: string;
  title: string;
  description: string;
  /** Where the PR is opened: the provider of the repo's origin remote. */
  provider: TicketSource;
  /** Work item (Azure: linked on creation) or issue (GitHub: `Closes #n` added on creation); never in the editable body. */
  workItemId?: number;
  /** GitHub: `owner/repo` of the issue when it is not the PR's repo. */
  workItemProject?: string;
  isDraft: boolean;
};

export type CreatedPr = { repo: string; id: number; url: string; title: string };

/**
 * An active comment thread of a PR: an Azure DevOps thread, or an unresolved GitHub review
 * thread (identified by its first comment's id).
 */
export type ReviewThread = {
  repo: string;
  prId: number;
  threadId: number;
  filePath?: string;
  line?: number;
  comments: { author: string; content: string }[];
};

/** addressReview's answer to one thread; `fixed`/`wontFix` also change the thread status. */
export type ReviewReply = {
  repo: string;
  threadId: number;
  reply: string;
  action: "fixed" | "answered" | "wontFix";
};

export type StepRun = {
  id: string;
  runId: string;
  step: StepName;
  attempt: number;
  /** Judge of a blind (double) code review; `attempt` counts per judge. */
  judge?: "A" | "B";
  /** Position in the run (increments on every execution, including loops and retries). */
  seq: number;
  status: StepStatus;
  kind: "claude" | "builtin";
  /** Missing on runs from before agents existed = claude. */
  agent?: AgentKind;
  model: string;
  effort: Effort;
  prompt?: string;
  args?: string[];
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd: number;
  numTurns: number;
  usage?: TokenUsage;
  structuredOutput?: unknown;
  error?: string;
};

export type Run = {
  id: string;
  request: RunRequest;
  status: RunStatus;
  resolvedProfile?: string;
  classifyReason?: string;
  createdAt: string;
  steps: StepRun[];
  worktrees: Worktree[];
  totalCostUsd: number;
  error?: string;
  /**
   * Set while paused: the step about to run and its rendered prompt (editable), or the PR
   * drafts waiting for the go-ahead before push + create.
   */
  pendingStep?: { step: StepName; prompt?: string; prDrafts?: PrDraft[]; replies?: ReviewReply[]; commits?: string[] };
  pullRequests?: CreatedPr[];
  /** Epoch seconds when a rate-limited run will resume. */
  resumesAt?: number;
  /** Whether the classify step picked the right profile, rated by the user (to tune its heuristics). */
  classifyFeedback?: { correct: boolean; expected?: string; ratedAt: string };
  /** Free REST polling of the PRs of a finished run (see NexuraSettings.prPollSeconds). */
  reviewWatch?: ReviewWatch;
};

export type ReviewWatch = {
  checkedAt: string;
  activeThreads: number;
  /** Status of the first PR: active, completed (merged), abandoned (closed unmerged). Polling stops when not active. */
  prStatus: string;
  error?: string;
};

/** Server-wide settings, editable in Configuración > General. */
export type NexuraSettings = {
  /** Claude steps wait for the window reset while the 5 h usage is at or above this %. null = never. */
  quotaPausePercent: number | null;
  /** How often finished runs with an open PR are checked for new comments (REST, free). 0 = off. */
  prPollSeconds: number;
  /** Shared memory (data/memory.sqlite) for the steps with a memory mode. Off = repo notes only. */
  memoryEnabled: boolean;
};

export const DEFAULT_SETTINGS: NexuraSettings = { quotaPausePercent: 90, prPollSeconds: 120, memoryEnabled: true };

/** One entry of the shared memory: a decision, a bug's root cause, a convention, a ticket summary... */
export type MemoryObservation = {
  id: number;
  /** The repo it belongs to: its origin remote's name, lowercased. */
  project: string;
  type: string;
  title: string;
  content: string;
  /** Saving again with the same topic updates this observation instead of adding one. */
  topicKey?: string;
  /** Who saved it: a step name, "nexura", or "claude-code" (interactive session). */
  source?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  revisions: number;
};

export type Metrics = {
  totals: { runs: number; done: number; failed: number; cancelled: number; active: number; costUsd: number; tokens: number };
  /** `agent` is null for builtin steps (no LLM). */
  byStep: { step: string; agent: AgentKind | null; model: string; runs: number; failed: number; costUsd: number; avgCostUsd: number; avgTurns: number; tokens: number }[];
  byProfile: { profile: string; runs: number; done: number; costUsd: number; avgCostUsd: number }[];
  /** Implement executions per run: >1 means review/QA sent the work back. */
  loops: { avgImplementPerRun: number; runsWithLoops: number };
  byDay: { day: string; runs: number; costUsd: number }[];
  classify: { rated: number; correct: number; mistakes: { runId: string; chosen: string; expected?: string; reason?: string }[] };
};

/** Whether an agent's CLI is installed (shown in Configuración and the profile editor). */
export type AgentInfo = {
  agent: AgentKind;
  available: boolean;
  version?: string;
  bin?: string;
  error?: string;
  /** Models the installed CLI accepts, when it can list them for free (copilot); missing = use AGENT_MODELS. */
  models?: string[];
};

export type QuotaInfo = {
  status: string;
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
  updatedAt: string;
};

/** Overrides applied when retrying a failed step from the UI/CLI. */
export type RetryOptions = {
  prompt?: string;
  /** Run the step with another agent (a session is never resumed by a different agent). */
  agent?: AgentKind;
  model?: string;
  effort?: Effort;
  /** Continue the failed step's session instead of starting fresh. */
  resumeSession?: boolean;
  /** Extra instruction sent when resuming. */
  instruction?: string;
  /** Mark the failed step as skipped and go on with the next one. */
  skip?: boolean;
  /** Approved (possibly edited) PR drafts. `skip` at the approval pause = keep the branch local. */
  prDrafts?: PrDraft[];
  /** Approved (possibly edited) replies to the PR threads. */
  replies?: ReviewReply[];
};

/** Messages pushed to the UI over WebSocket. */
export type ServerMessage =
  | { type: "run"; run: Run }
  | { type: "event"; runId: string; stepRunId: string; seq: number; ts: string; event: NexuraEvent }
  | { type: "quota"; quota: QuotaInfo }
  | { type: "runDeleted"; runId: string }
  /** Something the user should hear about even when not looking at that run (e.g. new PR comments). */
  | { type: "notice"; runId?: string; title: string; body: string; level: "info" | "warn" };
