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
  /** Set while paused on a breakpoint: the step about to run and its rendered prompt (editable). */
  pendingStep?: { step: StepName; prompt?: string };
  /** Epoch seconds when a rate-limited run will resume. */
  resumesAt?: number;
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
};

/** Messages pushed to the UI over WebSocket. */
export type ServerMessage =
  | { type: "run"; run: Run }
  | { type: "event"; runId: string; stepRunId: string; seq: number; ts: string; event: NexuraEvent }
  | { type: "quota"; quota: QuotaInfo };
