import type { Effort, ModelAlias } from "@nexura/shared";

export type ClaudeRunOptions = {
  cwd: string;
  prompt: string;
  model: ModelAlias;
  effort: Effort;
  /** Hard allowlist of built-in tools. Empty array = no tools at all. */
  tools: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  /** Extra MCP servers (`--mcp-config`), loaded even with `useMcp` off, e.g. engram for the memory. */
  mcpConfig?: { mcpServers: Record<string, { command: string; args: string[] }> };
  addDirs?: string[];
  /** JSON Schema object; the step's answer comes back in `result.structuredOutput`. */
  jsonSchema?: object;
  appendSystemPrompt?: string;
  sessionId?: string;
  resume?: string;
  forkSession?: boolean;
  maxBudgetUsd?: number;
  timeoutMs?: number;
};

/**
 * Builds the CLI arguments. The prompt is NOT included: it is written to stdin as a
 * stream-json user message, and stdin stays open so the user can send more messages
 * while the step runs (they join the current turn; see ClaudeProcess.send).
 *
 * Permissions (verified in the spike): `--allowedTools` only ADDS rules on top of the
 * user's settings, so it does not restrict anything. The real allowlist is `--tools`,
 * and `--permission-mode dontAsk` makes anything not pre-approved fail instead of
 * waiting for a prompt that nobody will answer.
 */
export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--permission-mode",
    "dontAsk",
    "--tools",
    options.tools.join(","),
  ];

  if (options.allowedTools?.length) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools?.length) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  if (!options.useMcp) {
    args.push("--strict-mcp-config");
  }
  if (options.mcpConfig) {
    args.push("--mcp-config", JSON.stringify(options.mcpConfig));
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.resume) {
    args.push("--resume", options.resume);
    if (options.forkSession) {
      args.push("--fork-session");
    }
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  return args;
}
