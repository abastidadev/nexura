import type { TokenUsage } from "./events.ts";

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
  status: StepStatus;
  model: ModelAlias;
  effort: Effort;
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
  totalCostUsd: number;
};
