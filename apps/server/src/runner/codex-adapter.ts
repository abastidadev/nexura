import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexuraEvent } from "@nexura/shared";
import { limitStatus, resultEvent, type AgentAdapter, type AgentLaunch, type AgentRunOptions, type Json } from "./agent-adapter.ts";
import { overrideCommand, resolveNpmCli } from "./agent-bin.ts";
import { fromStrictOutput, toStrictSchema } from "./strict-schema.ts";
import type { McpServerSpec } from "../workspace/claude-inventory.ts";

/** Tools that change files: a step with any of them gets a writable sandbox. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Codex has no per-tool allowlist: its sandbox is the permission model. Steps that edit
 * files get `workspace-write` (the worktree only, no network, so no push and no commits in
 * the main repo's .git); the rest get `read-only`, where commands still run (git diff for
 * a review) but cannot write.
 */
export function codexSandbox(tools: string[]): "read-only" | "workspace-write" {
  return tools.some((tool) => WRITE_TOOLS.has(tool)) ? "workspace-write" : "read-only";
}

/** A TOML inline table of strings (`{ "K" = "v" }`); a JSON string is a valid TOML string. */
function tomlTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(String(value))}`)
    .join(", ")} }`;
}

/** `-c` settings of one server: stdio (command/args/env) or streamable HTTP (url/headers). */
function serverSettings(server: McpServerSpec): string[] {
  if ("url" in server) {
    return [`url=${JSON.stringify(server.url)}`, ...(server.headers ? [`http_headers=${tomlTable(server.headers)}`] : [])];
  }
  return [
    `command=${JSON.stringify(server.command)}`,
    `args=${JSON.stringify(server.args ?? [])}`,
    ...(server.env ? [`env=${tomlTable(server.env)}`] : []),
  ];
}

/**
 * `-c` overrides that register the step's MCP servers: Nexura's memory server and the ones
 * taken from the repo's Claude config (the TOML value of a JSON string/array is the same text).
 */
function mcpOverrides(options: AgentRunOptions): string[] {
  const servers: Record<string, McpServerSpec> = { ...options.mcpServers, ...options.mcpConfig?.mcpServers };
  // Codex takes a server name as a bare TOML key.
  return Object.entries(servers).filter(([name]) => /^[A-Za-z0-9_-]+$/.test(name)).flatMap(([name, server]) => [
    ...serverSettings(server).flatMap((setting) => ["-c", `mcp_servers.${name}.${setting}`]),
    // Pre-approve only tools explicitly allowed for this step on its injected servers.
    ...(options.allowedTools ?? []).filter((tool) => tool.startsWith(`mcp__${name}__`) && /^[A-Za-z0-9_-]+$/.test(tool.slice(`mcp__${name}__`.length)) && !options.disallowedTools?.includes(tool)).flatMap((tool) => [
      "-c",
      `mcp_servers.${name}.tools.${tool.slice(`mcp__${name}__`.length)}.approval_mode="approve"`,
    ]),
  ]);
}

/** Codex has no `--append-system-prompt`: the extra instructions (memory protocol) go before the prompt. */
export function codexPrompt(options: AgentRunOptions): string {
  return options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n---\n\n${options.prompt}` : options.prompt;
}

export function buildCodexArgs(options: AgentRunOptions, schemaFile?: string): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "--model", options.model, "-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`];
  args.push("--sandbox", codexSandbox(options.tools));
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  args.push(...mcpOverrides(options));
  if (schemaFile) {
    args.push("--output-schema", schemaFile);
  }
  if (options.resume) {
    args.push("resume", options.resume);
  }
  // `-`: the prompt comes from stdin (no command-line length limit, no quoting).
  args.push("-");
  return args;
}

const usageOf = (usage: Json | undefined) => ({
  inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - (usage?.cached_input_tokens ?? 0)),
  outputTokens: usage?.output_tokens ?? 0,
  cacheReadTokens: usage?.cached_input_tokens ?? 0,
  cacheCreationTokens: 0,
  thinkingTokens: usage?.reasoning_output_tokens ?? 0,
});

/**
 * Maps `codex exec --json` (thread/turn/item events) to Nexura events. Commands look like
 * Bash tool calls and file changes like Edit calls, so the timeline and the office treat
 * them as they treat Claude's. The last agent message is the step's answer.
 */
