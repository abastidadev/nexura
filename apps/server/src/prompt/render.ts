const EMPTY = "(nada)";

/** Replaces `{{key}}` / `{{output.step}}` placeholders. Unknown or empty values render as "(nada)". */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value && value.trim().length > 0 ? value : EMPTY;
  });
}

export function asJsonBlock(value: unknown): string | undefined {
  return value === undefined ? undefined : "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}
