import type { NexuraEvent } from "./events.ts";

/** What an agent looks like it is doing, from its latest event (2D office, 3D office bridge). */
export type AgentActivity =
  | "waiting"
  | "idle"
  | "thinking"
  | "reading"
  | "typing"
  | "running"
  | "delegating"
  | "blocked"
  | "done"
  | "failed";

export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "LS"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RUN_TOOLS = new Set(["Bash", "Shell", "PowerShell"]);
const BUBBLE_MAX = 34;

/** First line of a text, cut to fit a speech bubble. */
export function clipBubble(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > BUBBLE_MAX ? line.slice(0, BUBBLE_MAX - 1) + "…" : line;
}

/** A string field of a tool input, if it has one. */
export function inputField(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

/** "Edit app.ts", "Bash npm test"… */
export function toolBubble(name: string, input: unknown): string {
  const target =
    inputField(input, "file_path")?.split(/[\\/]/).at(-1) ??
    inputField(input, "command") ??
    inputField(input, "pattern") ??
    inputField(input, "url") ??
    inputField(input, "skill") ??
    inputField(input, "description") ??
    "";
  return clipBubble(target ? `${name} ${target}` : name);
}

/** What an agent is doing after this event; undefined = the event does not change it. */
export function activityFor(event: NexuraEvent): AgentActivity | undefined {
  switch (event.kind) {
    case "thinking":
    case "thinkingTokens":
      return "thinking";
    case "text":
      return "idle";
    case "toolUse":
      if (SUBAGENT_TOOLS.has(event.name)) {
        return "delegating";
      }
      if (READ_TOOLS.has(event.name)) {
        return "reading";
      }
      if (WRITE_TOOLS.has(event.name)) {
        return "typing";
      }
      if (RUN_TOOLS.has(event.name)) {
        return "running";
      }
      return "thinking";
    case "toolResult":
      return event.isError ? "blocked" : "thinking";
    case "result":
      return event.success ? "done" : "failed";
    default:
      return undefined;
  }
}
