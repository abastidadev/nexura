import type { AgentAdapter } from "./agent-adapter.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { resolveClaudeCommand } from "./claude-process.ts";
import { normalize } from "./stream-parser.ts";

function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * `claude -p` with stream-json in and out: the prompt goes to stdin as a user message and
 * stdin stays open, so the user can add messages while the step runs.
 */
export const claudeAdapter: AgentAdapter = {
  agent: "claude",
  command: resolveClaudeCommand,
  launch: (options) => ({
    args: buildClaudeArgs(options),
    stdin: userMessage(options.prompt),
    interactive: true,
    userMessage,
    normalize,
  }),
  resumeArgs: (sessionId) => ["--resume", sessionId],
};
