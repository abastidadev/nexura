import type { NexuraEvent, Run } from "@nexura/shared";

const MAX_LINE = 160;

function clip(text: string, max = MAX_LINE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** One-line terminal rendering of an event; undefined for noise. */
export function formatEvent(event: NexuraEvent): string | undefined {
  switch (event.kind) {
    case "init":
      return `  ⚙ ${event.model} · tools: ${event.tools.join(",") || "ninguna"}`;
    case "text":
      return `  💬 ${clip(event.text)}`;
    case "toolUse":
      return `  🔧 ${event.name} ${clip(JSON.stringify(event.input), 120)}`;
    case "toolResult":
      return `  ${event.isError ? "❌" : "↳"} ${clip(event.content, 120)}`;
    case "result":
      return `  ${event.success ? "✅" : "❌"} ${event.subtype} · $${event.costUsd.toFixed(4)} · ${event.numTurns} turnos · ${Math.round(event.durationMs / 1000)} s`;
    case "rateLimit":
      return event.status === "allowed"
        ? undefined
        : `  ⏳ límite de uso: ${event.status} (${event.windowType})`;
    default:
      return undefined;
  }
}

export function formatRunLine(run: Run): string {
  const current = run.steps.at(-1);
  const step = current ? `${current.step}#${current.attempt} ${current.status}` : "-";
  return `${run.id}  ${run.status.padEnd(18)} ${String(run.resolvedProfile ?? run.request.profile).padEnd(9)} $${run.totalCostUsd.toFixed(4)}  ${step}  ${clip(run.request.ticketText, 50)}`;
}
