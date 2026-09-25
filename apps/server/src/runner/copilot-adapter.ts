import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexuraEvent, TokenUsage } from "@nexura/shared";
import { limitStatus, resultEvent, type AgentAdapter, type AgentLaunch, type AgentRunOptions, type Json } from "./agent-adapter.ts";
import { overrideCommand, resolveNpmCli } from "./agent-bin.ts";
import { checkJson, extractJson } from "./json-check.ts";

/** Longer prompts go through a file: the Windows command line tops out at 32 767 characters. */
export const MAX_INLINE_PROMPT = 24_000;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * `Bash(git diff*)` → `shell(git diff:*)` (`:*` = prefix match), `Bash(npm run check)` →
 * `shell(npm run check)`; `mcp__srv__tool` → `srv(tool)`; Edit/Write → `write`.
 */
function copilotRule(rule: string): string | undefined {
  const bash = /^Bash\((.*)\)$/.exec(rule);
  if (bash) {
    const pattern = bash[1]!.trim();
    const command = pattern.replace(/[:\s]*\*+$/, "").trim();
    if (!command) {
      return "shell";
    }
    return command === pattern ? `shell(${command})` : `shell(${command}:*)`;
  }
  if (rule === "Bash") {
    return "shell";
  }
  if (EDIT_TOOLS.has(rule)) {
    return "write";
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(rule);
  if (mcp) {
    return `${mcp[1]}(${mcp[2]})`;
  }
  return undefined;
}

/**
 * The step's permissions in Copilot's terms. Like `--tools` + `dontAsk` for Claude: a
 * kind of tool the step does not have is denied outright; within the ones it has, only
 * the pre-approved rules run (in `-p` mode anything else is refused: nobody can answer).
 * Deny rules win over allow rules, also for chained commands (`git status ; git push`).
 */
export function copilotPermissions(tools: string[], allowedTools: string[] = [], disallowedTools: string[] = []): { allow: string[]; deny: string[] } {
  const allow = new Set<string>();
  const deny = new Set<string>();
  const canEdit = tools.some((tool) => EDIT_TOOLS.has(tool));
  const canShell = tools.includes("Bash");
  if (canEdit) {
    allow.add("write");
  } else {
    deny.add("write");
  }
  if (!canShell) {
    deny.add("shell");
  }
  for (const rule of allowedTools) {
    const translated = copilotRule(rule);
    if (translated && !(translated.startsWith("shell") && !canShell) && !(translated === "write" && !canEdit)) {
      allow.add(translated);
    }
  }
  for (const rule of disallowedTools) {
    const translated = copilotRule(rule);
    if (translated) {
      deny.add(translated);
    }
  }
  return { allow: [...allow], deny: [...deny] };
}

/** Copilot has no JSON Schema flag: the answer format is asked for in the prompt and checked afterwards. */
export function copilotPrompt(options: AgentRunOptions): string {
  const parts = [options.appendSystemPrompt, options.prompt].filter(Boolean) as string[];
  let prompt = parts.join("\n\n---\n\n");
  if (options.jsonSchema) {
    prompt +=
      "\n\n---\n\n## Formato de la respuesta final\n\nCuando termines, responde con un único bloque ```json que cumpla este JSON Schema, sin texto después del bloque:\n\n```json\n" +
      JSON.stringify(options.jsonSchema, null, 2) +
      "\n```";
  }
  return prompt;
}

export type CopilotFiles = { sessionId: string; usageFile?: string; promptFile?: string };

/** Verified against GitHub Copilot CLI 1.0.88. */
export function buildCopilotArgs(options: AgentRunOptions, prompt: string, files: CopilotFiles): string[] {
  const args = ["-p", files.promptFile ? `Lee el fichero @${files.promptFile} y sigue sus instrucciones al pie de la letra.` : prompt];
  args.push("--output-format", "json", "--no-color", "--no-ask-user", "--model", options.model, "--reasoning-effort", options.effort);
  // A resumed session keeps its id; a new one gets ours, so the step knows it from the start.
  args.push(...(options.resume ? ["--resume", options.resume] : ["--session-id", files.sessionId]));
  const { allow, deny } = copilotPermissions(options.tools, options.allowedTools, options.disallowedTools);
  for (const rule of allow) {
    args.push("--allow-tool", rule);
  }
  for (const rule of deny) {
    args.push("--deny-tool", rule);
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (!options.useMcp) {
    // Like --strict-mcp-config: no built-in GitHub MCP server (fewer tool schemas, fewer tokens).
    args.push("--disable-builtin-mcps");
  }
  const servers = Object.entries(options.mcpConfig?.mcpServers ?? {});
  if (servers.length) {
    const mcpServers = Object.fromEntries(servers.map(([name, server]) => [name, { type: "local", ...server, tools: ["*"] }]));
    args.push("--additional-mcp-config", JSON.stringify({ mcpServers }));
  }
  if (files.usageFile) {
    args.push("--usage-output-file", files.usageFile);
  }
  return args;
}

/** Copilot's tool names, mapped to Claude's so the timeline and the office read them the same way. */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  powershell: "Bash",
  shell: "Bash",
  view: "Read",
  edit: "Edit",
  create: "Write",
  grep: "Grep",
  rg: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  task: "Agent",
  update_todo: "TodoWrite",
};

function toolName(data: Json): string {
  if (typeof data.mcpServerName === "string") {
    const tool = typeof data.mcpToolName === "string" ? data.mcpToolName : String(data.toolName ?? "").replace(`${data.mcpServerName}-`, "");
    return `mcp__${data.mcpServerName}__${tool}`;
  }
  const name = String(data.toolName ?? "tool");
  return TOOL_NAMES[name] ?? name;
}

/**
 * Tokens from `--usage-output-file` (the JSONL stream has none). Copilot's input count
 * includes the cache reads; Nexura, like Claude, counts them apart.
 */
export function copilotUsage(file: string | undefined): TokenUsage | undefined {
  if (!file || !existsSync(file)) {
    return undefined;
  }
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as { modelMetrics?: Record<string, { usage?: Json }> };
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 };
    for (const metrics of Object.values(report.modelMetrics ?? {})) {
      const model = metrics.usage ?? {};
      usage.cacheReadTokens += Number(model.cacheReadTokens ?? 0);
      usage.inputTokens += Number(model.inputTokens ?? 0) - Number(model.cacheReadTokens ?? 0);
      usage.outputTokens += Number(model.outputTokens ?? 0);
      usage.cacheCreationTokens += Number(model.cacheWriteTokens ?? 0);
      usage.thinkingTokens += Number(model.reasoningTokens ?? 0);
    }
    return usage;
  } catch {
    return undefined;
  }
}

