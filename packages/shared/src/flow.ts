import type { NexuraEvent, TokenUsage } from "./events.ts";

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

export type StepName = (typeof STEP_NAMES)[number];

export type ModelAlias = "haiku" | "sonnet" | "opus";

export type Effort = "low" | "medium" | "high" | "xhigh";

export type StepConfig = {
  model: ModelAlias;
  effort: Effort;
  enabled: boolean;
};

export type FlowProfile = {
  name: string;
  description: string;
  steps: Partial<Record<StepName, StepConfig>>;
  /** How many times review/qa may send the flow back to implement. */
  maxLoops: number;
  budgetUsd?: number;
};

/** Static definition of a step, from config/steps/<step>/step.json. */
export type StepDefinition = {
  name: StepName;
  /** `claude` runs `claude -p`; `builtin` is plain code in the orchestrator (no tokens). */
  kind: "claude" | "builtin";
  /** Hard allowlist of built-in tools (`--tools`). Empty array disables all tools. */
  tools: string[];
  /** Permission rules added on top (`--allowedTools`), e.g. "Bash(npm run *)". */
  allowedTools: string[];
  /** Always denied (`--disallowedTools`), e.g. "Bash(git push *)". */
  disallowedTools: string[];
  /** Keep MCP servers from user/project config. Off = `--strict-mcp-config` (cheaper context). */
  useMcp: boolean;
  timeoutMs: number;
};

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
  /** `pr`: after release, pause for approval, then push and open the PR in Azure DevOps. */
  release?: "local" | "pr";
};

/** Work item as loaded from Azure DevOps (HTML fields already converted to text). */
export type TicketDetails = {
  id: number;
  type: string;
  title: string;
  state: string;
  project: string;
  url: string;
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  comments: { author: string; date: string; text: string }[];
  children: { id: number; title: string; state: string; type: string; done: boolean }[];
};

/** A pull request waiting for approval (editable) before push + create. */
export type PrDraft = {
  repo: string;
  branch: string;
  target: string;
  title: string;
  description: string;
  workItemId?: number;
  isDraft: boolean;
};

export type CreatedPr = { repo: string; id: number; url: string; title: string };

/** An active comment thread of a PR, as read from Azure DevOps. */
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
  /** Position in the run (increments on every execution, including loops and retries). */
  seq: number;
  status: StepStatus;
  kind: "claude" | "builtin";
  model: ModelAlias;
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
  /** Azure DevOps PR status of the first PR: active, completed, abandoned. Polling stops when not active. */
  prStatus: string;
  error?: string;
};

/** Server-wide settings, editable in Configuración > General. */
export type NexuraSettings = {
  /** Claude steps wait for the window reset while the 5 h usage is at or above this %. null = never. */
  quotaPausePercent: number | null;
  /** How often finished runs with an open PR are checked for new comments (REST, free). 0 = off. */
  prPollSeconds: number;
};

export const DEFAULT_SETTINGS: NexuraSettings = { quotaPausePercent: 90, prPollSeconds: 120 };

export type Metrics = {
  totals: { runs: number; done: number; failed: number; cancelled: number; active: number; costUsd: number; tokens: number };
  byStep: { step: string; model: string; runs: number; failed: number; costUsd: number; avgCostUsd: number; avgTurns: number; tokens: number }[];
  byProfile: { profile: string; runs: number; done: number; costUsd: number; avgCostUsd: number }[];
  /** Implement executions per run: >1 means review/QA sent the work back. */
  loops: { avgImplementPerRun: number; runsWithLoops: number };
  byDay: { day: string; runs: number; costUsd: number }[];
  classify: { rated: number; correct: number; mistakes: { runId: string; chosen: string; expected?: string; reason?: string }[] };
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
  model?: ModelAlias;
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
  /** Something the user should hear about even when not looking at that run (e.g. new PR comments). */
  | { type: "notice"; runId?: string; title: string; body: string; level: "info" | "warn" };
