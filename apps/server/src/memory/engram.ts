import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MemoryMode, MemoryStatus, NexuraSettings } from "@nexura/shared";
import { CONFIG_DIR } from "../config/paths.ts";
import type { ClaudeRunOptions } from "../runner/claude-args.ts";

/**
 * Shared memory through engram (github.com/Gentleman-Programming/engram): one SQLite + FTS5
 * store per machine that the interactive Claude Code (engram plugin) and the Nexura steps
 * both read and write. engram names the project after the git remote of the cwd, so running
 * it inside a worktree lands in the same project as the user's own sessions on that repo.
 *
 * Nexura reads and saves through the CLI (no tokens); the steps get engram's MCP server
 * with only the tools their mode allows.
 */

const exec = promisify(execFile);
const TIMEOUT_MS = 15_000;
const MAX_MEMORY_CHARS = 6000;
const SEARCH_LIMIT = 5;

export const ENGRAM_SERVER = "engram";
const READ_TOOLS = ["mem_context", "mem_search", "mem_get_observation"];
const WRITE_TOOLS = ["mem_save", "mem_update", "mem_suggest_topic_key"];

export type EngramCommand = { command: string; prefixArgs: string[] };

const resolved = new Map<string, EngramCommand | undefined>();

/**
 * NEXURA_ENGRAM_BIN (tests: a .mjs run with node) > the path in the settings > PATH.
 * Cached per configured value: the PATH lookup spawns where/which.
 */
export async function resolveEngram(configured: string): Promise<EngramCommand | undefined> {
  const override = process.env.NEXURA_ENGRAM_BIN ?? configured.trim();
  if (override && /\.m?js$/.test(override)) {
    return { command: process.execPath, prefixArgs: [override] };
  }
  if (override) {
    return existsSync(override) ? { command: override, prefixArgs: [] } : undefined;
  }
  if (!resolved.has("")) {
    try {
      const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", ["engram"], { windowsHide: true });
      const bin = stdout.split(/\r?\n/)[0]!.trim();
      resolved.set("", bin ? { command: bin, prefixArgs: [] } : undefined);
    } catch {
      resolved.set("", undefined);
    }
  }
  return resolved.get("");
}

/** Forgets the PATH lookup, so installing engram does not need a restart. */
export function forgetEngramLookup(): void {
  resolved.clear();
}

async function engram(bin: EngramCommand, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(bin.command, [...bin.prefixArgs, ...args], { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** The engram to use now, or undefined when memory is off or engram is not installed. */
export async function activeEngram(settings: NexuraSettings): Promise<EngramCommand | undefined> {
  return settings.memoryEnabled ? resolveEngram(settings.engramBin) : undefined;
}

export async function memoryStatus(settings: NexuraSettings): Promise<MemoryStatus> {
  forgetEngramLookup();
  const bin = await resolveEngram(settings.engramBin);
  if (!bin) {
    return {
      enabled: settings.memoryEnabled,
      available: false,
      error: settings.engramBin.trim() ? `No existe ${settings.engramBin}` : "engram no está en el PATH",
    };
  }
  try {
    const version = await engram(bin, process.cwd(), ["version"]);
    return { enabled: settings.memoryEnabled, available: true, bin: bin.prefixArgs[0] ?? bin.command, version };
  } catch (error) {
    return { enabled: settings.memoryEnabled, available: false, bin: bin.command, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `{{memory}}`: what engram knows about the ticket (search on its title) and the latest
 * observations of the repo. Read once per run through the CLI, so the steps start with it
 * without spending turns on MCP calls. Empty when there is nothing (or engram fails).
 */
export async function readMemory(bin: EngramCommand, cwd: string, query: string): Promise<string> {
  const [related, recent] = await Promise.all([
    query.trim()
      ? engram(bin, cwd, ["search", query, "--match", "any", "--limit", String(SEARCH_LIMIT)]).catch(() => "")
      : Promise.resolve(""),
    engram(bin, cwd, ["context"]).catch(() => ""),
  ]);
  const sections = [
    related && !related.startsWith("No memories found") ? `### Relacionado con este ticket\n${related}` : "",
    recent && !recent.startsWith("No previous session memories") ? `### Reciente en el repo\n${recent.replace(/^## .*\n+/, "")}` : "",
  ].filter(Boolean);
  const text = sections.join("\n\n");
  return text.length > MAX_MEMORY_CHARS ? text.slice(0, MAX_MEMORY_CHARS) + "\n…" : text;
}

export type MemoryEntry = { title: string; content: string; type: string; topic?: string };

/** Saves (or, with the same topic, updates) an observation in the project of `cwd`. */
export async function saveMemory(bin: EngramCommand, cwd: string, entry: MemoryEntry): Promise<boolean> {
  const args = ["save", "--type", entry.type, ...(entry.topic ? ["--topic", entry.topic] : []), "--", entry.title, entry.content];
  try {
    await engram(bin, cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** For the Memoria screen: engram's own text output, searched from the repo checkout. */
export async function searchMemory(bin: EngramCommand, cwd: string, query: string): Promise<string> {
  return query.trim() ? engram(bin, cwd, ["search", query, "--match", "any", "--limit", "20"]) : engram(bin, cwd, ["context"]);
}

const toolsFor = (mode: MemoryMode): string[] => (mode === "readwrite" ? [...READ_TOOLS, ...WRITE_TOOLS] : mode === "read" ? READ_TOOLS : []);

/**
 * What a step with memory adds to its claude options: engram's MCP server exposing only
 * the tools of its mode (fewer tool schemas = fewer tokens), those tools pre-approved
 * (with `dontAsk` anything else fails), and the memory protocol as system prompt.
 */
export function memoryRunOptions(
  bin: EngramCommand,
  mode: MemoryMode,
  allowedTools: string[],
  configDir = CONFIG_DIR,
): Pick<ClaudeRunOptions, "mcpConfig" | "allowedTools" | "appendSystemPrompt"> | undefined {
  const tools = toolsFor(mode);
  if (tools.length === 0) {
    return undefined;
  }
  return {
    mcpConfig: { mcpServers: { [ENGRAM_SERVER]: { command: bin.command, args: [...bin.prefixArgs, "mcp", `--tools=${tools.join(",")}`] } } },
    allowedTools: [...allowedTools, ...tools.map((tool) => `mcp__${ENGRAM_SERVER}__${tool}`)],
    appendSystemPrompt: memoryProtocol(mode, configDir),
  };
}

/** config/memory/read.md, plus write.md for `readwrite`. */
export function memoryProtocol(mode: MemoryMode, configDir = CONFIG_DIR): string {
  const files = mode === "readwrite" ? ["read.md", "write.md"] : mode === "read" ? ["read.md"] : [];
  return files
    .map((file) => join(configDir, "memory", file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").trim())
    .join("\n\n");
}

/** Whether a tool call of a step saves an observation (to report how many it saved). */
export function isMemoryWrite(toolName: string): boolean {
  return toolName === `mcp__${ENGRAM_SERVER}__mem_save` || toolName === `mcp__${ENGRAM_SERVER}__mem_update`;
}
