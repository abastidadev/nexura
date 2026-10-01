import type { AiSetupPriority, AiSetupSession } from "@nexura/shared";
import type { Tone } from "../../core/format";

/** How a session shows up in the list and its header. */
export function setupStatus(session: AiSetupSession): { tone: Tone; label: string; live: boolean } {
  switch (session.status) {
    case "thinking":
      return { tone: "info", label: "Pensando", live: true };
    case "error":
      return { tone: "err", label: "Error", live: false };
    case "applied":
      return { tone: "ok", label: "Escrito", live: false };
    default:
      if (session.mode === "assess") {
        return { tone: "accent", label: "Valorado", live: false };
      }
      return session.ready ? { tone: "accent", label: "Listo para escribir", live: false } : { tone: "muted", label: "Borrador", live: false };
  }
}

/** The session's name: what the person asked for, or the first file once there is one. */
export function setupTitle(session: AiSetupSession): string {
  if (session.mode === "assess") {
    return `Valoración de ${session.repo}`;
  }
  return session.idea.split(/\r?\n/)[0]!.slice(0, 90) || session.files[0]?.path || "Nueva pieza";
}

export const PRIORITY_LABELS: Record<AiSetupPriority, string> = { high: "Alta", medium: "Media", low: "Baja" };

export const PRIORITY_CLASSES: Record<AiSetupPriority, string> = {
  high: "bg-err-soft text-err",
  medium: "bg-warn-soft text-warn",
  low: "bg-surface-3 text-fg-soft",
};
