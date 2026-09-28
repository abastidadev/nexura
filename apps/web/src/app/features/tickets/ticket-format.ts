import type { TicketDraft } from "@nexura/shared";
import type { Tone } from "../../core/format";

/** How a draft shows up in the list and its header. */
export function draftStatus(draft: TicketDraft): { tone: Tone; label: string; live: boolean } {
  switch (draft.status) {
    case "thinking":
      return { tone: "info", label: "Pensando", live: true };
    case "error":
      return { tone: "err", label: "Error", live: false };
    case "created":
      return { tone: "ok", label: "Creado", live: false };
    default:
      return draft.ready ? { tone: "accent", label: "Listo para crear", live: false } : { tone: "muted", label: "Borrador", live: false };
  }
}

/** The draft's name: the first item's title once there is one, else the person's own words. */
export function draftTitle(draft: TicketDraft): string {
  return draft.items[0]?.title.trim() || draft.idea.split(/\r?\n/)[0]!.slice(0, 90);
}
