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
