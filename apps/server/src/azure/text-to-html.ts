const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (char) => ESCAPES[char]!);

/** `**bold**` and `` `code` `` on already escaped text. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

type OpenList = { indent: number; tag: "ul" | "ol" };

/**
 * The light markdown of a ticket draft (`**Heading:**` paragraphs, nested `-` lists by
 * indentation, `1.` steps) as the HTML Azure DevOps keeps in its rich-text fields. Everything
 * is escaped first: no markup from the text reaches the work item. The reverse of htmlToText.
 */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const lists: OpenList[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  /** Closes the lists nested deeper than `indent` (all of them by default). */
  const closeLists = (indent = -1): void => {
    while (lists.length && lists.at(-1)!.indent > indent) {
      out.push(`</li></${lists.pop()!.tag}>`);
    }
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1]!.length;
      const tag = /\d/.test(item[2]!) ? "ol" : "ul";
      closeLists(indent);
      const top = lists.at(-1);
      if (top?.indent === indent && top.tag === tag) {
        out.push("</li><li>");
      } else {
        if (top?.indent === indent) {
          // Same level, other kind of list: close it and start the new one.
          out.push(`</li></${lists.pop()!.tag}>`);
        }
        // A deeper item opens a list inside the current <li>.
        out.push(`<${tag}><li>`);
        lists.push({ indent, tag });
      }
      out.push(inline(item[3]!));
      continue;
    }
    if (!line.trim()) {
      // A blank line ends a paragraph; a list goes on (numbered steps keep counting).
      flushParagraph();
      continue;
    }
    if (lists.length && /^\s+/.test(line)) {
      out.push(`<br>${inline(line.trim())}`);
      continue;
    }
    closeLists();
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    paragraph.push(heading ? `<b>${inline(heading[1]!)}</b>` : inline(line.trim()));
  }
  flushParagraph();
  closeLists();
  return out.join("");
}
