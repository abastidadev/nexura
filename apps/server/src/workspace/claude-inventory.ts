import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ClaudeConfigSource, ClaudeInventory } from "@nexura/shared";
import { claudeConfigFile } from "./claude-trust.ts";

/** An MCP server as Claude Code's configs write it (`.mcp.json`, `~/.claude.json`, plugins). */
export type McpServerSpec =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

type McpEntry = { name: string; source: ClaudeConfigSource; enabled: boolean; spec: McpServerSpec };

type Json = Record<string, any>;

/** `~/.claude`, or CLAUDE_CONFIG_DIR (which then also holds `.claude.json`). */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function readJson(file: string): Json | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Folders, including links to folders (skills are often symlinked into ~/.claude/skills). */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // Dangling link.
  }
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** `name` and `description` from a Markdown file's YAML front matter (single-line values only). */
export function frontMatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of block?.[1]?.split(/\r?\n/) ?? []) {
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (match) {
      fields[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return fields;
}

/** Claude Code keys `~/.claude.json` projects by path with forward slashes. */
function projectEntry(claudeJson: Json | undefined, repoPath: string): Json {
  const key = resolve(repoPath).replace(/\\/g, "/");
  const projects = (claudeJson?.["projects"] ?? {}) as Record<string, Json>;
  const found = Object.keys(projects).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found ? projects[found]! : {};
}

function asSpec(value: unknown): McpServerSpec | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const server = value as Json;
  if (typeof server["url"] === "string") {
    return { type: server["type"] === "sse" ? "sse" : "http", url: server["url"], ...(server["headers"] ? { headers: server["headers"] } : {}) };
  }
  if (typeof server["command"] === "string") {
    return {
      command: server["command"],
      ...(Array.isArray(server["args"]) ? { args: server["args"].map(String) } : {}),
      ...(server["env"] && typeof server["env"] === "object" ? { env: server["env"] } : {}),
    };
  }
  return undefined;
}

/** `{ mcpServers: {...} }` or a bare `{ name: server }` map (plugins use both). */
function serversOf(config: Json | undefined): Record<string, unknown> {
  if (!config) {
    return {};
  }
  return (config["mcpServers"] && typeof config["mcpServers"] === "object" ? config["mcpServers"] : config) as Record<string, unknown>;
}

/** Replaces `${CLAUDE_PLUGIN_ROOT}` in every string of a plugin's server. */
function withPluginRoot<T>(value: T, root: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll("${CLAUDE_PLUGIN_ROOT}", root.replace(/\\/g, "\\\\"))) as T;
}

type Plugin = { name: string; path: string };

/**
 * Enabled plugins (user < project < local settings) and where each one is installed. A
 * project-scope install of this repo wins over a user-scope one.
 */
function enabledPlugins(repoPath: string, settings: Json[]): Plugin[] {
  const enabled: Record<string, boolean> = {};
  for (const layer of settings) {
    Object.assign(enabled, layer["enabledPlugins"] ?? {});
  }
  const installed = (readJson(join(claudeDir(), "plugins", "installed_plugins.json"))?.["plugins"] ?? {}) as Record<string, Json[]>;
  const repo = resolve(repoPath).toLowerCase();
  const plugins: Plugin[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    const installs = Array.isArray(installed[id]) ? installed[id] : [];
    const install =
      installs.find((candidate) => candidate["scope"] !== "user" && typeof candidate["projectPath"] === "string" && resolve(candidate["projectPath"]).toLowerCase() === repo) ??
      installs.find((candidate) => candidate["scope"] === "user") ??
      installs[0];
    if (on === true && typeof install?.["installPath"] === "string" && existsSync(install["installPath"])) {
      plugins.push({ name: id.split("@")[0]!, path: install["installPath"] });
    }
  }
  return plugins;
}

function pluginServers(plugin: Plugin): Record<string, unknown> {
  const manifest = readJson(join(plugin.path, ".claude-plugin", "plugin.json"));
  const declared = manifest?.["mcpServers"];
  const config =
    typeof declared === "string"
      ? readJson(join(plugin.path, declared))
      : declared && typeof declared === "object"
        ? { mcpServers: declared }
        : readJson(join(plugin.path, ".mcp.json"));
  return withPluginRoot(serversOf(config), plugin.path);
}

/** Everything read once per call: the repo's and the user's Claude config. */
function load(repoPath: string) {
  const dir = claudeDir();
  const claudeJson = readJson(claudeConfigFile());
  const project = projectEntry(claudeJson, repoPath);
  const settings = [
    readJson(join(dir, "settings.json")) ?? {},
    readJson(join(repoPath, ".claude", "settings.json")) ?? {},
    readJson(join(repoPath, ".claude", "settings.local.json")) ?? {},
  ];
  return { dir, claudeJson, project, settings, plugins: enabledPlugins(repoPath, settings) };
}