/**
 * Maps `copilot -p --output-format json` (verified with Copilot CLI 1.0.88) to Nexura
 * events: `assistant.message` (text, `reasoningText`), `tool.execution_start/complete`,
 * `assistant.turn_start`, and a final `result` with the session id, exit code and premium
 * requests. Events marked `ephemeral` (deltas, model calls, MCP status) are skipped. There
 * is no start event: `init` goes out with the first line, with the session id Nexura chose.
 * The step's answer is the ```json block of the last message when it has a schema.
 */
export function copilotNormalizer(
  options: { jsonSchema?: object; model?: string; cwd?: string; sessionId?: string; usageFile?: string; startedAt?: number } = {},
): Pick<AgentLaunch, "normalize" | "text" | "finish"> {
  const startedAt = options.startedAt ?? Date.now();
  let messages: string[] = [];
  let turns = 0;
  let started = false;
  let error: string | undefined;
  let premiumRequests: number | undefined;

  const init = (): NexuraEvent[] => {
    if (started) {
      return [];
    }
    started = true;
    return [{ kind: "init", sessionId: options.sessionId ?? "", model: options.model ?? "", cwd: options.cwd ?? "", tools: [], claudeVersion: "copilot" }];
  };

  const map = (raw: Json): NexuraEvent[] => {
    const type = String(raw.type ?? "");
    const data: Json = raw.data ?? {};
    if (raw.ephemeral) {
      return [];
    }
    switch (type) {
      case "assistant.turn_start":
        turns++;
        return [];
      case "assistant.message": {
        const events: NexuraEvent[] = [];
        if (typeof data.reasoningText === "string" && data.reasoningText.trim()) {
          events.push({ kind: "thinking", text: data.reasoningText });
        }
        const text = String(data.content ?? "");
        if (text.trim()) {
          messages.push(text);
          events.push({ kind: "text", text });
        }
        return events;
      }
      case "tool.execution_start":
        return [
          {
            kind: "toolUse",
            id: String(data.toolCallId ?? ""),
            name: toolName(data),
            input: data.arguments ?? {},
            parentToolUseId: data.parentToolCallId ?? null,
          },
        ];
      case "tool.execution_complete": {
        const result = data.result;
        const content = typeof result === "string" ? result : String(result?.content ?? data.error?.message ?? JSON.stringify(result ?? ""));
        return [
          {
            kind: "toolResult",
            toolUseId: String(data.toolCallId ?? ""),
            content,
            isError: data.success === false || Boolean(data.error),
            parentToolUseId: data.parentToolCallId ?? null,
          },
        ];
      }
      case "result":
        premiumRequests = raw.usage?.premiumRequests;
        return [];
      case "session.error":
      case "error":
        error = String(data.message ?? raw.message ?? "error");
        return [{ kind: "text", text: `⚠ ${error}` }];
      case "user.message":
      case "assistant.turn_end":
      case "session.usage_checkpoint":
        return [];
      default:
        return [{ kind: "unknown", type: `copilot:${type}` }];
    }
  };

  return {
    normalize: (raw) => [...init(), ...map(raw)],
    text(line) {
      // Plain-text output (a CLI without --output-format json): still usable.
      messages.push(line);
      return [...init(), { kind: "text", text: line }];
    },
    finish(exitCode, stderr) {
      const success = exitCode === 0 && !error;
      const text = messages.at(-1) ?? "";
      let structuredOutput: unknown;
      let failure = success ? undefined : (error ?? `copilot terminó (exit ${exitCode}). ${stderr.trim().split(/\r?\n/).slice(-20).join("\n")}`.trim());
      if (success && options.jsonSchema) {
        structuredOutput = extractJson(messages.join("\n\n"));
        const problems = structuredOutput === undefined ? ["no hay bloque JSON"] : checkJson(structuredOutput, options.jsonSchema as Json);
        if (problems.length) {
          failure = `La respuesta no cumple el schema del paso: ${problems.slice(0, 5).join("; ")}`;
          structuredOutput = undefined;
        }
      }
      messages = [];
      const premium: NexuraEvent[] = premiumRequests ? [{ kind: "text", text: `Copilot: ${premiumRequests} petición(es) premium.` }] : [];
      return [
        ...init(),
        ...premium,
        resultEvent({
          success: !failure,
          subtype: failure ? (success ? "invalid_structured_output" : "error_during_execution") : "success",
          text: failure ?? text,
          structuredOutput,
          numTurns: Math.max(1, turns),
          durationMs: Date.now() - startedAt,
          ...(copilotUsage(options.usageFile) ? { usage: copilotUsage(options.usageFile)! } : {}),
          apiErrorStatus: failure ? limitStatus(failure) : null,
        }),
      ];
    },
  };
}

