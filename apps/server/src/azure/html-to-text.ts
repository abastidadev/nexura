const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Work item rich text (HTML) to compact Markdown-ish text for prompts: lists become
 * "- ", headings/paragraphs become lines, images and styles are dropped. Fewer tokens
 * than raw HTML and easier to read in the UI.
 */
export function htmlToText(html: string | undefined): string {
  if (!html) {
    return "";
  }
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*>/gi, "[imagen]")
    .replace(/<br\s*\/?>/gi, "\n")
    // Numbered lists keep their numbers; the other items become "- ".
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_list, items: string) => {
      let n = 0;
      return `${items.replace(/<li[^>]*>/gi, () => `\n${++n}. `)}\n\n`;
    })
    // A blank line after a list, or Markdown reads the next line as part of its last item.
    .replace(/<\/ul>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table)>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n## ")
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (entity, code: string) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number(code.slice(1)));
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
