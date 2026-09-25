import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { overrideCommand, whereFirst } from "./agent-bin.ts";
import type { AgentCommand } from "./agent-adapter.ts";

let cachedBin: string | undefined;

/**
 * Variables that tie a process to the Claude Code session that launched it (bridge,
 * messaging socket, child-session markers). If Nexura itself was started from a Claude
 * Code terminal they would leak into every step, e.g. turning transcript saving off.
 * Config and auth variables (CLAUDE_CONFIG_DIR, ANTHROPIC_*) are kept.
 */
const SESSION_VARIABLES = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|BRIDGE_SESSION_ID|MESSAGING_.*|SESSION_.*|SSE_PORT))$/;

export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !SESSION_VARIABLES.test(name)));
}

export type ClaudeCommand = AgentCommand;

/**
 * On Windows the npm shim is a .cmd/.ps1; spawning the real exe avoids cmd.exe quoting.
 * NEXURA_CLAUDE_BIN may point to another binary, or to a .js/.mjs script run with node
 * (used by the tests to replay fake stream-json without spending tokens).
 */
export function resolveClaudeCommand(): ClaudeCommand {
  const override = process.env.NEXURA_CLAUDE_BIN;
  if (override && /\.m?js$/.test(override)) {
    return overrideCommand(override);
  }
  return { command: resolveClaudeBin(), prefixArgs: [] };
}

export function resolveClaudeBin(): string {
  if (process.env.NEXURA_CLAUDE_BIN) {
    return process.env.NEXURA_CLAUDE_BIN;
  }
  if (cachedBin) {
    return cachedBin;
  }
  if (process.platform !== "win32") {
    cachedBin = "claude";
  } else {
    // npm install: a claude.cmd shim with the real exe in its node_modules.
    const shim = whereFirst("claude.cmd");
    const npmExe = shim ? join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : undefined;
    // Native installer: claude.exe straight on the PATH (~/.local/bin).
    const exe = npmExe && existsSync(npmExe) ? npmExe : whereFirst("claude.exe");
    if (!exe) {
      throw new Error("No se encuentra Claude Code (ni claude.cmd de npm ni claude.exe en el PATH); instálalo o define NEXURA_CLAUDE_BIN");
    }
    cachedBin = exe;
  }
  return cachedBin;
}
