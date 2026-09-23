import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Worktree } from "@nexura/shared";
import { DATA_DIR } from "../config/paths.ts";
import { git } from "./git.ts";

const MAP_DEPTH = 3;
const MAP_MAX_DIRS = 80;
const MAP_MAX_ROOT_FILES = 25;
export const MAX_NOTES = 40;

const mapCache = new Map<string, string>();

/**
 * Compact map of a checkout built from `git ls-files` (no tokens): root files, directories
 * up to depth 3 with their file counts, and the npm scripts. Cached per HEAD, so every step
 * of every ticket on the same commit reuses it instead of exploring with Glob.
 */
export async function repoMap(worktree: Worktree): Promise<string> {
  const head = await git(worktree.path, ["rev-parse", "HEAD"]);
  const key = `${worktree.repoPath}@${head}`;
  const cached = mapCache.get(key);
  if (cached) {
    return cached;
  }
  const files = (await git(worktree.path, ["ls-files"])).split(/\r?\n/).filter(Boolean);
  const dirs = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length === 1) {
      rootFiles.push(file);
      continue;
    }
    for (let depth = 1; depth <= Math.min(MAP_DEPTH, parts.length - 1); depth++) {
      const dir = parts.slice(0, depth).join("/");
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const dirLines = [...dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAP_MAX_DIRS)
    .map(([dir, count]) => `${"  ".repeat(dir.split("/").length - 1)}${dir.split("/").at(-1)}/ (${count})`);

  let scripts = "";
  const packageFile = join(worktree.path, "package.json");
  if (existsSync(packageFile)) {
    try {
      const names = Object.keys((JSON.parse(readFileSync(packageFile, "utf8")) as { scripts?: object }).scripts ?? {});
      scripts = names.length ? `\nScripts npm: ${names.join(", ")}` : "";
    } catch {
      // Not valid JSON: skip.
    }
  }
  const map = [
    `**${worktree.repo}** (${files.length} ficheros versionados)`,
    `Raíz: ${rootFiles.slice(0, MAP_MAX_ROOT_FILES).join(", ")}${rootFiles.length > MAP_MAX_ROOT_FILES ? ", …" : ""}`,
    "```",
    ...dirLines,
    ...(dirs.size > MAP_MAX_DIRS ? ["…"] : []),
    "```" + scripts,
  ].join("\n");
  mapCache.set(key, map);
  return map;
}

// ---------------------------------------------------------------- learned notes

function notesFile(repo: string, dataDir: string): string {
  if (!/^[\w.-]+$/.test(repo)) {
    throw new Error(`Nombre de repo no válido: ${repo}`);
  }
  return join(dataDir, "repo-notes", `${repo}.md`);
}

export function readRepoNotes(repo: string, dataDir = DATA_DIR): string {
  const file = notesFile(repo, dataDir);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function saveRepoNotes(repo: string, markdown: string, dataDir = DATA_DIR): void {
  const file = notesFile(repo, dataDir);
  mkdirSync(join(dataDir, "repo-notes"), { recursive: true });
  writeFileSync(file, markdown.trim() ? markdown.trim() + "\n" : "");
}

const normalizeNote = (note: string): string => note.toLowerCase().replace(/[`*_.\s]+/g, " ").trim();

/**
 * Adds what enrich learned ("conventions") to the repo's notes: one bullet each, skipping
 * duplicates, keeping the latest MAX_NOTES. Returns how many were new.
 */
export function learnRepoNotes(repo: string, notes: string[], dataDir = DATA_DIR): number {
  const current = readRepoNotes(repo, dataDir)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  const seen = new Set(current.map(normalizeNote));
  const fresh = notes.map((note) => note.trim()).filter((note) => note && !seen.has(normalizeNote(note)));
  if (fresh.length === 0) {
    return 0;
  }
  const merged = [...current, ...fresh].slice(-MAX_NOTES);
  saveRepoNotes(repo, merged.map((note) => `- ${note}`).join("\n"), dataDir);
  return fresh.length;
}