/**
 * Model ids of the `model` setting in `copilot help config`, which lists every model the
 * installed version accepts (one `- "id"` line each). No network, no tokens.
 */
export function parseCopilotModels(help: string): string[] {
  const section = /^\s*`model`:.*\r?\n((?:[ \t]+- "[^"]+".*\r?\n?)+)/m.exec(help)?.[1] ?? "";
  const models = [...section.matchAll(/- "([^"]+)"/g)].map((match) => match[1]!);
  return models.length ? [...models, "auto"] : [];
}

/**
 * `copilot -p` (GitHub Copilot CLI): prompt as an argument (or a file for long ones),
 * JSONL on stdout, permissions with --allow-tool/--deny-tool. It gives access to models
 * of several vendors (Claude, GPT, Gemini) under the Copilot plan; no USD cost is reported.
 */
export const copilotAdapter: AgentAdapter = {
  agent: "copilot",
  command() {
    const override = process.env.NEXURA_COPILOT_BIN;
    const command = override ? overrideCommand(override) : resolveNpmCli("copilot", "@github/copilot", "GitHub.Copilot");
    if (!command) {
      throw new Error(
        "No se encuentra GitHub Copilot CLI (copilot). Instálalo con `winget install GitHub.Copilot` o `npm install -g @github/copilot` y haz `copilot login`, o define NEXURA_COPILOT_BIN",
      );
    }
    return command;
  },
  launch(options) {
    const prompt = copilotPrompt(options);
    const dir = mkdtempSync(join(tmpdir(), "nexura-copilot-"));
    const files: CopilotFiles = { sessionId: options.resume ?? randomUUID(), usageFile: join(dir, "usage.json") };
    let launchOptions = options;
    if (prompt.length > MAX_INLINE_PROMPT) {
      files.promptFile = join(dir, "prompt.md");
      writeFileSync(files.promptFile, prompt);
      launchOptions = { ...options, addDirs: [...(options.addDirs ?? []), dir] };
    }
    return {
      args: buildCopilotArgs(launchOptions, prompt, files),
      interactive: false,
      ...copilotNormalizer({ jsonSchema: options.jsonSchema, model: options.model, cwd: options.cwd, sessionId: files.sessionId, usageFile: files.usageFile }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  resumeArgs: (sessionId) => ["--resume", sessionId],
  models: { args: ["help", "config"], parse: parseCopilotModels },
};