/** Every MCP server the repo's Claude config declares, in Claude Code's precedence order. */
function mcpEntries(repoPath: string, loaded = load(repoPath)): McpEntry[] {
  const { claudeJson, project, settings, plugins } = loaded;
  // `.mcp.json` servers need approval, from any settings layer or from ~/.claude.json.
  const approvals = [...settings, project];
  const approveAll = approvals.some((layer) => layer["enableAllProjectMcpServers"] === true);
  const approved = new Set(approvals.flatMap((layer) => (Array.isArray(layer["enabledMcpjsonServers"]) ? layer["enabledMcpjsonServers"] : [])));
  const rejected = new Set(approvals.flatMap((layer) => (Array.isArray(layer["disabledMcpjsonServers"]) ? layer["disabledMcpjsonServers"] : [])));

  const entries: McpEntry[] = [];
  const add = (source: ClaudeConfigSource, servers: Record<string, unknown>, enabled: (name: string) => boolean) => {
    for (const [name, value] of Object.entries(servers)) {
      const spec = asSpec(value);
      if (spec) {
        entries.push({ name, source, enabled: enabled(name), spec });
      }
    }
  };
  add("local", serversOf({ mcpServers: project["mcpServers"] ?? {} }), () => true);
  add("project", serversOf(readJson(join(repoPath, ".mcp.json"))), (name) => !rejected.has(name) && (approveAll || approved.has(name)));
  add("user", serversOf({ mcpServers: claudeJson?.["mcpServers"] ?? {} }), () => true);
  for (const plugin of plugins) {
    add(`plugin:${plugin.name}`, pluginServers(plugin), () => true);
  }
  return entries;
}

/**
 * What `claude` opened in the repo would find: skills, subagents and MCP servers, with
 * where each one comes from. Reads files only (no CLI call, no tokens); anything missing
 * or unreadable is skipped.
 */
export function claudeInventory(repoPath: string): ClaudeInventory {
  const loaded = load(repoPath);
  const skills: ClaudeInventory["skills"] = [];
  const agents: ClaudeInventory["agents"] = [];
  const collect = (source: ClaudeConfigSource, root: string, prefix = "") => {
    for (const folder of subdirs(join(root, "skills"))) {
      const file = join(root, "skills", folder, "SKILL.md");
      if (existsSync(file)) {
        const meta = frontMatter(file);
        skills.push({ name: prefix + (meta.name || folder), description: meta.description ?? "", source });
      }
    }
    for (const file of markdownFiles(join(root, "agents"))) {
      const meta = frontMatter(join(root, "agents", file));
      agents.push({ name: prefix + (meta.name || basename(file, ".md")), description: meta.description ?? "", source });
    }
  };
  collect("project", join(repoPath, ".claude"));
  collect("user", loaded.dir);
  for (const plugin of loaded.plugins) {
    collect(`plugin:${plugin.name}`, plugin.path, `${plugin.name}:`);
  }
  const mcpServers = mcpEntries(repoPath, loaded).map(({ name, source, enabled, spec }) => ({
    name,
    source,
    transport: spec.type === "http" || spec.type === "sse" ? spec.type : ("stdio" as const),
    enabled,
  }));
  return { skills, agents, mcpServers };
}

/**
 * The servers a step asked for (`"*"` = every enabled one), resolved against the repo's
 * Claude config with its precedence (a name declared twice keeps the first). Names in
 * `exclude` (servers Nexura manages itself) are never taken from the repo, nor names with
 * characters other than letters, digits, `_` and `-`.
 */
export function resolveMcpServers(repoPath: string, names: string[], exclude: string[] = []): { servers: Record<string, McpServerSpec>; missing: string[] } {
  if (names.length === 0) {
    return { servers: {}, missing: [] };
  }
  // The name becomes `mcp__<name>` in a comma-separated --allowedTools and a TOML key for Codex.
  const entries = mcpEntries(repoPath).filter((entry) => !exclude.includes(entry.name) && /^[\w-]+$/.test(entry.name));
  const servers: Record<string, McpServerSpec> = {};
  const take = (entry: McpEntry | undefined) => {
    if (entry && !servers[entry.name]) {
      servers[entry.name] = entry.spec;
    }
  };
  if (names.includes("*")) {
    for (const entry of entries.filter((candidate) => candidate.enabled)) {
      take(entry);
    }
  }
  const missing: string[] = [];
  for (const name of names.filter((candidate) => candidate !== "*" && !exclude.includes(candidate))) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry) {
      take(entry);
    } else {
      missing.push(name);
    }
  }
  return { servers, missing };
}
