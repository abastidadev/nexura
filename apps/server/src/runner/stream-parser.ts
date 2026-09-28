import type { NexuraEvent, TokenUsage } from "@nexura/shared";

type Json = Record<string, any>;

/** Splits a chunked stdout stream into complete lines. */
export class LineSplitter {
  private buffer = "";

  public push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.trim().length > 0);
  }

  public flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

export function parseLine(line: string): Json | undefined {
  try {
    return JSON.parse(line.replace(/^﻿/, "")) as Json;
  } catch {
    return undefined;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block: Json) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
  }
  return JSON.stringify(content);
}

function toUsage(usage: Json | undefined): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    thinkingTokens: usage?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "thinkingTokens"] as const;

/**
 * Token usage seen in the stream's `assistant` messages, main agent and subagents alike.
 * Claude repeats a message's usage on each of its content blocks (output grows as it
 * streams), so each message id keeps its largest value per field. A lower bound of what
 * was consumed: it survives a process that dies before its `result` event, and background
 * work that goes on after it.
 */
export class StreamUsage {
  private readonly messages = new Map<string, TokenUsage>();
  /** Message ids of the main agent (not its subagents), in order. */
  private readonly main: string[] = [];

  public push(raw: Json | undefined): void {
    const id = raw?.message?.id;
    if (raw?.type !== "assistant" || typeof id !== "string" || !raw.message.usage) {
      return;
    }
    const seen = this.messages.get(id);
    const usage = toUsage(raw.message.usage);
    this.messages.set(id, seen ? maxUsage(seen, usage) : usage);
    if (!seen && !raw.parent_tool_use_id) {
      this.main.push(id);
    }
  }

  /** The main agent's first call: whether it read the conversation from the cache or wrote it. */
  public firstCall(): TokenUsage | undefined {
    return this.main.length ? this.messages.get(this.main[0]!) : undefined;
  }

  /** Size of the conversation at the main agent's last call, in tokens. */
  public contextTokens(): number | undefined {
    const last = this.main.length ? this.messages.get(this.main.at(-1)!) : undefined;
    return last ? last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens : undefined;
  }

  public total(): TokenUsage {
    const total = emptyUsage();
    for (const usage of this.messages.values()) {
      for (const field of TOKEN_FIELDS) {
        total[field] += usage[field];
      }
    }
    return total;
  }
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 };
}

export function maxUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const max = emptyUsage();
  for (const field of TOKEN_FIELDS) {
    max[field] = Math.max(a[field], b[field]);
  }
  return max;
}

/** What `observed` has beyond `reported`, field by field; undefined when nothing. */
export function usageBeyond(observed: TokenUsage, reported: TokenUsage | undefined): TokenUsage | undefined {
  const extra = emptyUsage();
  for (const field of TOKEN_FIELDS) {
    extra[field] = Math.max(0, observed[field] - (reported?.[field] ?? 0));
  }
  return TOKEN_FIELDS.some((field) => extra[field] > 0) ? extra : undefined;
}

/** Maps one raw stream-json event to zero or more normalised events. */
export function normalize(raw: Json): NexuraEvent[] {
  switch (raw.type) {
    case "system":
      return normalizeSystem(raw);
    case "assistant":
      return (raw.message?.content ?? []).flatMap((block: Json): NexuraEvent[] => {
        switch (block.type) {
          case "text":
            return [{ kind: "text", text: block.text }];
          case "thinking":
            return [{ kind: "thinking", text: block.thinking ?? "" }];
          case "tool_use":
            return [
              {
                kind: "toolUse",
                id: block.id,
                name: block.name,
                input: block.input,
                parentToolUseId: raw.parent_tool_use_id ?? null,
              },
            ];
          default:
            return [{ kind: "unknown", type: `assistant:${block.type}` }];
        }
      });
    case "user": {
      const content = raw.message?.content;
      if (typeof content === "string") {
        return [{ kind: "userText", text: content, synthetic: Boolean(raw.isSynthetic) }];
      }
      return (content ?? []).map((block: Json): NexuraEvent => {
        if (block.type === "tool_result") {
          return {
            kind: "toolResult",
            toolUseId: block.tool_use_id,
            content: toolResultText(block.content),
            isError: Boolean(block.is_error),
            parentToolUseId: raw.parent_tool_use_id ?? null,
          };
        }
        if (block.type === "text") {
          return { kind: "userText", text: block.text, synthetic: Boolean(raw.isSynthetic) };
        }
        return { kind: "unknown", type: `user:${block.type}` };
      });
    }
    case "rate_limit_event": {
      const info = raw.rate_limit_info ?? {};
      return [
        {
          kind: "rateLimit",
          status: info.status,
          windowType: info.rateLimitType,
          resetsAt: info.resetsAt,
          fiveHour: info.unifiedWindows?.five_hour,
          sevenDay: info.unifiedWindows?.seven_day,
        },
      ];
    }
    case "result":
      return [
        {
          kind: "result",
          success: raw.subtype === "success" && !raw.is_error,
          subtype: raw.subtype,
          text: typeof raw.result === "string" ? raw.result : "",
          structuredOutput: raw.structured_output,
          costUsd: raw.total_cost_usd ?? 0,
          numTurns: raw.num_turns ?? 0,
          durationMs: raw.duration_ms ?? 0,
          usage: toUsage(raw.usage),
          permissionDenials: raw.permission_denials ?? [],
          terminalReason: raw.terminal_reason,
          apiErrorStatus: raw.api_error_status ?? null,
        },
      ];
    default:
      return [{ kind: "unknown", type: String(raw.type), subtype: raw.subtype }];
  }
}

function normalizeSystem(raw: Json): NexuraEvent[] {
  switch (raw.subtype) {
    case "init":
      return [
        {
          kind: "init",
          sessionId: raw.session_id,
          model: raw.model,
          cwd: raw.cwd,
          tools: raw.tools ?? [],
          claudeVersion: raw.claude_code_version,
        },
      ];
    case "hook_started":
    case "hook_response":
      return [
        {
          kind: "hook",
          name: raw.hook_name,
          phase: raw.subtype === "hook_started" ? "started" : "response",
          outcome: raw.outcome,
          exitCode: raw.exit_code,
        },
      ];
    case "thinking_tokens":
      return [{ kind: "thinkingTokens", estimatedTokens: raw.estimated_tokens ?? 0 }];
    default:
      return [{ kind: "unknown", type: "system", subtype: raw.subtype }];
  }
}
