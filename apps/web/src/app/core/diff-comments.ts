import type { DiffComment } from "@nexura/shared";

/** Longest quote of a selection in the message (the CLI has the file: the quote only points at it). */
const MAX_QUOTE = 120;

/** The comments as one message for the CLI: where (file, lines and the text selected) and what to change. */
export function commentsMessage(comments: (DiffComment & { quote?: string })[], note: string): string {
  const lines = comments.map((comment, index) => {
    const range = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
    const where = `${comment.file}:${range}${comment.side === "old" ? " (líneas borradas, numeración de HEAD)" : ""}`;
    const quote = comment.quote?.replace(/\s+/g, " ").trim();
    const selected = quote ? ` («${quote.length > MAX_QUOTE ? quote.slice(0, MAX_QUOTE - 1) + "…" : quote}»)` : "";
    return `${index + 1}. ${where}${selected}: ${comment.body}`;
  });
  const text = [
    comments.length ? "Revisa estos puntos de los cambios sin commit:" : "",
    ...lines,
    note.trim() ? `${comments.length ? "Además: " : ""}${note.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // Typed into a terminal: no control characters but the line breaks. A file named with an
  // ESC sequence could otherwise end the bracketed paste and send a command on its own.
  return text.replace(/\t/g, " ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}
