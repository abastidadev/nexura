import { signal, type Signal } from "@angular/core";
import type { HLJSApi } from "highlight.js";

const loaded = signal<HLJSApi | undefined>(undefined);
let loading: Promise<void> | undefined;

/**
 * highlight.js with its common languages, loaded on first use (it stays out of the initial
 * bundle). Undefined until it arrives, or forever if it fails: the code then shows as text.
 */
export function syntaxHighlighter(): Signal<HLJSApi | undefined> {
  loading ??= import("highlight.js/lib/common").then(
    (module) => loaded.set(module.default),
    () => undefined,
  );
  return loaded.asReadonly();
}

const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake" };

/** The highlight.js language of a file, by its name or extension; undefined = plain text. */
export function languageOf(hljs: HLJSApi, path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const candidate = BY_NAME[name] ?? (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");
  return candidate && hljs.getLanguage(candidate) ? candidate : undefined;
}

/** One line as highlighted HTML (highlight.js escapes the code). Lines are highlighted alone: a token spanning lines may lose its color. */
export function highlightLine(hljs: HLJSApi, language: string, text: string): string {
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}
