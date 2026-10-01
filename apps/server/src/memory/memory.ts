import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryMode } from "@nexura/shared";
import { CONFIG_DIR, MEMORY_DB_FILE } from "../config/paths.ts";
import type { ClaudeRunOptions } from "../runner/claude-args.ts";
import { formatList } from "./mcp-server.ts";
import { MemoryStore, type MemoryObservation } from "./memory-store.ts";

/**
 * Nexura's side of the shared memory: the store it writes to without tokens, `{{memory}}`
 * for the prompts, and what a step with memory adds to its `claude` options (the memory
 * MCP server with only the tools of its mode, pre-approved, and the memory protocol).
 */

export const MEMORY_SERVER = "nexura-memory";
const MCP_SERVER_FILE = join(import.meta.dirname, "mcp-server.ts");
const READ_TOOLS = ["mem_search", "mem_get", "mem_context"];
const WRITE_TOOLS = ["mem_save"];
const MAX_MEMORY_CHARS = 6000;
const RELATED = 5;

let shared: MemoryStore | undefined;

/** The memory database of this Nexura (data/memory.sqlite), opened once per process. */
export function memoryStore(): MemoryStore {
  shared ??= new MemoryStore(MEMORY_DB_FILE);
  return shared;
}

/** Closes it (tests: Windows cannot delete an open database file). */
export function closeMemoryStore(): void {
  shared?.close();
  shared = undefined;
}

/**
 * `{{memory}}`: what the memory has about the ticket (full-text search on its title), about
 * the files the step works on (observations linked to those files or their folders) and
 * relevant to the current step. Unrelated recent observations stay available through
 * mem_context, but are not injected into every prompt. No agent turns are spent here.
 */
export function readMemory(
  store: MemoryStore,
  project: string,
  query: string | string[],
  maxChars = MAX_MEMORY_CHARS,
  excludeTopic?: string,
  files: readonly string[] = [],
): string {
  const visible = (items: MemoryObservation[]): MemoryObservation[] => items.filter((item) => !excludeTopic || item.topicKey !== excludeTopic).slice(0, RELATED);
  const fetch = excludeTopic ? RELATED * 3 : RELATED;
  const groups = [
    visible(store.byFiles(project, files, fetch)),
    ...(Array.isArray(query) ? query : [query]).map((text) => visible(store.search(project, text, fetch))),
  ];
  // Interleave ranked results so a broad step query cannot crowd out the ticket query.
  const matches = Array.from({ length: RELATED }, (_, rank) => groups.flatMap((group) => group[rank] ? [group[rank]!] : [])).flat();
  const related = [...new Map(matches.map((observation) => [observation.id, observation])).values()].slice(0, RELATED);
  const text = [
    related.length ? `### Relacionado con este ticket\n${formatList(related, "")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const limit = Math.min(MAX_MEMORY_CHARS, Math.max(2, maxChars));
  return text.length > limit ? text.slice(0, limit - 2) + "\n…" : text;
}

const toolsFor = (mode: MemoryMode): string[] => (mode === "readwrite" ? [...READ_TOOLS, ...WRITE_TOOLS] : mode === "read" ? READ_TOOLS : []);

export type MemoryStepContext = {
  project: string;
  step: string;
  runId: string;
  allowedTools: string[];
  excludeTopic?: string;
  /**
   * Pre-approve only this mode's tools while the server exposes those of `mode`: a phase of
   * a shared session keeps the session's tool schemas (its prompt cache) but not its rights.
   */
  permitMode?: MemoryMode;
};

/**
 * What a step with memory adds to its claude options: the memory MCP server bound to the
 * run's project and exposing only the tools of its mode (fewer tool schemas = fewer
 * tokens), those tools pre-approved (with `dontAsk` anything else fails), and the memory
 * protocol as system prompt. Undefined for `off`.
 */
export function memoryRunOptions(
  mode: MemoryMode,
  context: MemoryStepContext,
  dbFile = MEMORY_DB_FILE,
  configDir = CONFIG_DIR,
): Pick<ClaudeRunOptions, "mcpConfig" | "allowedTools" | "appendSystemPrompt"> | undefined {
  const tools = toolsFor(mode);
  if (tools.length === 0) {
    return undefined;
  }
  const args = ["--no-warnings", MCP_SERVER_FILE, "--db", dbFile, "--mode", mode, "--project", context.project, "--source", context.step, "--run", context.runId,
    ...(context.excludeTopic ? ["--exclude-topic", context.excludeTopic] : [])];
  return {
    mcpConfig: { mcpServers: { [MEMORY_SERVER]: { command: process.execPath, args } } },
    allowedTools: [...context.allowedTools, ...toolsFor(context.permitMode ?? mode).filter((tool) => tools.includes(tool)).map((tool) => `mcp__${MEMORY_SERVER}__${tool}`)],
    appendSystemPrompt: memoryProtocol(mode, configDir),
  };
}

/** config/memory/read.md, plus write.md for `readwrite`. */
export function memoryProtocol(mode: MemoryMode, configDir = CONFIG_DIR): string {
  const files = mode === "readwrite" ? ["read.md", "write.md"] : mode === "read" ? ["read.md"] : [];
  return files
    .map((file) => join(configDir, "memory", file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim())
    .join("\n\n");
}

/** Whether a tool call of a step saves to the memory (to report how many it saved). */
export function isMemoryWrite(toolName: string): boolean {
  return toolName === `mcp__${MEMORY_SERVER}__mem_save`;
}

/** To give the interactive Claude Code the same memory (shown in Configuración > Memoria). */
export function mcpAddCommand(dbFile = MEMORY_DB_FILE): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  return `claude mcp add --scope user ${MEMORY_SERVER} -- node --no-warnings ${quote(MCP_SERVER_FILE)} --db ${quote(dbFile)}`;
}
