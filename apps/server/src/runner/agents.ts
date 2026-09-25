import { execFile } from "node:child_process";
import { AGENT_KINDS, type AgentInfo, type AgentKind } from "@nexura/shared";
import type { AgentAdapter } from "./agent-adapter.ts";
import { claudeAdapter } from "./claude-adapter.ts";
import { claudeEnv } from "./claude-process.ts";
import { codexAdapter } from "./codex-adapter.ts";
import { copilotAdapter } from "./copilot-adapter.ts";

const ADAPTERS: Record<AgentKind, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter, copilot: copilotAdapter };

export function adapterFor(agent: AgentKind | undefined): AgentAdapter {
  const adapter = ADAPTERS[agent ?? "claude"];
  if (!adapter) {
    throw new Error(`Agente desconocido: ${agent}`);
  }
  return adapter;
}

const VERSION_TIMEOUT_MS = 15_000;

/** Whether each agent's CLI is installed, with its `--version` and models when it lists them (free: no model call). */
export async function detectAgents(): Promise<AgentInfo[]> {
  return Promise.all(AGENT_KINDS.map(detectAgent));
}

async function detectAgent(agent: AgentKind): Promise<AgentInfo> {
  let command: ReturnType<AgentAdapter["command"]>;
  try {
    command = adapterFor(agent).command();
  } catch (error) {
    return { agent, available: false, error: error instanceof Error ? error.message : String(error) };
  }
  const bin = [command.command, ...command.prefixArgs].join(" ");
  const version = await run(command, ["--version"]);
  if (version.error !== undefined) {
    return { agent, available: false, bin, error: version.error };
  }
  const info: AgentInfo = { agent, available: true, bin, version: version.stdout.trim().split(/\r?\n/)[0] };
  const lister = adapterFor(agent).models;
  if (lister) {
    const listed = await run(command, lister.args);
    const models = listed.error === undefined ? lister.parse(listed.stdout) : [];
    if (models.length) {
      info.models = models;
    }
  }
  return info;
}

function run(command: ReturnType<AgentAdapter["command"]>, args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(command.command, [...command.prefixArgs, ...args], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env: claudeEnv() }, (error, stdout) => {
      resolve(error ? { stdout, error: error.message.split(/\r?\n/)[0] ?? "" } : { stdout });
    });
  });
}
