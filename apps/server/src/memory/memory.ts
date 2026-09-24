import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryMode } from "@nexura/shared";
import { CONFIG_DIR, MEMORY_DB_FILE } from "../config/paths.ts";
import type { ClaudeRunOptions } from "../runner/claude-args.ts";
import { formatList } from "./mcp-server.ts";
import { MemoryStore } from "./memory-store.ts";

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
const RECENT = 5;

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
 * `{{memory}}`: what the memory has about the ticket (full-text search on its title) and
 * the latest of the repo, without repeating an observation. Read once per run: no turns
 * are spent on it. Empty when the project has nothing.
 */
export function readMemory(store: MemoryStore, project: string, query: string): string {
  const related = store.search(project, query, RELATED);
  const recent = store.recent(project, RECENT + related.length).filter((o) => !related.some((r) => r.id === o.id)).slice(0, RECENT);
  const text = [
    related.length ? `### Relacionado con este ticket\n${formatList(related, "")}` : "",
    recent.length ? `### Reciente en el repo\n${formatList(recent, "")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_MEMORY_CHARS ? text.slice(0, MAX_MEMORY_CHARS) + "\n…" : text;
}

const toolsFor = (mode: MemoryMode): string[] => (mode === "readwrite" ? [...READ_TOOLS, ...WRITE_TOOLS] : mode === "read" ? READ_TOOLS : []);

export type MemoryStepContext = { project: string; step: string; runId: string; allowedTools: string[] };

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
  const args = ["--no-warnings", MCP_SERVER_FILE, "--db", dbFile, "--mode", mode, "--project", context.project, "--source", context.step, "--run", context.runId];
  return {
    mcpConfig: { mcpServers: { [MEMORY_SERVER]: { command: process.execPath, args } } },
    allowedTools: [...context.allowedTools, ...tools.map((tool) => `mcp__${MEMORY_SERVER}__${tool}`)],
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
