const EMPTY = "(nada)";

/** Replaces `{{key}}` / `{{output.step}}` placeholders. Unknown or empty values render as "(nada)". */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value && value.trim().length > 0 ? value : EMPTY;
  });
}

const IN_CONVERSATION = "(ya está en esta conversación)";
export const CONTINUATION_NOTE =
  "Sigues en la misma conversación: ya tienes el ticket, el contexto del repo y lo que hiciste en las fases anteriores. Solo cambia lo que se pide ahora.";

/**
 * The template of a phase that continues a session: sections whose only content is a variable
 * the conversation already holds (`## Ticket\n{{ticket}}`) are dropped, and any other use of one
 * says so instead of repeating it. Everything else, the phase's instructions and the new data
 * (feedback, QA or review results), stays.
 */
export function continuationTemplate(template: string, known: ReadonlySet<string>): string {
  const isKnown = (key: string): boolean => known.has(key);
  const withoutSections = template.replace(/^#{1,6} [^\n]*\n[ \t]*\{\{\s*([\w.]+)\s*\}\}[ \t]*(?:\n+|$)/gm, (section, key: string) =>
    isKnown(key) ? "" : section);
  const inline = withoutSections.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (placeholder, key: string) => (isKnown(key) ? IN_CONVERSATION : placeholder));
  return `${CONTINUATION_NOTE}\n\n${inline.trimEnd()}\n`;
}

export function asJsonBlock(value: unknown): string | undefined {
  return value === undefined ? undefined : "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}
