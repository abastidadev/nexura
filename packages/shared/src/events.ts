// Normalised view of the `claude -p --output-format stream-json --verbose` events.
// The raw line is always kept next to it (raw JSONL log), so nothing is lost when a
// field is not modelled here.

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
};

export type RateLimitWindow = {
  utilization: number;
  resetsAt: number;
};

export type NexuraEvent =
  | { kind: "init"; sessionId: string; model: string; cwd: string; tools: string[]; claudeVersion: string }
  | { kind: "hook"; name: string; phase: "started" | "response"; outcome?: string; exitCode?: number }
  | { kind: "thinking"; text: string }
  | { kind: "thinkingTokens"; estimatedTokens: number }
  | { kind: "text"; text: string }
  | { kind: "toolUse"; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: "toolResult"; toolUseId: string; content: string; isError: boolean; parentToolUseId: string | null }
  | { kind: "userText"; text: string; synthetic: boolean }
  /** A message the user typed in Nexura while the step was running (not part of the claude stream). */
  | { kind: "userMessage"; text: string }
  | {
      kind: "rateLimit";
      status: string;
      windowType: string;
      resetsAt: number;
      fiveHour?: RateLimitWindow;
      sevenDay?: RateLimitWindow;
    }
  | {
      kind: "result";
      success: boolean;
      subtype: string;
      text: string;
      structuredOutput: unknown;
      costUsd: number;
      numTurns: number;
      durationMs: number;
      usage: TokenUsage;
      permissionDenials: unknown[];
      terminalReason?: string;
      apiErrorStatus: number | null;
    }
  | { kind: "unknown"; type: string; subtype?: string };
