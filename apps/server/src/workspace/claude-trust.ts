import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Only folders created by Nexura (`<repo>.worktrees/nexura-<runId>`) are ever touched. */
const NEXURA_WORKTREE = /\.worktrees[\\/]nexura-[\w-]+$/;

/** Per-project keys a worktree inherits from its repo: which `.mcp.json` servers are approved, and local-scope MCP servers. */
const INHERITED_KEYS = ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers", "mcpServers"];

type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> };

export function claudeConfigFile(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

/** Claude Code keys projects by path with forward slashes. */
function projectKey(path: string): string {
  return path.replace(/\\/g, "/");
}

function enabled(): boolean {
  return process.env.NEXURA_TRUST_WORKTREES !== "0";
}

function update(file: string, mutate: (config: ClaudeConfig) => boolean): void {
  if (!existsSync(file)) {
    return;
  }
  // Re-read right before writing and swap atomically: Claude Code rewrites this file too.
  const config = JSON.parse(readFileSync(file, "utf8")) as ClaudeConfig;
  if (!mutate(config)) {
    return;
  }
  const temp = `${file}.nexura-${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2));
  renameSync(temp, file);
}

/**
 * Accepts Claude Code's "do you trust this folder?" dialog for a Nexura worktree, so
 * `claude --resume` in the embedded terminal opens straight away, and copies the MCP
 * approvals and local MCP servers of its repo (`repoPath`), so Claude in the worktree sees
 * the repo's servers. Opt out with NEXURA_TRUST_WORKTREES=0. Never throws: trust is a
 * convenience, not a requirement.
 */
export function trustWorktree(path: string, repoPath?: string, file = claudeConfigFile()): boolean {
  if (!enabled() || !NEXURA_WORKTREE.test(path)) {
    return false;
  }
  try {
    let changed = false;
    update(file, (config) => {
      const key = projectKey(path);
      config.projects ??= {};
      const repoKey = repoPath && Object.keys(config.projects).find((candidate) => candidate.toLowerCase() === projectKey(repoPath).toLowerCase());
      const repo = repoKey ? config.projects[repoKey]! : {};
      const inherited = Object.fromEntries(INHERITED_KEYS.filter((name) => repo[name] !== undefined).map((name) => [name, repo[name]]));
      const next = { ...config.projects[key], ...inherited, hasTrustDialogAccepted: true };
      if (JSON.stringify(next) === JSON.stringify(config.projects[key])) {
        return false;
      }
      config.projects[key] = next;
      changed = true;
      return true;
    });
    return changed;
  } catch {
    return false;
  }
}

/** Removes the entry of a deleted Nexura worktree so ~/.claude.json does not accumulate them. */
export function forgetWorktree(path: string, file = claudeConfigFile()): void {
  if (!NEXURA_WORKTREE.test(path)) {
    return;
  }
  try {
    update(file, (config) => {
      const key = projectKey(path);
      if (!config.projects?.[key]) {
        return false;
      }
      delete config.projects[key];
      return true;
    });
  } catch {
    // Best effort.
  }
}
