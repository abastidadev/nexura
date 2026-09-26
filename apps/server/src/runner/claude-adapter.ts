import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  launch: (options) => {
    let dir: string | undefined;
    let mcpFile: string | undefined;
    if (options.mcpServers && Object.keys(options.mcpServers).length) {
      dir = mkdtempSync(join(tmpdir(), "nexura-claude-"));
      mcpFile = join(dir, "mcp.json");
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: options.mcpServers }));
    }
    return {
      args: buildClaudeArgs(options, mcpFile),
      stdin: userMessage(options.prompt),
      interactive: true,
      userMessage,
      normalize,
      cleanup: () => {
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  },
  resumeArgs: (sessionId) => ["--resume", sessionId],
};
