import { afterRenderEffect, Component, computed, ElementRef, input, signal, viewChild } from "@angular/core";
import type { NexuraEvent } from "@nexura/shared";
import type { StoredEvent } from "../../core/api";
import { formatCost, formatDuration, formatTokens, timeOfDay } from "../../core/format";

type ToolUse = Extract<NexuraEvent, { kind: "toolUse" }>;
type ToolResult = Extract<NexuraEvent, { kind: "toolResult" }>;

type TimelineItem =
  | { type: "init"; key: number; ts: string; model: string; tools: string[] }
  | { type: "hook"; key: number; ts: string; name: string; outcome?: string }
  | { type: "text"; key: number; ts: string; text: string }
  | { type: "thinking"; key: number; ts: string; text: string }
  | { type: "note"; key: number; ts: string; text: string }
  | { type: "user"; key: number; ts: string; text: string }
  | { type: "tool"; key: number; ts: string; use: ToolUse; summary: string; result?: ToolResult }
  | { type: "rate"; key: number; ts: string; status: string; window: string }
  | { type: "result"; key: number; ts: string; result: Extract<NexuraEvent, { kind: "result" }> };

const SUMMARY_MAX = 110;
const FOLLOW_THRESHOLD_PX = 40;

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function summarize(use: ToolUse): string {
  const input = (use.input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  let text: string;
  switch (use.name) {
    case "Read":
    case "Write":
    case "Edit":
      text = basename(pick("file_path") ?? "");
      break;
    case "Bash":
    case "Shell":
      text = pick("command") ?? "";
      break;
    case "Grep":
    case "Glob":
      text = pick("pattern") ?? "";
      break;
    case "StructuredOutput":
      text = "entrega la salida estructurada";
      break;
    default:
      text = JSON.stringify(input);
  }
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX - 1) + "…" : text;
}

@Component({
  selector: "nx-event-timeline",
  templateUrl: "./event-timeline.html",
  host: { class: "flex min-h-0 flex-col" },
})
export class EventTimeline {
  public readonly events = input.required<StoredEvent[]>();
  public readonly live = input(false);

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>("scroller");
  protected readonly follow = signal(true);
  protected readonly showThinking = signal(false);
  protected readonly formatCost = formatCost;
  protected readonly formatDuration = formatDuration;
  protected readonly formatTokens = formatTokens;
  protected readonly timeOfDay = timeOfDay;

  protected readonly items = computed<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    const tools = new Map<string, Extract<TimelineItem, { type: "tool" }>>();
    for (const { seq, ts, event } of this.events()) {
      switch (event.kind) {
        case "init":
          items.push({ type: "init", key: seq, ts, model: event.model, tools: event.tools });
          break;
        case "hook":
          if (event.phase === "response") {
            items.push({ type: "hook", key: seq, ts, name: event.name, outcome: event.outcome });
          }
          break;
        case "text":
          items.push({ type: "text", key: seq, ts, text: event.text });
          break;
        case "thinking":
          if (event.text.trim()) {
            items.push({ type: "thinking", key: seq, ts, text: event.text });
          }
          break;
        case "userText":
          items.push({ type: "note", key: seq, ts, text: event.text });
          break;
        case "userMessage":
          items.push({ type: "user", key: seq, ts, text: event.text });
          break;
        case "toolUse": {
          const item = { type: "tool" as const, key: seq, ts, use: event, summary: summarize(event) };
          tools.set(event.id, item);
          items.push(item);
          break;
        }
        case "toolResult": {
          const tool = tools.get(event.toolUseId);
          if (tool) {
            tool.result = event;
          }
          break;
        }
        case "rateLimit":
          if (event.status !== "allowed") {
            items.push({ type: "rate", key: seq, ts, status: event.status, window: event.windowType });
          }
          break;
        case "result":
          items.push({ type: "result", key: seq, ts, result: event });
          break;
      }
    }
    return items;
  });

  protected readonly toolCount = computed(() => this.items().filter((item) => item.type === "tool").length);
  protected readonly errorCount = computed(
    () => this.items().filter((item) => item.type === "tool" && item.result?.isError).length,
  );

  public constructor() {
    afterRenderEffect(() => {
      this.items();
      if (this.follow()) {
        const element = this.scroller().nativeElement;
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  protected onScroll(): void {
    const element = this.scroller().nativeElement;
    this.follow.set(element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX);
  }

  protected json(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  protected jumpToEnd(): void {
    this.follow.set(true);
  }
}
