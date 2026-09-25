import type { AgentKind, NexuraEvent } from "@nexura/shared";
import type { ClaudeRunOptions } from "./claude-args.ts";

export type Json = Record<string, any>;

/** What a step asks of its agent. Same shape for every CLI; each adapter maps what it supports. */
export type AgentRunOptions = ClaudeRunOptions & { agent: AgentKind };

export type AgentCommand = { command: string; prefixArgs: string[] };

/** One prepared execution of an agent CLI (built before spawning, so its args can be shown). */
export type AgentLaunch = {
  args: string[];
  /** Written to stdin right after spawning. */
  stdin?: string;
  /** stdin stays open until the result so `send` can add user messages (claude only). */
  interactive: boolean;
  /** Formats a user message typed while the step runs (interactive agents). */
  userMessage?(text: string): string;
  /** Maps one JSON line of stdout to normalised events (keeps its own state per launch). */
  normalize(raw: Json): NexuraEvent[];
  /** Maps a stdout line that is not JSON (default: ignored). */
  text?(line: string): NexuraEvent[];
  /** Events to emit once stdout is over, e.g. a result synthesised from the exit code. */
  finish?(exitCode: number | null, stderr: string): NexuraEvent[];
  /** Removes temporary files (schema, long prompt). */
  cleanup?(): void;
};

export type AgentAdapter = {
  agent: AgentKind;
  /** The binary to spawn. Throws a user-facing (Spanish) error when the CLI is not installed. */
  command(): AgentCommand;
  launch(options: AgentRunOptions): AgentLaunch;
  /** Arguments that reopen a step's session interactively (embedded terminal). */
  resumeArgs(sessionId: string): string[];
  /** How to ask the CLI which models it accepts without calling one (free); missing = it cannot. */
  models?: { args: string[]; parse(output: string): string[] };
};

/** The final `result` event every adapter produces, with defaults for what a CLI does not report. */
export function resultEvent(fields: Partial<Extract<NexuraEvent, { kind: "result" }>> & { success: boolean }): Extract<NexuraEvent, { kind: "result" }> {
  return {
    kind: "result",
    subtype: fields.success ? "success" : "error_during_execution",
    text: "",
    structuredOutput: undefined,
    costUsd: 0,
    numTurns: 1,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 },
    permissionDenials: [],
    apiErrorStatus: null,
    ...fields,
  };
}

/** Status of a rate-limit / usage-limit error in an agent's message (429), else null. */
export function limitStatus(message: string): number | null {
  return /\b429\b|rate.?limit|usage.?limit|quota/i.test(message) ? 429 : null;
}