export function codexNormalizer(options: { jsonSchema?: object; model?: string; cwd?: string; startedAt?: number } = {}): Pick<AgentLaunch, "normalize" | "finish"> {
  const started = new Set<string>();
  const startedAt = options.startedAt ?? Date.now();
  let lastMessage = "";
  let turns = 0;
  let sessionId = "";
  let done = false;

  const toolUse = (item: Json): NexuraEvent | undefined => {
    const base = { id: String(item.id), parentToolUseId: null };
    switch (item.type) {
      case "command_execution":
        return { kind: "toolUse", ...base, name: "Bash", input: { command: item.command } };
      case "file_change": {
        const changes = (item.changes ?? []) as { path: string; kind: string }[];
        const name = changes.length > 0 && changes.every((change) => change.kind === "add") ? "Write" : "Edit";
        return { kind: "toolUse", ...base, name, input: { file_path: changes[0]?.path, changes } };
      }
      case "mcp_tool_call":
        return { kind: "toolUse", ...base, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
      case "web_search":
        return { kind: "toolUse", ...base, name: "WebSearch", input: { query: item.query } };
      case "todo_list":
        return { kind: "toolUse", ...base, name: "TodoWrite", input: { todos: item.items } };
      default:
        return undefined;
    }
  };

  const toolResult = (item: Json): NexuraEvent => {
    const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
    let content: string;
    switch (item.type) {
      case "command_execution":
        content = `${item.aggregated_output ?? ""}${typeof item.exit_code === "number" ? `\n(exit ${item.exit_code})` : ""}`.trim();
        break;
      case "file_change":
        content = ((item.changes ?? []) as { path: string; kind: string }[]).map((change) => `${change.kind} ${change.path}`).join("\n");
        break;
      case "mcp_tool_call":
        content = item.error?.message ?? ((item.result?.content ?? []) as Json[]).map((block) => block.text ?? `[${block.type}]`).join("\n");
        break;
      default:
        content = item.status ?? "ok";
    }
    return { kind: "toolResult", toolUseId: String(item.id), content, isError: failed, parentToolUseId: null };
  };

  const result = (success: boolean, text: string, usage?: Json): NexuraEvent => {
    done = true;
    let structuredOutput: unknown;
    if (success && options.jsonSchema) {
      try {
        structuredOutput = fromStrictOutput(JSON.parse(text), options.jsonSchema as Json);
      } catch {
        structuredOutput = undefined;
      }
    }
    return resultEvent({
      success,
      text,
      structuredOutput,
      numTurns: Math.max(1, turns),
      durationMs: Date.now() - startedAt,
      usage: usageOf(usage),
      apiErrorStatus: success ? null : limitStatus(text),
    });
  };

  return {
    normalize(raw: Json): NexuraEvent[] {
      switch (raw.type) {
        case "thread.started":
          sessionId = String(raw.thread_id ?? "");
          return [{ kind: "init", sessionId, model: options.model ?? "", cwd: options.cwd ?? "", tools: [], claudeVersion: "codex" }];
        case "turn.started":
          return [];
        case "item.started": {
          const use = toolUse(raw.item ?? {});
          if (use) {
            started.add(String(raw.item.id));
            return [use];
          }
          return [];
        }
        case "item.updated":
          return [];
        case "item.completed": {
          const item: Json = raw.item ?? {};
          switch (item.type) {
            case "agent_message":
              lastMessage = String(item.text ?? "");
              return [{ kind: "text", text: lastMessage }];
            case "reasoning":
              return [{ kind: "thinking", text: String(item.text ?? "") }];
            case "error":
              return [{ kind: "text", text: `⚠ ${item.message ?? "error"}` }];
            default: {
              const use = started.has(String(item.id)) ? undefined : toolUse(item);
              if (!use && !started.has(String(item.id))) {
                return [{ kind: "unknown", type: `codex:${item.type}` }];
              }
              return [...(use ? [use] : []), toolResult(item)];
            }
          }
        }
        case "turn.completed": {
          turns++;
          return [result(true, lastMessage, raw.usage)];
        }
        case "turn.failed":
          turns++;
          return [result(false, String(raw.error?.message ?? "turn.failed"))];
        case "error":
          // Reconnection notices come as `error` too; only the final turn.failed/exit decides.
          return [{ kind: "text", text: `⚠ ${raw.message ?? "error"}` }];
        default:
          return [{ kind: "unknown", type: String(raw.type) }];
      }
    },
    finish(exitCode, stderr) {
      if (done) {
        return [];
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-20).join("\n");
      return [result(false, `codex terminó (exit ${exitCode}) sin completar el turno. ${tail}`.trim())];
    },
  };
}

/**
 * `codex exec --json` (OpenAI Codex CLI, ChatGPT plan): prompt by stdin, JSONL events on
 * stdout, `--output-schema` for the structured answer (strict mode, see toStrictSchema).
 * No USD cost is reported (the plan has none); tokens are.
 */
export const codexAdapter: AgentAdapter = {
  agent: "codex",
  command() {
    const override = process.env.NEXURA_CODEX_BIN;
    const command = override ? overrideCommand(override) : resolveNpmCli("codex", "@openai/codex");
    if (!command) {
      throw new Error("No se encuentra Codex CLI (codex). Instálalo con `npm install -g @openai/codex` y haz `codex login`, o define NEXURA_CODEX_BIN");
    }
    return command;
  },
  launch(options) {
    let dir: string | undefined;
    let schemaFile: string | undefined;
    if (options.jsonSchema) {
      dir = mkdtempSync(join(tmpdir(), "nexura-codex-"));
      schemaFile = join(dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(toStrictSchema(options.jsonSchema as Record<string, unknown>)));
    }
    return {
      args: buildCodexArgs(options, schemaFile),
      stdin: codexPrompt(options),
      interactive: false,
      ...codexNormalizer({ jsonSchema: options.jsonSchema, model: options.model, cwd: options.cwd }),
      cleanup: () => {
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  },
  resumeArgs: (sessionId) => ["resume", sessionId],
};
